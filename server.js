const express = require("express");
const app = express();

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// ---- MEXC endpoints (contract) ----
function mexcSymbol(sym) {
  const s = String(sym || "").trim().toUpperCase();
  if (!s) return "";
  if (s.includes("_")) return s;
  if (s.endsWith("USDT")) return s.replace(/USDT$/, "_USDT");
  return s;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "mexc_coin_dashboard/1.0" } });
  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); } catch { throw new Error("JSON parse fail"); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return json;
}

// ---- simple in-memory cache ----
const cache = new Map();
function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() > v.exp) return null;
  return v.data;
}
function cacheSet(key, data, ttlMs) {
  cache.set(key, { data, exp: Date.now() + ttlMs });
}

const TTL_PRICE = 5 * 1000;      // 5초
const TTL_MA_RSI = 5 * 60 * 1000; // 5분

// ---- API: ticker (fair/last/index) ----
app.get("/api/ticker", async (req, res) => {
  try {
    const symbol = mexcSymbol(req.query.symbol);
    if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });

    const key = `ticker:${symbol}`;
    const cached = cacheGet(key);
    if (cached) return res.json({ ok: true, ...cached, cached: true });

    const url = `https://contract.mexc.com/api/v1/contract/ticker?symbol=${encodeURIComponent(symbol)}`;
    const json = await fetchJson(url);

    if (!json || json.success !== true || !json.data) {
      return res.status(502).json({ ok: false, error: json?.message || "ticker fail", raw: json });
    }

    const last = Number(json.data.lastPrice);
    const fair = Number(json.data.fairPrice ?? json.data.fair_price ?? last);
    const index = Number(json.data.indexPrice ?? json.data.index_price ?? NaN);

    const data = { symbol, last, fair, index, ts: Date.now() };
    cacheSet(key, data, TTL_PRICE);

    res.json({ ok: true, ...data, cached: false });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- API: MA30 (Day1 close 30개 평균) ----
app.get("/api/ma30", async (req, res) => {
  try {
    const symbol = mexcSymbol(req.query.symbol);
    if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });

    const key = `ma30:${symbol}`;
    const cached = cacheGet(key);
    if (cached) return res.json({ ok: true, ...cached, cached: true });

    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = nowSec - 60 * 24 * 60 * 60;

    const url =
      `https://contract.mexc.com/api/v1/contract/kline/${encodeURIComponent(symbol)}` +
      `?interval=Day1&start=${startSec}&end=${nowSec}`;

    const json = await fetchJson(url);
    if (!json || json.success !== true || !json.data || !json.data.close) {
      return res.status(502).json({ ok: false, error: json?.message || "kline fail", raw: json });
    }

    const closes = json.data.close.map(Number).filter(v => Number.isFinite(v));
    if (closes.length < 30) {
      return res.status(502).json({ ok: false, error: `not enough candles: ${closes.length}` });
    }
    const last30 = closes.slice(-30);
    const ma30 = last30.reduce((a, b) => a + b, 0) / 30;

    const data = { symbol, ma30, ts: Date.now() };
    cacheSet(key, data, TTL_MA_RSI);

    res.json({ ok: true, ...data, cached: false });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- API: RSI14 (Day1 close 기반) ----
function calcRsi14(closes) {
  // closes: 오래된 -> 최신
  const period = 14;
  if (!closes || closes.length < period + 1) return null;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

app.get("/api/rsi14", async (req, res) => {
  try {
    const symbol = mexcSymbol(req.query.symbol);
    if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });

    const key = `rsi14:${symbol}`;
    const cached = cacheGet(key);
    if (cached) return res.json({ ok: true, ...cached, cached: true });

    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = nowSec - 80 * 24 * 60 * 60; // 여유 있게 80일

    const url =
      `https://contract.mexc.com/api/v1/contract/kline/${encodeURIComponent(symbol)}` +
      `?interval=Day1&start=${startSec}&end=${nowSec}`;

    const json = await fetchJson(url);
    if (!json || json.success !== true || !json.data || !json.data.close) {
      return res.status(502).json({ ok: false, error: json?.message || "kline fail", raw: json });
    }

    const closes = json.data.close.map(Number).filter(v => Number.isFinite(v));
    const rsi14 = calcRsi14(closes);
    if (!Number.isFinite(rsi14)) {
      return res.status(502).json({ ok: false, error: "RSI calc fail" });
    }

    const data = { symbol, rsi14, ts: Date.now() };
    cacheSet(key, data, TTL_MA_RSI);

    res.json({ ok: true, ...data, cached: false });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
