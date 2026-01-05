const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ MEXC_BASE: Cloudflare Worker 프록시(권장) 또는 기본값
// 예) https://mexc-proxy.pch1211.workers.dev
const RAW_BASE = process.env.MEXC_BASE || "https://contract.mexc.com";
const MEXC_BASE = String(RAW_BASE).replace(/\/+$/, ""); // 뒤 / 제거

// ====== Static (public) ======
app.use(express.static(path.join(__dirname, "public")));

// ====== Cache ======
const cache = new Map();
function getCache(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() > v.exp) { cache.delete(key); return null; }
  return v.data;
}
function setCache(key, data, ttlMs) {
  cache.set(key, { data, exp: Date.now() + ttlMs });
}

// ====== Helpers ======
function mexcContractSymbol(sym) {
  const s = String(sym || "").trim().toUpperCase();
  if (!s) return "";
  if (s.includes("_")) return s;
  if (s.endsWith("USDT")) return s.replace(/USDT$/, "_USDT"); // BTCUSDT -> BTC_USDT
  return s;
}

function toNumOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

function pickNum(obj, keys) {
  for (const k of keys) {
    const n = toNumOrNull(obj?.[k]);
    if (n !== null) return n;
  }
  return null;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "mexc-coin-dashboard" } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch {
    // HTML(Access Denied) 같은게 오면 여기로 들어옴
    throw new Error("JSON parse fail");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return json;
}

// ====== RSI (Wilder) ======
function calcRSI_Wilder(closes, period) {
  if (!Array.isArray(closes) || closes.length < period + 2) return null;

  let gains = 0, losses = 0;
  // 초기 평균
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += -diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ====== Kline closes (15분봉 고정) ======
async function fetchCloses15m(sym) {
  const msym = mexcContractSymbol(sym);
  const key = `kline15:${msym}`;
  const cached = getCache(key);
  if (cached) return cached;

  // 15분봉: RSI(24) + MA30 계산용 충분히 확보 (약 7일치)
  const endMs = Date.now();
  const startMs = endMs - 7 * 24 * 60 * 60 * 1000;

  const url = `${MEXC_BASE}/api/v1/contract/kline/${encodeURIComponent(msym)}?interval=Min15&start=${startMs}&end=${endMs}`;
  const json = await fetchJson(url);
  if (!json?.success || !json.data?.close) throw new Error("kline fail");

  const closes = json.data.close.map(Number).filter(v => Number.isFinite(v));
  if (closes.length < 60) throw new Error("not enough candles");

  setCache(key, closes, 60 * 1000); // ✅ 60초 캐시(지표는 초단위로 바뀌지 않음)
  return closes;
}

// ====== MEXC Futures Ticker (USDT-M) ======
async function fetchTicker(sym) {
  const msym = mexcContractSymbol(sym);
  const key = `ticker:${msym}`;
  const cached = getCache(key);
  if (cached) return cached;

  const url = `${MEXC_BASE}/api/v1/contract/ticker?symbol=${encodeURIComponent(msym)}`;
  const json = await fetchJson(url);
  if (!json?.success || !json.data) throw new Error("ticker fail");

  const d = json.data;

  const last = toNumOrNull(d.lastPrice);
  const fair = toNumOrNull(d.fairPrice ?? d.fair_price ?? last);
  const index = toNumOrNull(d.indexPrice ?? d.index_price);

  // ✅ 24h High/Low 필드가 환경/응답에 따라 이름이 다를 수 있어서 여러 후보에서 pick
  const high24 = pickNum(d, ["high24Price", "high24", "highPrice", "high_price", "high"]);
  const low24  = pickNum(d, ["low24Price", "low24", "lowPrice", "low_price", "low"]);

  if (!Number.isFinite(fair)) throw new Error("fair invalid");

  const out = {
    symbol: msym,
    last: Number.isFinite(last) ? last : null,
    fair,
    index: Number.isFinite(index) ? index : null,
    high24: Number.isFinite(high24) ? high24 : null,
    low24: Number.isFinite(low24) ? low24 : null,
    ts: Date.now()
  };

  setCache(key, out, 2000); // 2초 캐시(현재가)
  return out;
}

// ====== MA30 + RSI(6/12/24) (15분봉 기준) ======
async function fetchIndicators15m(sym) {
  const msym = mexcContractSymbol(sym);
  const key = `ind15:${msym}`;
  const cached = getCache(key);
  if (cached) return cached;

  const closes = await fetchCloses15m(msym);

  const last30 = closes.slice(-30);
  const ma30 = last30.reduce((a, b) => a + b, 0) / 30;

  const rsi6 = calcRSI_Wilder(closes, 6);
  const rsi12 = calcRSI_Wilder(closes, 12);
  const rsi24 = calcRSI_Wilder(closes, 24);

  const out = {
    symbol: msym,
    ma30,
    rsi6,
    rsi12,
    rsi24,
    ts: Date.now()
  };

  setCache(key, out, 60 * 1000); // 60초 캐시
  return out;
}

// ====== API ======
app.get("/api/health", (req, res) => res.json({ ok: true, base: MEXC_BASE }));

// 단일: /api/quote?symbol=BTCUSDT
app.get("/api/quote", async (req, res) => {
  try {
    const sym = String(req.query.symbol || "BTCUSDT");
    const t = await fetchTicker(sym);
    const ind = await fetchIndicators15m(sym);

    res.json({
      symbol: t.symbol,
      fair: t.fair,
      last: t.last,
      index: t.index,
      high24: t.high24,
      low24: t.low24,
      ma30: ind.ma30,
      rsi6: ind.rsi6,
      rsi12: ind.rsi12,
      rsi24: ind.rsi24,
      ma30_ts: ind.ts,
      rsi_ts: ind.ts,
      price_ts: t.ts
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// 배치: /api/quote_batch?symbols=BTCUSDT,ETHUSDT,COREUSDT
app.get("/api/quote_batch", async (req, res) => {
  try {
    const symbols = String(req.query.symbols || "BTCUSDT")
      .split(",").map(s => s.trim()).filter(Boolean);

    const results = [];
    for (const sym of symbols) {
      try {
        const t = await fetchTicker(sym);
        const ind = await fetchIndicators15m(sym);

        results.push({
          symbol: t.symbol,
          fair: t.fair,
          last: t.last,
          index: t.index,
          high24: t.high24,
          low24: t.low24,
          ma30: ind.ma30,
          rsi6: ind.rsi6,
          rsi12: ind.rsi12,
          rsi24: ind.rsi24,
          ma30_ts: ind.ts,
          rsi_ts: ind.ts,
          price_ts: t.ts
        });
      } catch (e) {
        results.push({ symbol: mexcContractSymbol(sym), error: String(e?.message || e) });
      }
    }

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log("✅ Server running on port", PORT, "base=", MEXC_BASE));
