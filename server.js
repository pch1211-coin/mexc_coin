const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Static =====
app.use(express.static(path.join(__dirname, "public")));

// ===== Cache =====
const cache = new Map();
function getCache(k) {
  const v = cache.get(k);
  if (!v) return null;
  if (Date.now() > v.exp) { cache.delete(k); return null; }
  return v.data;
}
function setCache(k, data, ttl) {
  cache.set(k, { data, exp: Date.now() + ttl });
}

// ===== Helpers =====
function normSym(sym) {
  const s = String(sym || "").trim().toUpperCase();
  if (!s) return "";
  if (s.includes("_")) return s;
  return s.replace(/USDT$/, "_USDT");
}

async function fetchJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const t = await r.text();
  if (!r.ok) throw new Error(t);
  return JSON.parse(t);
}

// tfMin -> MEXC interval
function tfToInterval(tfMin) {
  const m = Number(tfMin);
  // MEXC에서 보통 지원하는 형태: Min1/Min5/Min15/Min30/Min60 등
  // (3,10도 되는 경우가 있지만 안되면 자동 fallback)
  const map = {
    1: "Min1",
    3: "Min3",
    5: "Min5",
    10: "Min10",
    15: "Min15",
    30: "Min30",
    60: "Min60",
  };
  return map[m] || "Min15";
}

// ===== Wilder RSI (MEXC 차트 RSI 방식에 가장 근접) =====
function rsiWilder(closes, period) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;

  let gains = 0, losses = 0;

  // 초기 평균
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += -diff; // ✅ loss는 양수로 누적
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Wilder smoothing
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ===== Fetch ticker (2s cache) =====
async function getTicker(sym) {
  const key = `ticker:${sym}`;
  const cached = getCache(key);
  if (cached) return cached;

  const t = await fetchJSON(`https://contract.mexc.com/api/v1/contract/ticker?symbol=${encodeURIComponent(sym)}`);
  if (!t?.success || !t?.data) throw new Error("ticker fail");

  const data = {
    fair: Number(t.data.fairPrice),
    // 24h high/low 필드가 가끔 달라서 fallback 준비
    high24: Number(t.data.high24Price ?? t.data.highPrice ?? t.data.high ?? NaN),
    low24: Number(t.data.lower24Price ?? t.data.low24Price ?? t.data.lowPrice ?? t.data.low ?? NaN),
    price_ts: Date.now(),
  };

  setCache(key, data, 2000);
  return data;
}

// ===== Fetch kline closes (60s cache) =====
async function getKlineCloses(sym, interval, limit = 200) {
  const key = `kline:${sym}:${interval}:${limit}`;
  const cached = getCache(key);
  if (cached) return cached;

  const k = await fetchJSON(
    `https://contract.mexc.com/api/v1/contract/kline/${encodeURIComponent(sym)}?interval=${encodeURIComponent(interval)}&limit=${limit}`
  );
  if (!k?.success || !k?.data?.close) throw new Error("kline fail");

  const closesRaw = k.data.close.map(Number).filter(Number.isFinite);
  const timesRaw = Array.isArray(k.data.time) ? k.data.time.map(Number) : [];

  // ✅ 핵심: 마지막 캔들(진행중) 제외 → 차트 RSI와 훨씬 잘 맞음
  if (closesRaw.length > 0) closesRaw.pop();
  if (timesRaw.length > 0) timesRaw.pop();

  if (closesRaw.length < 35) throw new Error("not enough candles");

  const ind_ts = timesRaw.length ? (timesRaw[timesRaw.length - 1] * 1000) : Date.now();

  const out = { closes: closesRaw, ind_ts };
  setCache(key, out, 60 * 1000);
  return out;
}

// ===== API =====
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/quote_batch", async (req, res) => {
  try {
    const symbols = String(req.query.symbols || "")
      .split(",").map(s => s.trim()).filter(Boolean);

    const tf = String(req.query.tf || "15"); // app.js에서 tf=15 형태로 보냄
    const interval = tfToInterval(tf);

    const results = [];

    for (const s of symbols) {
      try {
        const sym = normSym(s);

        // ticker
        const t = await getTicker(sym);

        // kline close 기반 RSI/MA
        const { closes, ind_ts } = await getKlineCloses(sym, interval, 200);

        // MA30 (마감된 close 30개 평균)
        const last30 = closes.slice(-30);
        const ma30 = last30.reduce((a, b) => a + b, 0) / last30.length;

        // RSI(6/12/24) Wilder
        const rsi6 = rsiWilder(closes, 6);
        const rsi12 = rsiWilder(closes, 12);
        const rsi24 = rsiWilder(closes, 24);

        results.push({
          symbol: sym,
          fair: t.fair,
          high24: Number.isFinite(t.high24) ? t.high24 : null,
          low24: Number.isFinite(t.low24) ? t.low24 : null,

          ma30,
          rsi6,
          rsi12,
          rsi24,

          price_ts: t.price_ts,
          ind_ts,           // ✅ 앱에서 new Date(q.ind_ts) 찍을 때 Invalid Date 방지
          tf: interval,
        });

      } catch (e) {
        results.push({ symbol: normSym(s), error: String(e?.message || e) });
      }
    }

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log("✅ Server running:", PORT));
