import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== 캐시 (속도/레이트리밋 보호) =====
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

function mexcSymbol(sym) {
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

// ticker: fairPrice 사용(구글시트 맞춤)
async function fetchTicker(sym) {
  const msym = mexcSymbol(sym);
  const key = `ticker:${msym}`;
  const cached = getCache(key);
  if (cached) return cached;

  const url = `https://contract.mexc.com/api/v1/contract/ticker?symbol=${encodeURIComponent(msym)}`;
  const json = await fetchJson(url);
  if (!json?.success || !json.data) throw new Error("ticker fail");

  const last = Number(json.data.lastPrice);
  const fair = Number(json.data.fairPrice ?? json.data.fair_price ?? last);
  if (!Number.isFinite(fair)) throw new Error("fair invalid");

  const out = { symbol: msym, last, fair, ts: Date.now() };
  setCache(key, out, 2000); // 2초 캐시
  return out;
}

// MA30: Day1 종가 30개 평균 (5분 캐시)
async function fetchMA30(sym) {
  const msym = mexcSymbol(sym);
  const key = `ma30:${msym}`;
  const cached = getCache(key);
  if (cached) return cached;

  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = nowSec - 60 * 24 * 60 * 60; // 60일치 여유
  const url = `https://contract.mexc.com/api/v1/contract/kline/${encodeURIComponent(msym)}?interval=Day1&start=${startSec}&end=${nowSec}`;
  const json = await fetchJson(url);
  if (!json?.success || !json.data?.close) throw new Error("kline fail");

  const closes = json.data.close.map(Number).filter(v => Number.isFinite(v));
  if (closes.length < 30) throw new Error("not enough candles");
  const last30 = closes.slice(-30);
  const ma30 = last30.reduce((a, b) => a + b, 0) / 30;

  const out = { ma30, refreshedAt: Date.now() };
  setCache(key, out, 5 * 60 * 1000); // 5분 캐시
  return out;
}

// ===== 정적 파일 =====
app.use(express.static(path.join(__dirname, "public")));

// health
app.get("/api/health", (req, res) => res.json({ ok: true }));

// 단일 심볼 데이터
app.get("/api/market", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "BTCUSDT");
    const t = await fetchTicker(symbol);
    const m = await fetchMA30(symbol);
    res.json({
      symbol: mexcSymbol(symbol),
      fair: t.fair,
      last: t.last,
      ma30: m.ma30,
      ma30RefreshedAt: m.refreshedAt,
      ts: t.ts
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// 배치 (여러 코인 한 번에)
app.get("/api/market_batch", async (req, res) => {
  try {
    const symbols = String(req.query.symbols || "BTCUSDT")
      .split(",").map(s => s.trim()).filter(Boolean);

    const results = [];
    for (const s of symbols) {
      const t = await fetchTicker(s);
      const m = await fetchMA30(s);
      results.push({
        symbol: mexcSymbol(s),
        fair: t.fair,
        last: t.last,
        ma30: m.ma30,
        ma30RefreshedAt: m.refreshedAt,
        ts: t.ts
      });
    }
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log("Server running on", PORT));
