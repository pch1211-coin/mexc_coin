const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

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

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "mexc-coin-dashboard" } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error("JSON parse fail"); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return json;
}

// ====== MEXC Futures Ticker (USDT-M) ======
async function fetchTicker(sym) {
  const msym = mexcContractSymbol(sym);
  const key = `ticker:${msym}`;
  const cached = getCache(key);
  if (cached) return cached;

  const url = `https://contract.mexc.com/api/v1/contract/ticker?symbol=${encodeURIComponent(msym)}`;
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
  setCache(key, out, 2000); // 2초 캐시(현재가)
  return out;
}

// ====== KLINE close 제공 (분봉/일봉 공용) ======
// 예: /api/kline?symbol=WLD_USDT&interval=Min15&days=7
async function fetchKlineCloses(sym, interval = "Day1", days = 7) {
  const msym = mexcContractSymbol(sym);
  const d = Math.min(120, Math.max(1, Number(days || 7)));
  const itv = String(interval || "Day1").trim();

  const key = `kline:${msym}:${itv}:${d}`;
  const cached = getCache(key);
  if (cached) return cached;

  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = nowSec - d * 24 * 60 * 60;

  const url = `https://contract.mexc.com/api/v1/contract/kline/${encodeURIComponent(msym)}?interval=${encodeURIComponent(itv)}&start=${startSec}&end=${nowSec}`;
  const json = await fetchJson(url);
  if (!json?.success || !json.data?.close) throw new Error("kline fail");

  const close = json.data.close.map(Number).filter(v => Number.isFinite(v));
  if (close.length < 30) throw new Error("not enough candles");

  const out = { symbol: msym, interval: itv, close, ts: Date.now() };
  // ✅ 분봉은 짧게 캐시, 일봉은 조금 길게 캐시
  const ttl = (itv === "Day1") ? 30 * 1000 : 10 * 1000;
  setCache(key, out, ttl);
  return out;
}

// ====== MA30 (Day1 close avg) ======
async function fetchMA30(sym) {
  const msym = mexcContractSymbol(sym);
  const key = `ma30:${msym}`;
  const cached = getCache(key);
  if (cached) return cached;

  // Day1 close 가져와서 MA30 계산
  const k = await fetchKlineCloses(msym, "Day1", 120);
  const closes = k.close;
  const last30 = closes.slice(-30);
  const ma30 = last30.reduce((a, b) => a + b, 0) / 30;

  const out = { symbol: msym, ma30, ts: Date.now() };
  setCache(key, out, 5 * 60 * 1000); // 5분 캐시(MA30)
  return out;
}

// ====== API ======
app.get("/api/health", (req, res) => res.json({ ok: true }));

// ✅ KLINE API
app.get("/api/kline", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").trim();
    const interval = String(req.query.interval || "Day1").trim();
    const days = Number(req.query.days || 7);

    if (!symbol) return res.status(400).json({ error: "symbol required" });

    const r = await fetchKlineCloses(symbol, interval, days);
    return res.json(r);
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// 단일: /api/quote?symbol=BTCUSDT
app.get("/api/quote", async (req, res) => {
  try {
    const sym = String(req.query.symbol || "BTCUSDT");
    const t = await fetchTicker(sym);
    const m = await fetchMA30(sym);
    res.json({
      symbol: t.symbol,
      fair: t.fair,
      last: t.last,
      index: t.index,
      ma30: m.ma30,
      ma30_ts: m.ts,
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
        const m = await fetchMA30(sym);
        results.push({
          symbol: t.symbol,
          fair: t.fair,
          last: t.last,
          index: t.index,
          ma30: m.ma30,
          ma30_ts: m.ts,
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

app.listen(PORT, () => console.log("✅ Server running on port", PORT));
