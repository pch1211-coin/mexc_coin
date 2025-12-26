// server.js
import express from "express";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static("public"));

// ---- Helpers ----
function normSymbol(sym) {
  const s = String(sym || "").trim().toUpperCase();
  if (!s) return "";
  if (s.includes("_")) return s;
  if (s.endsWith("USDT")) return s.replace(/USDT$/, "_USDT");
  return s;
}

// ---- API: Ticker (fair/last/index) ----
// GET /api/ticker?symbol=BTC_USDT
app.get("/api/ticker", async (req, res) => {
  try {
    const symbol = normSymbol(req.query.symbol);
    if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });

    const url = `https://contract.mexc.com/api/v1/contract/ticker?symbol=${encodeURIComponent(symbol)}`;
    const r = await fetch(url, { headers: { "User-Agent": "mexc-dashboard/1.0" } });
    const j = await r.json();

    if (!j?.success || !j?.data) {
      return res.status(502).json({ ok: false, error: j?.message || "ticker fail", raw: j });
    }

    const last = Number(j.data.lastPrice);
    const fair = Number(j.data.fairPrice ?? j.data.fair_price ?? last);
    const index = Number(j.data.indexPrice ?? j.data.index_price ?? NaN);

    return res.json({
      ok: true,
      symbol,
      last,
      fair,
      index: Number.isFinite(index) ? index : null,
      ts: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---- API: MA30 (Day1 close avg 30) ----
// GET /api/ma30?symbol=BTC_USDT
app.get("/api/ma30", async (req, res) => {
  try {
    const symbol = normSymbol(req.query.symbol);
    if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });

    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = nowSec - 60 * 24 * 60 * 60; // 60일치 정도(여유)
    const url = `https://contract.mexc.com/api/v1/contract/kline/${encodeURIComponent(symbol)}?interval=Day1&start=${startSec}&end=${nowSec}`;

    const r = await fetch(url, { headers: { "User-Agent": "mexc-dashboard/1.0" } });
    const j = await r.json();

    if (!j?.success || !j?.data?.close) {
      return res.status(502).json({ ok: false, error: j?.message || "kline fail", raw: j });
    }

    const closes = j.data.close.map(Number).filter((v) => Number.isFinite(v));
    if (closes.length < 30) return res.status(400).json({ ok: false, error: "not enough candles" });

    const last30 = closes.slice(-30);
    const ma30 = last30.reduce((a, b) => a + b, 0) / 30;

    return res.json({ ok: true, symbol, ma30, ts: Date.now() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/health", (_, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
