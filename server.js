const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// =====================
// Static
// =====================
app.use(express.static(path.join(__dirname, "public")));

// =====================
// Base URL (Cloudflare Worker)
// =====================
const MEXC_BASE = process.env.MEXC_BASE || "https://mexc-proxy.pch1211.workers.dev";

// =====================
// Helpers
// =====================
function mexcContractSymbol(sym) {
  const s = String(sym || "").trim().toUpperCase();
  if (!s) return "";
  if (s.includes("_")) return s;
  if (s.endsWith("USDT")) return s.replace(/USDT$/, "_USDT");
  return s;
}

function normalizeKlineInterval(v) {
  const s = String(v || "").trim();

  const allow = new Set([
    "Min1","Min3","Min5","Min10","Min15","Min30",
    "Min60","Hour1","Day1"
  ]);
  if (allow.has(s)) return s;

  const map = {
    "1m":"Min1","1분":"Min1","1":"Min1",
    "3m":"Min3","3분":"Min3","3":"Min3",
    "5m":"Min5","5분":"Min5","5":"Min5",
    "10m":"Min10","10분":"Min10","10":"Min10",
    "15m":"Min15","15분":"Min15","15":"Min15",
    "30m":"Min30","30분":"Min30","30":"Min30",
  };
  return map[s] || "Min15";
}

// =====================
// Health
// =====================
app.get("/api/health", (req, res) => {
  res.json({ ok: true, mexc_base: MEXC_BASE });
});

// =====================
// Quote batch (현재가 + MA30)
// =====================
app.get("/api/quote_batch", async (req, res) => {
  try {
    const symbols = String(req.query.symbols || "")
      .split(",").map(s => s.trim()).filter(Boolean);

    const results = [];
    for (const sym of symbols) {
      try {
        const msym = mexcContractSymbol(sym);

        const tRes = await fetch(
          `${MEXC_BASE}/api/v1/contract/ticker?symbol=${encodeURIComponent(msym)}`
        );
        const tJson = await tRes.json();

        if (!tJson?.success || !tJson?.data) {
          throw new Error("ticker fail");
        }

        // MA30 (15분봉 기준)
        const interval = "Min15";
        const nowSec = Math.floor(Date.now() / 1000);
        const startSec = nowSec - 7 * 24 * 60 * 60;

        const kRes = await fetch(
          `${MEXC_BASE}/api/v1/contract/kline/${encodeURIComponent(msym)}?interval=${interval}&start=${startSec}&end=${nowSec}`
        );
        const kJson = await kRes.json();

        let ma30 = null;
        if (kJson?.success && Array.isArray(kJson?.data?.close) && kJson.data.close.length >= 30) {
          const last30 = kJson.data.close.slice(-30).map(Number);
          ma30 = last30.reduce((a,b)=>a+b,0) / 30;
        }

        results.push({
          symbol: msym,
          fair: Number(tJson.data.fairPrice ?? tJson.data.fair_price ?? tJson.data.lastPrice),
          last: Number(tJson.data.lastPrice),
          ma30,
          price_ts: Date.now()
        });
      } catch (e) {
        results.push({ symbol: sym, error: String(e.message || e) });
      }
    }

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// =====================
// KLINE (RSI 전용)
// =====================
app.get("/api/kline", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").trim();
    if (!symbol) {
      return res.status(400).json({ error: "symbol required" });
    }

    const interval = normalizeKlineInterval(req.query.interval || "Min15");
    const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));

    const msym = mexcContractSymbol(symbol);
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = nowSec - days * 24 * 60 * 60;

    const url =
      `${MEXC_BASE}/api/v1/contract/kline/${encodeURIComponent(msym)}` +
      `?interval=${interval}&start=${startSec}&end=${nowSec}`;

    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json"
      }
    });

    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return res.status(502).json({
        error: "JSON parse fail",
        body_snippet: text.slice(0, 200),
      });
    }

    if (!json?.success || !json?.data?.close) {
      return res.status(502).json({ error: "kline fail", detail: json });
    }

    res.json({
      symbol: msym,
      interval,
      close: json.data.close.map(Number),
      ts: Date.now()
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// =====================
app.listen(PORT, () => {
  console.log("✅ Server running on port", PORT);
});
