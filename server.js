const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * ✅ MEXC 호출은 Cloudflare Worker 프록시로!
 * - 기본값을 네 Worker로 박아둠
 * - 필요하면 Render 환경변수 MEXC_BASE로 교체 가능
 */
const MEXC_BASE = process.env.MEXC_BASE || "https://mexc-proxy-pch1211.workers.dev";

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

function normalizeMaInterval(q) {
  const v = String(q || "Min15").trim();
  const allow = new Set(["Min1","Min3","Min5","Min10","Min15","Min30"]);
  return allow.has(v) ? v : "Min15";
}
function intervalToSeconds(interval) {
  const map = { Min1:60, Min3:180, Min5:300, Min10:600, Min15:900, Min30:1800 };
  return map[interval] || 900;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "mexc-coin-dashboard",
      "Accept": "application/json"
    },
    redirect: "follow",
  });

  const text = await res.text();

  // ✅ 응답 파싱
  let json = null;
  try { json = JSON.parse(text); } catch {}

  // ✅ 실패 시 에러에 body 일부 포함
  if (!res.ok) {
    const snippet = text ? text.slice(0, 160) : "";
    throw new Error(`HTTP ${res.status} ${snippet}`);
  }

  if (!json) throw new Error("JSON parse fail");
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
  setCache(key, out, 2000);
  return out;
}

// ✅ MA30 (분봉 interval 기준)
async function fetchMA30(sym, interval) {
  const msym = mexcContractSymbol(sym);
  const iv = normalizeMaInterval(interval);

  const key = `ma30:${msym}:${iv}`;
  const cached = getCache(key);
  if (cached) return cached;

  const secPer = intervalToSeconds(iv);
  // 30개 + 여유 확보
  const needSec = secPer * 100;

  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = nowSec - needSec;

  const url =
    `${MEXC_BASE}/api/v1/contract/kline/${encodeURIComponent(msym)}` +
    `?interval=${encodeURIComponent(iv)}&start=${startSec}&end=${nowSec}`;

  const json = await fetchJson(url);
  if (!json?.success || !json.data?.close) throw new Error("kline fail");

  const closes = json.data.close.map(Number).filter(v => Number.isFinite(v));
  if (closes.length < 30) throw new Error("not enough candles");

  const last30 = closes.slice(-30);
  const ma30 = last30.reduce((a, b) => a + b, 0) / 30;

  const out = { symbol: msym, ma30, interval: iv, ts: Date.now() };
  setCache(key, out, 8000);
  return out;
}

// ====== API ======
app.get("/api/health", (req, res) => res.json({ ok: true, mexc_base: MEXC_BASE }));

// ✅ 공용 KLINE close 제공 (RSI용)
// /api/kline?symbol=BTC_USDT&interval=Min15&days=7
app.get("/api/kline", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").trim();
    const interval = String(req.query.interval || "Min15").trim();
    const days = Math.min(120, Math.max(1, Number(req.query.days || 7)));

    if (!symbol) return res.status(400).json({ error: "symbol required" });

    const msym = mexcContractSymbol(symbol);
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = nowSec - days * 24 * 60 * 60;

    const key = `kline:${msym}:${interval}:${days}`;
    const cached = getCache(key);
    if (cached) return res.json(cached);

    const url =
      `${MEXC_BASE}/api/v1/contract/kline/${encodeURIComponent(msym)}` +
      `?interval=${encodeURIComponent(interval)}&start=${startSec}&end=${nowSec}`;

    const json = await fetchJson(url);
    if (!json?.success || !json.data?.close) throw new Error("kline fail");

    const close = json.data.close.map(Number).filter(v => Number.isFinite(v));
    if (close.length < 30) return res.status(502).json({ error: "not enough closes" });

    const out = { symbol: msym, interval, close, ts: Date.now() };
    setCache(key, interval.startsWith("Min") ? 10 * 1000 : 30 * 1000);
    return res.json(out);
  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
      mexc_base: MEXC_BASE
    });
  }
});

// 단일: /api/quote?symbol=BTCUSDT&ma_interval=Min15
app.get("/api/quote", async (req, res) => {
  try {
    const sym = String(req.query.symbol || "BTCUSDT");
    const maInterval = normalizeMaInterval(req.query.ma_interval);

    const t = await fetchTicker(sym);
    const m = await fetchMA30(sym, maInterval);

    res.json({
      symbol: t.symbol,
      fair: t.fair,
      last: t.last,
      index: t.index,
      ma30: m.ma30,
      ma30_ts: m.ts,
      ma30_interval: m.interval,
      price_ts: t.ts
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// 배치: /api/quote_batch?symbols=...&ma_interval=Min15
app.get("/api/quote_batch", async (req, res) => {
  try {
    const symbols = String(req.query.symbols || "BTCUSDT")
      .split(",").map(s => s.trim()).filter(Boolean);

    const maInterval = normalizeMaInterval(req.query.ma_interval);

    const results = [];
    for (const sym of symbols) {
      try {
        const t = await fetchTicker(sym);
        const m = await fetchMA30(sym, maInterval);
        results.push({
          symbol: t.symbol,
          fair: t.fair,
          last: t.last,
          index: t.index,
          ma30: m.ma30,
          ma30_ts: m.ts,
          ma30_interval: m.interval,
          price_ts: t.ts
        });
      } catch (e) {
        results.push({ symbol: mexcContractSymbol(sym), error: String(e?.message || e) });
      }
    }

    res.json({ results, ma_interval: maInterval });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log("✅ Server running on port", PORT, " / MEXC_BASE:", MEXC_BASE));
