// ====== Config ======
const TREND_BAND_PCT = 0.3;
const REFRESH_MS = 3000;
const IND_CACHE_NOTE = "RSI+MA30=60s 캐시";

const DEFAULT_WATCHLIST = [
  "BTCUSDT","ETHUSDT","COREUSDT","WLDUSDT","PIUSDT","DOGEUSDT","XRPUSDT","TRXUSDT"
];
const LEV_OPTIONS = [1,3,5,10,15,20,25,30,35,40,45,50];
const SLOT_COUNT = 12;

// ====== Storage ======
function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || ""); } catch { return fallback; }
}
function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

function normSymForUI(s){ return String(s||"").trim().toUpperCase(); }
function toContractSym(sym){
  const s = normSymForUI(sym);
  if (!s) return "";
  if (s.includes("_")) return s;
  if (s.endsWith("USDT")) return s.replace(/USDT$/, "_USDT");
  return s;
}

// ====== Global Settings ======
let tfMin = Number(loadJSON("tfMin", 15)) || 15;
let soundOn = loadJSON("soundOn", true);
let nearShowMin = Number(loadJSON("nearShowMin", 3)) || 3;
let confirmShowMin = Number(loadJSON("confirmShowMin", 5)) || 5;
let nearPctGlobal = Number(loadJSON("nearPctGlobal", 0.15)) || 0.15;
let confirmPctGlobal = Number(loadJSON("confirmPctGlobal", 0.30)) || 0.30;

// ====== State ======
let watchlist = loadJSON("wl", null);
if (!Array.isArray(watchlist) || watchlist.length === 0) {
  watchlist = DEFAULT_WATCHLIST.map(normSymForUI);
  saveJSON("wl", watchlist);
}

let slots = loadJSON("slots", null);
if (!Array.isArray(slots) || slots.length !== SLOT_COUNT) {
  slots = Array.from({ length: SLOT_COUNT }, (_, i) => watchlist[i % watchlist.length]);
  saveJSON("slots", slots);
}

let inputsMap = loadJSON("inputsMap", {});
function ensureInputs(sym){
  const s = normSymForUI(sym);
  inputsMap[s] ||= {
    margin: 5.8,
    leverage: 20,
    entry: 0,
    side: "SHORT",
    tp_pct: 1.5,
    sl_pct: 0.7,
    near_pct: 0.5
  };
  return inputsMap[s];
}
function saveAll(){
  saveJSON("wl", watchlist);
  saveJSON("slots", slots);
  saveJSON("inputsMap", inputsMap);
  saveJSON("tfMin", tfMin);
  saveJSON("soundOn", soundOn);
  saveJSON("nearShowMin", nearShowMin);
  saveJSON("confirmShowMin", confirmShowMin);
  saveJSON("nearPctGlobal", nearPctGlobal);
  saveJSON("confirmPctGlobal", confirmPctGlobal);
}

// ====== Utils ======
function fmt(n, d=6){
  const x = Number(n);
  if (!isFinite(x)) return "-";
  if (Math.abs(x) >= 1000) return x.toFixed(2);
  return x.toFixed(d).replace(/0+$/,"").replace(/\.$/,"");
}

function calcTrend(price, ma30){
  if (!price || !ma30) return "NONE";
  const upper = ma30 * (1 + TREND_BAND_PCT / 100);
  const lower = ma30 * (1 - TREND_BAND_PCT / 100);
  if (price > upper) return "UP";
  if (price < lower) return "DOWN";
  return "NEUTRAL";
}

// ====== UI refs ======
const grid = document.getElementById("grid");
const syncInfo = document.getElementById("syncInfo");

// ====== Render ======
function renderCard(i){
  const sym = normSymForUI(slots[i]);
  const inp = ensureInputs(sym);

  const card = document.createElement("div");
  card.className = "card";
  card.id = `card_${i}`;

  const options = watchlist.map(s=>{
    const sel = (s===sym)?"selected":"";
    return `<option value="${s}" ${sel}>${s}</option>`;
  }).join("");

  const levOpts = LEV_OPTIONS.map(v=>{
    const sel = Number(inp.leverage)===v?"selected":"";
    return `<option value="${v}" ${sel}>${v}x</option>`;
  }).join("");

  card.innerHTML = `
    <div class="row">
      <div class="title">슬롯 ${i+1}</div>
      <span class="pill neutral" id="trend_${i}">트렌드: -</span>
    </div>

    <label>심볼</label>
    <select id="sym_${i}">${options}</select>

    <div class="priceRow">
      <div class="priceBox">
        <div class="big" id="price_${i}">현재가(Fair): -</div>
        <div class="muted" id="ma30_${i}">MA30: -</div>
        <div class="muted" id="hl24_${i}">24h High: - / 24h Low: -</div>
      </div>
      <div class="rsiBox">
        RSI(6): <span id="rsi6_${i}">-</span><br/>
        RSI(12): <span id="rsi12_${i}">-</span><br/>
        RSI(24): <span id="rsi24_${i}">-</span>
      </div>
    </div>

    <label>투자금(USDT)</label>
    <input id="margin_${i}" value="${inp.margin}"/>

    <label>레버리지</label>
    <select id="lev_${i}">${levOpts}</select>

    <label>진입가</label>
    <input id="entry_${i}" value="${inp.entry}"/>

    <label>방향</label>
    <select id="side_${i}">
      <option ${inp.side==="LONG"?"selected":""}>LONG</option>
      <option ${inp.side==="SHORT"?"selected":""}>SHORT</option>
    </select>

    <div class="muted" id="meta_${i}">—</div>
  `;
  return card;
}

function renderAll(){
  grid.innerHTML = "";
  for(let i=0;i<SLOT_COUNT;i++) grid.appendChild(renderCard(i));
}
renderAll();

// ====== Refresh ======
async function refresh(){
  try{
    const uniq = [...new Set(slots.map(normSymForUI).filter(Boolean))];
    const qs = new URLSearchParams({ symbols: uniq.join(","), tf: tfMin });
    const res = await fetch(`/api/quote_batch?${qs}`);
    const json = await res.json();

    const map = new Map();
    json.results.forEach(r=>map.set(normSymForUI(r.symbol), r));

    syncInfo.textContent = `갱신: ${new Date().toLocaleTimeString()} / TF=15분`;

    for(let i=0;i<SLOT_COUNT;i++){
      const sym = normSymForUI(slots[i]);
      const q = map.get(sym) || map.get(toContractSym(sym));

      const priceEl = document.getElementById(`price_${i}`);
      const maEl = document.getElementById(`ma30_${i}`);
      const hlEl = document.getElementById(`hl24_${i}`);
      const r6 = document.getElementById(`rsi6_${i}`);
      const r12 = document.getElementById(`rsi12_${i}`);
      const r24 = document.getElementById(`rsi24_${i}`);
      const trendEl = document.getElementById(`trend_${i}`);
      const metaEl = document.getElementById(`meta_${i}`);

      if(!q || q.error){
        priceEl.textContent = "현재가(Fair): -";
        maEl.textContent = "MA30: -";
        hlEl.textContent = "24h High: - / 24h Low: -";
        r6.textContent = r12.textContent = r24.textContent = "ERR";
        metaEl.textContent = q?.error || "데이터 없음";
        continue;
      }

      priceEl.textContent = `현재가(Fair): ${fmt(q.fair,6)}`;
      maEl.textContent = `MA30: ${fmt(q.ma30,6)} (15분)`;
      hlEl.textContent =
        `24h High: ${fmt(q.high24,6)} / 24h Low: ${fmt(q.low24,6)}`;

      r6.textContent = fmt(q.rsi6,2);
      r12.textContent = fmt(q.rsi12,2);
      r24.textContent = fmt(q.rsi24,2);

      const t = calcTrend(q.fair, q.ma30);
      trendEl.className = `pill ${t==="UP"?"up":t==="DOWN"?"down":"neutral"}`;
      trendEl.textContent = `트렌드: ${t==="UP"?"상승":t==="DOWN"?"하락":"중립"}`;

      metaEl.textContent = `price_ts=${new Date(q.price_ts).toLocaleTimeString()}`;
    }
  }catch(e){
    syncInfo.textContent = "갱신 오류";
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
