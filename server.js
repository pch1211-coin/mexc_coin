const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

/** 심볼 변환: BTCUSDT -> BTC_USDT */
function toMexcContractSymbol(sym) {
  const s = String(sym || "").trim().toUpperCase();
  if (!s) return "";
  if (s.includes("_")) return s;
  if (s.endsWith("USDT")) return s.replace(/USDT$/, "_USDT");
  return s;
}

/** MEXC 계약 티커 */
async function fetchContractTicker(symbol) {
  const msym = toMexcContractSymbol(symbol);
  const url = `https://contract.mexc.com/api/v1/contract/ticker?symbol=${encodeURIComponent(msym)}`;
  const response = await fetch(url);
  const json = await response.json();
  if (!json || json.success !== true || !json.data) {
    throw new Error(json?.message || "MEXC ticker fail");
  }
  const last = Number(json.data.lastPrice);
  const fair = Number(json.data.fairPrice ?? json.data.fair_price ?? last);
  const index = Number(json.data.indexPrice ?? json.data.index_price ?? NaN);

  if (!isFinite(fair)) throw new Error("fairPrice invalid");
  return { msym, last, fair, index };
}

/**
 * ✅ DASH 방식 계산 (예전 방식 유지)
 * - Margin(투자금) = 사용자가 입력
 * - Leverage = 사용자가 입력
 * - Size(USDT) = Margin * Leverage
 * - frac = (price-entry)/entry (LONG), (entry-price)/entry (SHORT)
 * - PnL(USDT) = Size * frac
 * - ROI(%) = (PnL / Margin) * 100
 */
function calcDashPnlRoi({ side, entry, price, margin, leverage }) {
  const _side = String(side || "LONG").toUpperCase();
  const _entry = Number(entry);
  const _price = Number(price);
  const _margin = Number(margin);
  const _lev = Math.max(1, Number(leverage) || 1);

  if (!isFinite(_entry) || _entry <= 0) return { ok: false, msg: "진입가(entry) 오류" };
  if (!isFinite(_price) || _price <= 0) return { ok: false, msg: "현재가(price) 오류" };
  if (!isFinite(_margin) || _margin <= 0) return { ok: false, msg: "투자금(margin) 오류" };

  const size = _margin * _lev;

  const frac = (_side === "SHORT")
    ? ((_entry - _price) / _entry)
    : ((_price - _entry) / _entry);

  const pnl = size * frac;
  const roi = (pnl / _margin) * 100;

  return {
    ok: true,
    sizeUsdt: size,
    frac,
    pnlUsdt: pnl,
    roiPct: roi
  };
}

/** 가격만 */
app.get("/api/price", async (req, res) => {
  try {
    const symbol = req.query.symbol || "BTC_USDT";
    const t = await fetchContractTicker(symbol);
    res.json({
      symbol: t.msym,
      last: t.last,
      fair: t.fair,
      index: isFinite(t.index) ? t.index : null,
      ts: Date.now()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 가격 + DASH 계산 */
app.post("/api/calc", async (req, res) => {
  try {
    const { symbol, side, entry, margin, leverage, priceType } = req.body || {};
    const t = await fetchContractTicker(symbol || "BTC_USDT");

    // ✅ DASH와 동일하게 "현재가=Fair" 기준 권장 (원하면 last로도 가능)
    const px = (String(priceType || "fair").toLowerCase() === "last") ? t.last : t.fair;

    const result = calcDashPnlRoi({
      side: side || "LONG",
      entry,
      price: px,
      margin,
      leverage
    });

    if (!result.ok) return res.status(400).json(result);

    res.json({
      ok: true,
      symbol: t.msym,
      side: String(side || "LONG").toUpperCase(),
      entry: Number(entry),
      margin: Number(margin),
      leverage: Number(leverage),
      priceType: (String(priceType || "fair").toLowerCase() === "last") ? "last" : "fair",
      price: px,
      last: t.last,
      fair: t.fair,
      ts: Date.now(),
      ...result
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
