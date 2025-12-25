const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// ====== Static ======
app.use(express.static("public", { maxAge: "0" }));

// ====== Helpers ======
function toMexcContractSymbol(sym) {
  // 허용: BTCUSDT / BTC_USDT / btcusdt / btc_usdt
  const s = String(sym || "").trim().toUpperCase();
  if (!s) return "";
  if (s.includes("_")) return s;              // already BTC_USDT
  if (s.endsWith("USDT")) return s.replace(/USDT$/, "_USDT");
  return s;
}

async function mexcFetchJson(url) {
  // Node 18+ has global fetch
  const r = await fetch(url, {
    headers: {
      "User-Agent": "mexc-dash-web/1.0"
    }
  });
  const txt = await r.text();
  let json;
  try {
    json = JSON.parse(txt);
  } catch (e) {
    throw new Error(`JSON parse fail: ${txt.slice(0, 200)}`);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return json;
}

// ====== API: ticker ======
app.get("/api/ticker", async (req, res) => {
  try {
    const symbol = toMexcContractSymbol(req.query.symbol);
    if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });

    const url = `https://contract.mexc.com/api/v1/contract/ticker?symbol=${encodeURIComponent(symbol)}`;
    const json = await mexcFetchJson(url);

    // mexc contract api: {success:boolean, code, data, message}
    if (!json || json.success !== true || !json.data) {
      return res.status(502).json({ ok: false, error: json?.message || "ticker fail", raw: json });
    }

    const last = Number(json.data.lastPrice);
    const fair = Number(json.data.fairPrice ?? json.data.fair_price ?? last);
    const index = Number(json.data.indexPrice ?? json.data.index_price ?? NaN);

    return res.json({
      ok: true,
      symbol,
      last: Number.isFinite(last) ? last : null,
      fair: Number.isFinite(fair) ? fair : null,
      index: Number.isFinite(index) ? index : null,
      ts: Date.now()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ====== API: MA30 (5분 캐시) ======
const maCache = new Map(); // symbol -> {value, expiresAt, updatedAt}
const MA_CACHE_MS = 5 * 60 * 1000;

app.get("/api/ma30", async (req, res) => {
  try {
    const symbol = toMexcContractSymbol(req.query.symbol);
    if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });

    const now = Date.now();
    const cached = maCache.get(symbol);
    if (cached && cached.expiresAt > now) {
      return res.json({
        ok: true,
        symbol,
        ma30: cached.value,
        cached: true,
        updatedAt: cached.updatedAt,
        ts: now
      });
    }

    const nowSec = Math.floor(now / 1000);
    const startSec = nowSec - 60 * 24 * 60 * 60; // 60일치(안전)
    const url =
      `https://contract.mexc.com/api/v1/contract/kline/${encodeURIComponent(symbol)}` +
      `?interval=Day1&start=${startSec}&end=${nowSec}`;

    const json = await mexcFetchJson(url);
    if (!json || json.success !== true || !json.data || !json.data.close) {
      return res.status(502).json({ ok: false, error: json?.message || "kline fail", raw: json });
    }

    const closes = json.data.close.map(Number).filter(v => Number.isFinite(v));
    if (closes.length < 30) {
      return res.status(502).json({ ok: false, error: "not enough candles (need 30+)" });
    }

    const last30 = closes.slice(-30);
    const ma30 = last30.reduce((a, b) => a + b, 0) / 30;

    maCache.set(symbol, {
      value: ma30,
      updatedAt: now,
      expiresAt: now + MA_CACHE_MS
    });

    return res.json({
      ok: true,
      symbol,
      ma30,
      cached: false,
      updatedAt: now,
      ts: now
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// health
app.get("/api/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => {
  console.log("Server running on", PORT);
});
