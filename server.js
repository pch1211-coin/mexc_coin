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
function symF(sym) {
  if (!sym) return "";
  if (sym.includes("_")) return sym;
  return sym.replace(/USDT$/, "_USDT");
}

async function fetchJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const t = await r.text();
  if (!r.ok) throw new Error(t);
  return JSON.parse(t);
}

// ===== RSI 계산 =====
function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

// ===== API =====
app.get("/api/quote_batch", async (req, res) => {
  try {
    const symbols = String(req.query.symbols || "")
      .split(",").map(s => s.trim()).filter(Boolean);

    const results = [];

    for (const s of symbols) {
      try {
        const sym = symF(s);

        // --- ticker ---
        const t = await fetchJSON(
          `https://contract.mexc.com/api/v1/contract/ticker?symbol=${sym}`
        );

        const fair = Number(t.data.fairPrice);
        const high24 = Number(t.data.high24Price);
        const low24 = Number(t.data.lower24Price);

        // --- kline (15m, 100개) ---
        const k = await fetchJSON(
          `https://contract.mexc.com/api/v1/contract/kline/${sym}?interval=Min15&limit=100`
        );

        const closes = k.data.close.map(Number);

        const ma30 = closes.slice(-30).reduce((a,b)=>a+b,0) / 30;

        const rsi6  = calcRSI(closes, 6);
        const rsi12 = calcRSI(closes, 12);
        const rsi24 = calcRSI(closes, 24);

        results.push({
          symbol: sym,
          fair,
          ma30,
          high24,
          low24,
          rsi6,
          rsi12,
          rsi24,
          price_ts: Date.now()
        });

      } catch (e) {
        results.push({ symbol: s, error: e.message });
      }
    }

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log("✅ Server running:", PORT));
