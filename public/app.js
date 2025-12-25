// --------------------
// Storage (Watchlist / Cards)
// --------------------
const KEY_WL = "mexc_watchlist_v1";
const KEY_CARDS = "mexc_cards_v1";

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveJSON(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

function normSymbol(s) {
  s = String(s || "").trim().toUpperCase();
  if (!s) return "";
  if (s.includes("_")) return s;
  if (s.endsWith("USDT")) return s.replace(/USDT$/, "_USDT");
  return s;
}

let watchlist = loadJSON(KEY_WL, ["BTC_USDT", "ETH_USDT", "CORE_USDT", "WLD_USDT"]);
let cards = loadJSON(KEY_CARDS, [
  { id: crypto.randomUUID(), symbol: "BTC_USDT", side:"LONG", entry: 87600, margin: 50, lev: 20, tp: 3, sl: 1, band: 0.3, near: 0.5, priceRef:"fair" },
]);

saveJSON(KEY_WL, watchlist);
saveJSON(KEY_CARDS, cards);

// --------------------
// API helpers
// --------------------
async function api(path) {
  const res = await fetch(path, { cache: "no-store" });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "API fail");
  return json;
}

// --------------------
// Calc (DASH 방식 그대로)
// --------------------
function calcTpSl(entry, tpPct, slPct) {
  const longTP = entry * (1 + tpPct/100);
  const longSL = entry * (1 - slPct/100);
  const shortTP = entry * (1 - tpPct/100);
  const shortSL = entry * (1 + slPct/100);
  return { longTP, longSL, shortTP, shortSL };
}

function calcPnlRoi({ side, entry, price, margin, lev }) {
  const size = margin * lev; // ✅ DASH 방식 유지
  if (!entry || !price || !margin || !lev) return { size: 0, pnl: 0, roi: 0 };

  const frac = (side === "SHORT")
    ? ((entry - price) / entry)
    : ((price - entry) / entry);

  const pnl = size * frac;
  const roi = (pnl / margin) * 100;
  return { size, pnl, roi };
}

function calcTrend(price, ma30, bandPct, prevTrend) {
  if (!price || !ma30) return "NONE";
  const upper = ma30 * (1 + bandPct/100);
  const lower = ma30 * (1 - bandPct/100);
  if (price >= lower && price <= upper) return prevTrend || "NEUTRAL";
  if (price > upper) return "UP";
  if (price < lower) return "DOWN";
  return prevTrend || "NEUTRAL";
}

// --------------------
// UI
// --------------------
const elCards = document.getElementById("cards");

function cardTemplate(c) {
  return `
  <div class="card" data-id="${c.id}">
    <div class="cardHead">
      <div><b>${c.symbol}</b></div>
      <div class="badge" data-role="status">대기</div>
    </div>

    <div class="field">
      <div>
        <label>심볼 (Watchlist)</label>
        <select data-role="symbol"></select>
      </div>
      <div>
        <label>방향 (롱/숏)</label>
        <select data-role="side">
          <option value="LONG">LONG</option>
          <option value="SHORT">SHORT</option>
        </select>
      </div>

      <div class="full">
        <label>진입가 (Entry / Avg Price)</label>
        <input data-role="entry" type="number" step="any" />
      </div>

      <div>
        <label>투자금(USDT) = Margin</label>
        <input data-role="margin" type="number" step="any" />
      </div>
      <div>
        <label>레버리지</label>
        <select data-role="lev">
          ${[1,2,3,5,10,15,20,25,30,35,40,45,50].map(v=>`<option value="${v}">${v}</option>`).join("")}
        </select>
      </div>

      <div>
        <label>목표수익(%)</label>
        <input data-role="tp" type="number" step="any" />
      </div>
      <div>
        <label>손절(%)</label>
        <input data-role="sl" type="number" step="any" />
      </div>

      <div>
        <label>밴드(%) (트렌드)</label>
        <input data-role="band" type="number" step="any" />
      </div>
      <div>
        <label>근접기준(%)</label>
        <input data-role="near" type="number" step="any" />
      </div>

      <div class="full">
        <label>현재가 기준</label>
        <select data-role="priceRef">
          <option value="fair">Fair Price (권장)</option>
          <option value="last">Last Price</option>
        </select>
      </div>
    </div>

    <hr/>

    <div class="kv" data-role="out"></div>
    <div class="small" data-role="meta"></div>

    <hr/>
    <div class="row">
      <button data-role="remove">카드 삭제</button>
      <button data-role="refresh">즉시 갱신</button>
    </div>
  </div>`;
}

function render() {
  elCards.innerHTML = cards.map(cardTemplate).join("");
  for (const c of cards) {
    const root = elCards.querySelector(`.card[data-id="${c.id}"]`);

    // symbol dropdown
    const selSym = root.querySelector('[data-role="symbol"]');
    selSym.innerHTML = watchlist.map(s=>`<option value="${s}">${s}</option>`).join("");
    selSym.value = c.symbol;

    root.querySelector('[data-role="side"]').value = c.side;
    root.querySelector('[data-role="entry"]').value = c.entry ?? "";
    root.querySelector('[data-role="margin"]').value = c.margin ?? "";
    root.querySelector('[data-role="lev"]').value = String(c.lev ?? 20);
    root.querySelector('[data-role="tp"]').value = c.tp ?? 3;
    root.querySelector('[data-role="sl"]').value = c.sl ?? 1;
    root.querySelector('[data-role="band"]').value = c.band ?? 0.3;
    root.querySelector('[data-role="near"]').value = c.near ?? 0.5;
    root.querySelector('[data-role="priceRef"]').value = c.priceRef ?? "fair";

    // handlers
    root.addEventListener("input", () => syncFromUI(c.id));
    root.addEventListener("change", () => syncFromUI(c.id));

    root.querySelector('[data-role="remove"]').onclick = () => {
      cards = cards.filter(x=>x.id !== c.id);
      saveJSON(KEY_CARDS, cards);
      render();
    };
    root.querySelector('[data-role="refresh"]').onclick = () => tickOne(c.id, true);
  }
}

function syncFromUI(id) {
  const c = cards.find(x=>x.id === id);
  if (!c) return;
  const root = elCards.querySelector(`.card[data-id="${id}"]`);
  c.symbol = normSymbol(root.querySelector('[data-role="symbol"]').value);
  c.side = root.querySelector('[data-role="side"]').value;
  c.entry = Number(root.querySelector('[data-role="entry"]').value) || 0;
  c.margin = Number(root.querySelector('[data-role="margin"]').value) || 0;
  c.lev = Number(root.querySelector('[data-role="lev"]').value) || 1;
  c.tp = Number(root.querySelector('[data-role="tp"]').value) || 0;
  c.sl = Number(root.querySelector('[data-role="sl"]').value) || 0;
  c.band = Number(root.querySelector('[data-role="band"]').value) || 0.3;
  c.near = Number(root.querySelector('[data-role="near"]').value) || 0.5;
  c.priceRef = root.querySelector('[data-role="priceRef"]').value;

  saveJSON(KEY_CARDS, cards);
  // 입력만 바뀐 경우 즉시 재계산(가격은 기존값으로)
  paintCard(id);
}

// --------------------
// Data state per card
// --------------------
const state = new Map(); // id -> { ticker, ma30, rsi14, prevTrend, lastMAts }

async function tickOne(id, force=false) {
  const c = cards.find(x=>x.id === id);
  if (!c) return;
  const st = state.get(id) || { prevTrend: "" };

  try {
    const t = await api(`/api/ticker?symbol=${encodeURIComponent(c.symbol)}`);
    st.ticker = t;

    // MA/RSI는 5분 캐시지만, “처음”이면 같이 가져옴
    if (force || !st.ma30) {
      const m = await api(`/api/ma30?symbol=${encodeURIComponent(c.symbol)}`);
      st.ma30 = m;
      st.lastMAts = m.ts;
    }
    if (force || !st.rsi14) {
      const r = await api(`/api/rsi14?symbol=${encodeURIComponent(c.symbol)}`);
      st.rsi14 = r;
    }

    state.set(id, st);
    paintCard(id);
  } catch (e) {
    paintError(id, String(e.message || e));
  }
}

function paintError(id, msg) {
  const root = elCards.querySelector(`.card[data-id="${id}"]`);
  if (!root) return;
  root.querySelector('[data-role="status"]').className = "badge err";
  root.querySelector('[data-role="status"]').textContent = "가격/지표 오류";
  root.querySelector('[data-role="out"]').innerHTML = `<div class="err">${msg}</div>`;
  root.querySelector('[data-role="meta"]').textContent = "";
}

function paintCard(id) {
  const c = cards.find(x=>x.id === id);
  const st = state.get(id);
  const root = elCards.querySelector(`.card[data-id="${id}"]`);
  if (!c || !root) return;

  const ticker = st?.ticker;
  const ma30 = st?.ma30?.ma30 || 0;
  const rsi14 = st?.rsi14?.rsi14 || 0;

  if (!ticker) return;

  const price = (c.priceRef === "last") ? ticker.last : ticker.fair;

  // trend
  const trend = calcTrend(price, ma30, c.band ?? 0.3, st.prevTrend);
  st.prevTrend = trend;
  state.set(id, st);

  const trendText = trend === "UP" ? `<span class="red">상승 추세</span>`
    : trend === "DOWN" ? `<span class="blue">하락 추세</span>`
    : trend === "NEUTRAL" ? `중립` : `-`;

  // TP/SL
  const { longTP, longSL, shortTP, shortSL } = calcTpSl(c.entry, c.tp, c.sl);
  const tp = (c.side === "SHORT") ? shortTP : longTP;
  const sl = (c.side === "SHORT") ? shortSL : longSL;

  // near/cross status
  const nearPct = c.near || 0.5;
  const nearTP = Math.abs(price - tp) / price * 100 <= nearPct;
  const nearSL = Math.abs(price - sl) / price * 100 <= nearPct;

  const hitTP = (c.side === "LONG") ? price >= tp : price <= tp;
  const hitSL = (c.side === "LONG") ? price <= sl : price >= sl;

  let status = "정상";
  let badgeClass = "badge ok";
  if (hitTP || hitSL) {
    status = hitTP ? "전환 확정(TP 터치/돌파)" : "전환 확정(SL 터치/돌파)";
    badgeClass = "badge err";
  } else if (nearTP || nearSL) {
    status = nearTP ? "전환 근접(TP 근접)" : "전환 근접(SL 근접)";
    badgeClass = "badge";
  }

  // PnL/ROI (DASH 방식 그대로)
  const { size, pnl, roi } = calcPnlRoi({
    side: c.side, entry: c.entry, price,
    margin: c.margin, lev: c.lev
  });

  const pnlColor = pnl >= 0 ? "red" : "blue";
  const roiColor = roi >= 0 ? "red" : "blue";

  root.querySelector('[data-role="status"]').className = badgeClass;
  root.querySelector('[data-role="status"]').textContent = status;

  root.querySelector('[data-role="out"]').innerHTML = `
    <div>현재가: <b>${price.toFixed(6)}</b> (${c.priceRef})</div>
    <div>MA30: <b>${ma30 ? ma30.toFixed(6) : "-"}</b></div>
    <div>RSI14: <b>${rsi14 ? rsi14.toFixed(2) : "-"}</b></div>
    <div>트렌드: <b>${trendText}</b></div>
    <hr/>
    <div>Long TP/SL: ${longTP.toFixed(6)} / ${longSL.toFixed(6)}</div>
    <div>Short TP/SL: ${shortTP.toFixed(6)} / ${shortSL.toFixed(6)}</div>
    <div>선택방향 TP/SL: <b>${tp.toFixed(6)}</b> / <b>${sl.toFixed(6)}</b></div>
    <hr/>
    <div>Size(USDT) = ${size.toFixed(2)}</div>
    <div class="${pnlColor}">예상마진(USDT)(PnL): ${pnl.toFixed(6)}</div>
    <div class="${roiColor}">ROI(%): ${roi.toFixed(6)}</div>
  `;

  const upd = new Date(ticker.ts).toLocaleTimeString();
  const maTs = st?.lastMAts ? new Date(st.lastMAts).toLocaleTimeString() : "-";
  root.querySelector('[data-role="meta"]').textContent =
    `업데이트: ${upd} / MA·RSI 마지막 갱신: ${maTs}`;
}

// --------------------
// Watchlist modal
// --------------------
const wlModal = document.getElementById("wlModal");
const wlList = document.getElementById("wlList");
const wlInput = document.getElementById("wlInput");

document.getElementById("btnWatchlist").onclick = () => openWl();
document.getElementById("btnCloseWl").onclick = () => closeWl();
wlModal.addEventListener("click", (e)=>{ if (e.target === wlModal) closeWl(); });

document.getElementById("btnAddSymbol").onclick = () => {
  const s = normSymbol(wlInput.value);
  if (!s) return;
  if (!watchlist.includes(s)) watchlist.push(s);
  watchlist.sort();
  saveJSON(KEY_WL, watchlist);
  wlInput.value = "";
  renderWl();
  render(); // dropdown 갱신
};

function renderWl() {
  wlList.innerHTML = watchlist.map(s => `
    <div class="wlItem">
      <span>${s}</span>
      <button data-del="${s}">삭제</button>
    </div>
  `).join("");

  wlList.querySelectorAll("button[data-del]").forEach(btn=>{
    btn.onclick = () => {
      const sym = btn.getAttribute("data-del");
      watchlist = watchlist.filter(x=>x !== sym);
      saveJSON(KEY_WL, watchlist);
      // 카드가 이 심볼을 쓰고 있으면 BTC_USDT로 대체
      for (const c of cards) {
        if (c.symbol === sym) c.symbol = watchlist[0] || "BTC_USDT";
      }
      saveJSON(KEY_CARDS, cards);
      renderWl();
      render();
    };
  });
}

function openWl() {
  renderWl();
  wlModal.setAttribute("aria-hidden", "false");
}
function closeWl() {
  wlModal.setAttribute("aria-hidden", "true");
}

// --------------------
// Add card + loop
// --------------------
document.getElementById("btnAddCard").onclick = () => {
  const sym = watchlist[0] || "BTC_USDT";
  cards.push({
    id: crypto.randomUUID(),
    symbol: sym,
    side: "LONG",
    entry: 0,
    margin: 10,
    lev: 20,
    tp: 3,
    sl: 1,
    band: 0.3,
    near: 0.5,
    priceRef: "fair"
  });
  saveJSON(KEY_CARDS, cards);
  render();
};

// main
render();

// initial tick
for (const c of cards) tickOne(c.id, true);

// price refresh loop (5초)
setInterval(() => {
  for (const c of cards) tickOne(c.id, false);
}, 5000);

// heavy indicators refresh loop (5분)
setInterval(() => {
  for (const c of cards) tickOne(c.id, true);
}, 5 * 60 * 1000);