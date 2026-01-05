const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ MEXC_BASE: Cloudflare Worker 프록시 주소 넣기
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
  // 기본 15분
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

// ====== API Calls ======
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

async function fetchCloses(sym, tfMin, need) {
  const msym = mexcContractSymbol(sym);
  const interval = tfToInterval(tfMin);

  // need보다 넉넉히
  const want = Math.max(need + 20, 120);

  // TF에 따라 과거 범위 잡기 (대충 want개 캔들)
  const nowSec = Math.floor(Date.now() / 1000);
  const secPer = Number(tfMin) * 60;
  const startSec = nowSec - want * secPer;

  const url = `${MEXC_BASE}/api/v1/contract/kline/${encodeURIComponent(msym)}?interval=${interval}&start=${startSec}&end=${nowSec}`;
  const json = await fetchJson(url);

  if (!json?.success || !json?.data?.close) throw new Error("kline fail");

  const closes = json.data.close.map(Number).filter(v => Number.isFinite(v));
  if (closes.length < need) throw new Error("not enough candles");
  return closes;
}

function calcMA(closes, period) {
  const arr = closes.slice(-period);
  return arr.reduce((a,b)=>a+b,0)/period;
}

// Wilder RSI
function calcRSI(closes, period) {
  const arr = closes.slice(-(period+1));
  if (arr.length < period+1) return NaN;

  let gains = 0, losses = 0;
  for (let i=1; i<arr.length; i++) {
    const diff = arr[i] - arr[i-1];
    if (diff >= 0) gains += diff;
    else losses += (-diff);
  }
  const avgGain = gains/period;
  const avgLoss = losses/period;
  if (avgLoss === 0) return 100;
  const rs = avgGain/avgLoss;
  return 100 - (100/(1+rs));
}

async function fetchIndicators(sym, tfMin) {
  const msym = mexcContractSymbol(sym);
  const key = `ind:${msym}:tf${tfMin}`;
  const cached = getCache(key);
  if (cached) return cached;

  // MA30: 30개 필요
  // RSI24: 25개 필요
  const closes = await fetchCloses(msym, tfMin, 60);

  const ma30 = calcMA(closes, 30);
  const rsi6 = calcRSI(closes, 6);
  const rsi12 = calcRSI(closes, 12);
  const rsi24 = calcRSI(closes, 24);

  const out = {
    symbol: msym,
    tf: Number(tfMin),
    ma30,
    rsi6,
    rsi12,
    rsi24,
    ts: Date.now()
  };

  // ✅ 지표는 60초 캐시 (너 스샷 "RSI+MA30=60s 캐시" 맞춤)
  setCache(key, out, 60 * 1000);
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
