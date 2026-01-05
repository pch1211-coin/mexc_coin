const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Cloudflare Worker 프록시
// 예) https://mexc-proxy.pch1211.workers.dev
const MEXC_BASE = (process.env.MEXC_BASE || "https://contract.mexc.com").replace(/\/+$/,"");

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

// tf(분) -> MEXC interval
function tfToInterval(tfMin) {
  const n = Number(tfMin);
  if (n === 5) return "Min5";
  if (n === 10) return "Min10";
  if (n === 15) return "Min15";
  if (n === 30) return "Min30";
  return "Min15";
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "mexc-dashboard" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0,120)}`);
  return text;
}

async function fetchJson(url) {
  const text = await fetchText(url);
  try { return JSON.parse(text); }
  catch { throw new Error("JSON parse fail"); }
}

// ====== MEXC Ticker ======
async function fetchTicker(sym) {
  const msym = mexcContractSymbol(sym);
  const key = `ticker:${msym}`;
  const cached = getCache(key);
  if (cached) return cached;

  const url = `${MEXC_BASE}/api/v1/contract/ticker?symbol=${encodeURIComponent(msym)}`;
  const json = await fetchJson(url);
  if (!json?.success || !json.data) throw new Error("ticker fail");

  const last = Number(json.data.lastPrice);
  const fair = Number(json.data.fairPrice ?? json.data.fair_price ?? last);
  const index = Number(json.data.indexPrice ?? json.data.index_price ?? NaN);

  if (!Number.isFinite(fair)) throw new Error("fair invalid");

  const out = {
    symbol: msym,
    last,
    fair,
    index: Number.isFinite(index) ? index : null,
    ts: Date.now()
  };
  setCache(key, out, 2000); // 2초 캐시
  return out;
}

// ====== Kline closes ======
async function fetchCloses(sym, tfMin, need) {
  const msym = mexcContractSymbol(sym);
  const interval = tfToInterval(tfMin);

  // ✅ RSI 안정화 위해 넉넉히 가져오기
  const want = Math.max(need + 200, 260);

  const nowSec = Math.floor(Date.now() / 1000);
  const secPer = Number(tfMin) * 60;
  const startSec = nowSec - want * secPer;

  const url = `${MEXC_BASE}/api/v1/contract/kline/${encodeURIComponent(msym)}?interval=${interval}&start=${startSec}&end=${nowSec}`;
  const json = await fetchJson(url);

  if (!json?.success || !json?.data?.close) throw new Error("kline fail");

  let closes = json.data.close.map(Number).filter(v => Number.isFinite(v));
  if (closes.length < need) throw new Error("not enough candles");

  // ✅ 진행중 봉(마지막 close) 때문에 RSI/MA가 튀는 경우가 많아서 기본으로 1개 제외
  // (MEXC 차트와 더 잘 맞는 쪽이 대부분 이 설정)
  if (closes.length > need + 5) closes = closes.slice(0, -1);

  if (closes.length < need) throw new Error("not enough candles(after trim)");
  return closes;
}

function calcMA(closes, period) {
  const arr = closes.slice(-period);
  return arr.reduce((a,b)=>a+b,0)/period;
}

// ✅ 진짜 Wilder RSI(RMA 스무딩) - MEXC 차트 방식에 가장 근접
function calcRSI_Wilder(closes, period) {
  if (!Array.isArray(closes) || closes.length < period + 2) return NaN;

  let gain = 0, loss = 0;

  // 초기 평균(첫 period 구간)
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss += -diff;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  // 이후는 Wilder 스무딩: RMA
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

async function fetchIndicators(sym, tfMin) {
  const msym = mexcContractSymbol(sym);
  const key = `ind:${msym}:tf${tfMin}`;
  const cached = getCache(key);
  if (cached) return cached;

  // MA30 + RSI24 계산에 충분한 길이 확보
  const closes = await fetchCloses(msym, tfMin, 60);

  const ma30 = calcMA(closes, 30);
  const rsi6 = calcRSI_Wilder(closes, 6);
  const rsi12 = calcRSI_Wilder(closes, 12);
  const rsi24 = calcRSI_Wilder(closes, 24);

  const out = {
    symbol: msym,
    tf: Number(tfMin),
    ma30,
    rsi6,
    rsi12,
    rsi24,
    ts: Date.now()
  };

  // ✅ 지표는 60초 캐시
  setCache(key, out, 30 * 1000);
  return out;
}

// ====== Routes ======
app.get("/api/health", (req, res) => res.json({ ok: true, mexc_base: MEXC_BASE }));

// /api/quote_batch?symbols=BTCUSDT,ETHUSDT&tf=15
app.get("/api/quote_batch", async (req, res) => {
  try {
    const tf = Number(req.query.tf || 15);
    const symbols = String(req.query.symbols || "BTCUSDT")
      .split(",").map(s => s.trim()).filter(Boolean);

    const results = [];
    for (const sym of symbols) {
      try {
        const t = await fetchTicker(sym);
        const ind = await fetchIndicators(sym, tf);
        results.push({
          symbol: t.symbol,
          fair: t.fair,
          last: t.last,
          index: t.index,
          price_ts: t.ts,

          tf: ind.tf,
          ma30: ind.ma30,
          rsi6: ind.rsi6,
          rsi12: ind.rsi12,
          rsi24: ind.rsi24,
          ind_ts: ind.ts
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

app.listen(PORT, () => console.log("✅ Server running on port", PORT, "BASE:", MEXC_BASE));

