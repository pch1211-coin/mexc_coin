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

// ✅ Day1 close 배열 (RSI/MA용)
async function fetchDay1Closes(sym, days = 120) {
  const msym = mexcContractSymbol(sym);
  const key = `day1closes:${msym}:${days}`;
  const cached = getCache(key);
  if (cached) return cached;

  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = nowSec - days * 24 * 60 * 60;
  const url = `https://contract.mexc.com/api/v1/contract/kline/${encodeURIComponent(msym)}?interval=Day1&start=${startSec}&end=${nowSec}`;

  const json = await fetchJson(url);
  if (!json?.success || !json.data?.close) throw new Error("kline fail");

  const closes = json.data.close.map(Number).filter(v => Number.isFinite(v));
  if (closes.length < 30) throw new Error("not enough candles");

  const out = { symbol: msym, closes, ts: Date.now() };
  setCache(key, out, 30 * 1000); // ✅ 30초 캐시(일봉 close)
  return out;
}

// ====== MA30 (Day1 close avg) ======
async function fetchMA30(sym) {
  const msym = mexcContractSymbol(sym);
  const key = `ma30:${msym}`;
  const cached = getCache(key);
  if (cached) return cached;

  // ✅ close는 위 함수 재사용 (중복 호출 방지)
  const { closes } = await fetchDay1Closes(msym, 120);

  const last30 = closes.slice(-30);
  const ma30 = last30.reduce((a, b) => a + b, 0) / 30;

  const out = { symbol: msym, ma30, ts: Date.now() };
  setCache(key, out, 5 * 60 * 1000); // 5분 캐시(MA30)
  return out;
}

// ====== API ======
app.get("/api/health", (req, res) => res.json({ ok: true }));

// ✅ RSI용: Day1 close 배열 제공
// 예: /api/kline_day1?symbol=BTCUSDT  또는 BTC_USDT
app.get("/api/kline_day1", async (req, res) => {
  try {
    const sym = String(req.query.symbol || "").trim();
    if (!sym) return res.status(400).json({ error: "symbol required" });

    const r = await fetchDay1Closes(sym, 120);
    res.json({ symbol: r.symbol, close: r.closes, ts: r.ts });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
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
