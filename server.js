const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

// 정적파일 제공
app.use(express.static(path.join(__dirname, "public")));

// ---- MEXC endpoints (Futures Contract) ----
// 주의: MEXC 선물 심볼은 BTC_USDT 형태가 필요할 수 있음.
// 사용자가 BTCUSDT를 넣으면 서버가 BTC_USDT로 변환해줌.

function normalizeSymbol(sym) {
  const s = String(sym || "").trim().toUpperCase();
  if (!s) return "";
  if (s.includes("_")) return s;
  if (s.endsWith("USDT")) return s.replace(/USDT$/, "_USDT");
  return s;
}

async function mexcFetchJson(url) {
  // Node 18+ 에는 fetch 기본 내장
  const res = await fetch(url, { headers: { "User-Agent": "mexc-dash-web" } });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error("MEXC JSON parse fail");
  }
  if (!res.ok) throw new Error(`MEXC HTTP ${res.status}`);
  return json;
}

// ticker cache (짧게)
const tickerCache = new Map(); // key: symbol, value: {ts, data}
const TICKER_TTL_MS = 1500; // 1.5초

// MA30 cache (길게)
const ma30Cache = new Map(); // key: symbol, value: {ts, ma30}
const MA30_TTL_MS = 5 * 60 * 1000; // 5분

app.get("/api/ticker", async (req, res) => {
  try {
    const symRaw = req.query.symbol;
    const symbol = normalizeSymbol(symRaw);
    if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });

    const now = Date.now();
    const cached = tickerCache.get(symbol);
    if (cached && now - cached.ts < TICKER_TTL_MS) {
      return res.json({ ok: true, symbol, ...cached.data, cached: true });
    }

    const url = `https://contract.mexc.com/api/v1/contract/ticker?symbol=${encodeURIComponent(symbol)}`;
    const json = await mexcFetchJson(url);

    if (!json || json.success !== true || !json.data) {
      return res.status(502).json({ ok: false, error: "ticker fail", raw: json });
    }

    const last = Number(json.data.lastPrice);
    const fair = Number(json.data.fairPrice ?? json.data.fair_price ?? last);
    const index = Number(json.data.indexPrice ?? json.data.index_price ?? NaN);

    const data = {
      last: Number.isFinite(last) ? last : null,
      fair: Number.isFinite(fair) ? fair : null,
      index: Number.isFinite(index) ? index : null
    };

    tickerCache.set(symbol, { ts: now, data });
    res.json({ ok: true, symbol, ...data, cached: false });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/ma30", async (req, res) => {
  try {
    const symRaw = req.query.symbol;
    const symbol = normalizeSymbol(symRaw);
    if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });

    const now = Date.now();
    const cached = ma30Cache.get(symbol);
    if (cached && now - cached.ts < MA30_TTL_MS) {
      return res.json({ ok: true, symbol, ma30: cached.ma30, cached: true, ttlMs: MA30_TTL_MS });
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = nowSec - 60 * 24 * 60 * 60; // 60일치 조회 (여유)

    const url =
      `https://contract.mexc.com/api/v1/contract/kline/${encodeURIComponent(symbol)}` +
      `?interval=Day1&start=${startSec}&end=${nowSec}`;

    const json = await mexcFetchJson(url);

    if (!json || json.success !== true || !json.data || !Array.isArray(json.data.close)) {
      return res.status(502).json({ ok: false, error: "kline fail", raw: json });
    }

    const closes = json.data.close.map(Number).filter(v => Number.isFinite(v));
    if (closes.length < 30) {
      return res.status(502).json({ ok: false, error: "not enough candles", length: closes.length });
    }

    const last30 = closes.slice(-30);
    const ma30 = last30.reduce((a, b) => a + b, 0) / 30;

    ma30Cache.set(symbol, { ts: now, ma30 });
    res.json({ ok: true, symbol, ma30, cached: false, ttlMs: MA30_TTL_MS });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 헬스체크
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
