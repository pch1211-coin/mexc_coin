// =====================
// Global interval (MA30 / RSI 공통)
// =====================
window.__MA_INTERVAL__ = "Min15";

// =====================
// RSI 계산
// =====================
function calcRSI(closes, period) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - (100 / (1 + rs));
}

// =====================
// RSI fetch
// =====================
async function fetchRSI(symbol, el6, el12, el24) {
  try {
    const url =
      `/api/kline?symbol=${encodeURIComponent(symbol)}` +
      `&interval=${encodeURIComponent(window.__MA_INTERVAL__ || "Min15")}&days=7`;

    const r = await fetch(url);
    const j = await r.json();

    if (!Array.isArray(j.close)) throw new Error("no close");

    const r6  = calcRSI(j.close, 6);
    const r12 = calcRSI(j.close, 12);
    const r24 = calcRSI(j.close, 24);

    el6.textContent  = r6  == null ? "-" : r6.toFixed(2);
    el12.textContent = r12 == null ? "-" : r12.toFixed(2);
    el24.textContent = r24 == null ? "-" : r24.toFixed(2);
  } catch {
    el6.textContent  = "ERR";
    el12.textContent = "ERR";
    el24.textContent = "ERR";
  }
}
