const express = require("express");
const path = require("path");

// Node 18+는 fetch 내장. (node-fetch 설치돼있어도 상관없음)
const fetch = global.fetch || require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Render 환경변수: MEXC_BASE (예: https://mexc-proxy.pch1211.workers.dev)
const MEXC_BASE_RAW = (process.env.MEXC_BASE || "https://contract.mexc.com").trim();
const MEXC_BASE = MEXC_BASE_RAW.replace(/\/+$/, ""); // trailing slash 제거

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
  if (s.endsWith("USDT")) return s.replace(/USDT$/, "_USDT");
  return s;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "mexc-coin-dashboard" } });
  const text = await res.text();
  return { res, text };
}

async function fetchJson(url) {
  const { res, text } = await fetchText(url);
  let json;
  try { json = JSON.parse(text); }
  catch {
    // JSON 아닌 HTML(Access Denied 등)
    const snippet = text.slice(0, 180).replace(/\s+/g, " ");
    throw new Error(`JSON parse fail (HTTP ${res.status}) :: ${snippet}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return json;
}

// ====== MEXC Futures Ticker ======
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

// ====== KLINE close list (Min5/Min15/Min30) ======
async function fetchKlineClose(sym, interval, days = 7) {
  const msym = mexcContractSymbol(sym);

  // 허용 인터벌만
  const allow = new Set(["Min5", "Min15", "Min30"]);
  const iv = allow.has(interval) ? interval : "Min15";

  const d = Math.min(30, Math.max(1, Number(days) || 7));
  const key = `kline:${msym}:${iv}:${d}`;
  const cached = getCache(key);
  if (cached) return cached;

  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = nowSec - d * 24 * 60 * 60;

  const url = `${MEXC_BASE}/api/v1/contract/kline/${encodeURIComponent(msym)}?interval=${encodeURIComponent(iv)}&start=${startSec}&end=${nowSec}`;
  const json = await fetchJson(url);
  if (!json?.success || !json?.data?.close) throw new Error("kline fail");

  const close = json.data.close.map(Number).filter(v => Number.isFinite(v));
  if (close.length < 35) throw new Error("not enough candles");

  const out = { symbol: msym, interval: iv, close, ts: Date.now() };
  setCache(key, out, 60 * 1000); // 60초 캐시
  return out;
}

// ====== API ======
app.get("/api/health", (req, res) => res.json({ ok: true, mexc_base: MEXC_BASE }));

// 배치: /api/quote_batch?symbols=BTCUSDT,ETHUSDT
app.get("/api/quote_batch", async (req, res) => {
  try {
    const symbols = String(req.query.symbols || "BTCUSDT")
      .split(",").map(s => s.trim()).filter(Boolean);

    const results = [];
    for (const sym of symbols) {
      try {
        const t = await fetchTicker(sym);
        results.push({
          symbol: t.symbol,
          fair: t.fair,
          last: t.last,
          index: t.index,
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

// kline: /api/kline?symbol=BTC_USDT&interval=Min15&days=7
app.get("/api/kline", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "BTCUSDT");
    const interval = String(req.query.interval || "Min15");
    const days = Number(req.query.days || 7);

    const k = await fetchKlineClose(symbol, interval, days);
    res.json({
      symbol: k.symbol,
      interval: k.interval,
      close: k.close,
      ts: k.ts
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log("✅ Server running on port", PORT, "| MEXC_BASE =", MEXC_BASE));
