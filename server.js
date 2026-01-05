const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Cloudflare Worker 프록시를 쓰면 여기로 설정
// Render 환경변수: MEXC_BASE = https://mexc-proxy.pch1211.workers.dev
const RAW_BASE = process.env.MEXC_BASE || "https://contract.mexc.com";
const MEXC_BASE = String(RAW_BASE).replace(/\/+$/, "");

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
  if (s.endsWith("USDT")) return s.replace(/USDT$/, "_USDT");
  return s;
}

function toNumOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "mexc-coin-dashboard" } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error("JSON parse fail"); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return json;
}

// ====== 24h High/Low fallback by kline (Min15, last ~26h) ======
async function fetchHighLow24ByKline15m(sym) {
  const msym = mexcContractSymbol(sym);
  const key = `hl24_15m:${msym}`;
  const cached = getCache(key);
  if (cached) return cached;

  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = nowSec - 26 * 60 * 60; // 26시간(여유)
  const url = `${MEXC_BASE}/api/v1/contract/kline/${encodeURIComponent(msym)}?interval=Min15&start=${startSec}&end=${nowSec}`;
  const json = await fetchJson(url);

  if (!json?.success || !json.data) throw new Error("kline fail");
  const d = json.data;

  // MEXC kline은 high/low 배열이 오는 경우가 많음
  const highs = Array.isArray(d.high) ? d.high.map(Number).filter(Number.isFinite) : [];
  const lows  = Array.isArray(d.low)  ? d.low.map(Number).filter(Number.isFinite)  : [];

  // 없으면 close로라도 계산
  const closes = Array.isArray(d.close) ? d.close.map(Number).filter(Number.isFinite) : [];

  const hiArr = highs.length ? highs : closes;
  const loArr = lows.length ? lows : closes;

  if (hiArr.length < 10 || loArr.length < 10) throw new Error("not enough candles");

  const high24 = Math.max(...hiArr);
  const low24  = Math.min(...loArr);

  const out = { high24, low24, ts: Date.now() };
  setCache(key, out, 60 * 1000); // 60초 캐시
  return out;
}

// ====== Ticker ======
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

  // ticker에서 24h high/low가 오는 경우가 있는데, 키가 제각각이라 넓게 시도
  const highFromTicker =
    toNumOrNull(d.high24Price) ?? toNumOrNull(d.high24) ?? toNumOrNull(d.highPrice) ?? toNumOrNull(d.high);
  const lowFromTicker =
    toNumOrNull(d.low24Price) ?? toNumOrNull(d.low24) ?? toNumOrNull(d.lowPrice) ?? toNumOrNull(d.low);

  if (!Number.isFinite(fair)) throw new Error("fair invalid");

  // ✅ ticker low/high가 없거나 0이면 kline으로 계산해서 채움 (확실)
  let high24 = highFromTicker;
  let low24 = lowFromTicker;

  if (!(Number.isFinite(high24) && high24 > 0) || !(Number.isFinite(low24) && low24 > 0)) {
    try {
      const hl = await fetchHighLow24ByKline15m(msym);
      if (!(Number.isFinite(high24) && high24 > 0)) high24 = hl.high24;
      if (!(Number.isFinite(low24) && low24 > 0)) low24 = hl.low24;
    } catch (e) {
      // fallback 실패 시 null 유지
    }
  }

  const out = {
    symbol: msym,
    last: Number.isFinite(last) ? last : null,
    fair,
    index: Number.isFinite(index) ? index : null,
    high24: Number.isFinite(high24) ? high24 : null,
    low24: Number.isFinite(low24) ? low24 : null,
    ts: Date.now()
  };

  setCache(key, out, 2000); // 2초 캐시
  return out;
}

// ====== RSI (Wilder) ======
function calcRSI_Wilder(closes, period) {
  if (!Array.isArray(closes) || closes.length < period + 2) return null;

  let gains = 0, losses = 0;
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

// ====== Kline closes (15분봉) ======
async function fetchCloses15m(sym) {
  const msym = mexcContractSymbol(sym);
  const key = `kline15:${msym}`;
  const cached = getCache(key);
  if (cached) return cached;

  async function loadWindow(days) {
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = nowSec - days * 24 * 60 * 60;
    const url = `${MEXC_BASE}/api/v1/contract/kline/${encodeURIComponent(msym)}?interval=Min15&start=${startSec}&end=${nowSec}`;
    const json = await fetchJson(url);
    if (!json?.success || !json.data?.close) throw new Error("kline fail");
    return json.data.close.map(Number).filter(Number.isFinite);
  }

  let closes = await loadWindow(10);
  if (closes.length < 60) closes = await loadWindow(30);
  if (closes.length < 60) throw new Error("not enough candles");

  setCache(key, closes, 60 * 1000); // 60초 캐시
  return closes;
}

// ====== MA30 + RSI(6/12/24) ======
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

  const out = { symbol: msym, ma30, rsi6, rsi12, rsi24, ts: Date.now() };
  setCache(key, out, 60 * 1000); // 60초 캐시
  return out;
}

// ====== API ======
app.get("/api/health", (req, res) => res.json({ ok: true, base: MEXC_BASE }));

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
