const express = require("express");
//Node 18+ has global fetch (no node-fetchneebed)
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Static =====
app.use(express.static(path.join(__dirname, "public")));

// ===== Helpers =====
function symF(sym) {
  const s = String(sym || "").trim().toUpperCase();
  if (!s) return "";
  if (s.includes("_")) return s;
  return s.replace(/USDT$/, "_USDT");
}

function tfToInterval(tfMin) {
  const n = Number(tfMin);
  if (n === 1) return "Min1";
  if (n === 3) return "Min3";
  if (n === 5) return "Min5";
  if (n === 10) return "Min10";
  if (n === 15) return "Min15";
  if (n === 30) return "Min30";
  if (n === 60) return "Min60";
  if (n === 240) return "Hour4";
  if (n === 1440) return "Day1";
  return "Min15";
}

async function fetchJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const t = await r.text();
  if (!r.ok) throw new Error(t);
  try {
    return JSON.parse(t);
  } catch {
    throw new Error("JSON parse fail");
  }
}

// ===== Wilder RSI (TradingView에 더 근접) =====
function calcRSI_Wilder(closes, period) {
  if (!Array.isArray(closes)) return null;
  if (closes.length < period + 2) return null;

  // diff 배열 (앞->뒤)
  let gains = 0;
  let losses = 0;

  // 초기 평균(첫 period 구간)
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += -diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // 이후는 Wilder smoothing(RMA)
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ===== API =====
app.get("/api/quote_batch", async (req, res) => {
  try {
    const symbols = String(req.query.symbols || "")
      .split(",").map(s => s.trim()).filter(Boolean);

    const tfMin = Number(req.query.tf || 15) || 15;
    const interval = tfToInterval(tfMin);

    const results = [];

    for (const s of symbols) {
      try {
        const sym = symF(s);

        // --- ticker ---
        const t = await fetchJSON(
          `https://contract.mexc.com/api/v1/contract/ticker?symbol=${encodeURIComponent(sym)}`
        );

        // MEXC는 필드명이 종종 달라서 다 받아줌
        const td = t?.data || {};
        const fair = Number(td.fairPrice ?? td.fair_price ?? td.lastPrice ?? td.last_price);

        const high24 = Number(td.high24Price ?? td.high24_price ?? td.highPrice ?? td.high_price);
        const low24  = Number(td.lower24Price ?? td.low24Price ?? td.lower24_price ?? td.low24_price ?? td.lowPrice ?? td.low_price);

        // --- kline (tf, 충분히 길게) ---
        const k = await fetchJSON(
          `https://contract.mexc.com/api/v1/contract/kline/${encodeURIComponent(sym)}?interval=${encodeURIComponent(interval)}&limit=300`
        );

        const closes = (k?.data?.close || []).map(Number).filter(v => Number.isFinite(v));
        if (closes.length < 60) throw new Error("not enough candles");

        const ma30 = closes.slice(-30).reduce((a, b) => a + b, 0) / 30;

        const rsi6  = calcRSI_Wilder(closes, 6);
        const rsi12 = calcRSI_Wilder(closes, 12);
        const rsi24 = calcRSI_Wilder(closes, 24);

        const now = Date.now();

        results.push({
          symbol: sym,
          fair,
          ma30,
          high24: Number.isFinite(high24) ? high24 : null,
          low24: Number.isFinite(low24) ? low24 : null,
          rsi6,
          rsi12,
          rsi24,
          price_ts: now,
          ind_ts: now,
          tfMin
        });

      } catch (e) {
        results.push({ symbol: s, error: String(e?.message || e) });
      }
    }

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log("✅ Server running:", PORT));

