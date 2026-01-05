기존 app



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

function calcTrend(price, ma30, prevTrend){
  if (!price || !ma30) return "NONE";
  const upper = ma30 * (1 + TREND_BAND_PCT / 100);
  const lower = ma30 * (1 - TREND_BAND_PCT / 100);
  if (price <= upper && price >= lower) return prevTrend || "NEUTRAL";
  if (price > upper) return "UP";
  if (price < lower) return "DOWN";
  return prevTrend || "NEUTRAL";
}

function validateTpSl(tp, sl){
  if (!isFinite(tp) || !isFinite(sl)) return { ok:false, msg:"TP/SL 값 오류" };
  if (tp <= 0 || sl <= 0) return { ok:false, msg:"TP/SL은 0보다 커야 함" };
  if (tp > 50 || sl > 50) return { ok:false, msg:"TP/SL%가 너무 큼(>50%)" };
  const warn = tp < sl * 1.3;
  return { ok:true, warn, msg: warn ? "권장: 목표수익 ≥ 손절×1.3" : "" };
}

// ====== Sound ======
function beep(times=1){
  if (!soundOn) return;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;

  const ctx = new AudioCtx();
  let t = ctx.currentTime;

  for (let i=0;i<times;i++){
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.value = 0.12;
    o.connect(g); g.connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.08);
    t += 0.12;
  }
  setTimeout(()=>ctx.close().catch(()=>{}), 400);
}

// ====== Highlight timers ======
const slotMarks = Array.from({length:SLOT_COUNT}, ()=>({
  nearUntil: 0,
  confirmUntil: 0,
  lastNearKey: "",
  lastConfirmKey: ""
}));

function markNear(i, key){
  const now = Date.now();
  const until = now + nearShowMin * 60 * 1000;
  if (slotMarks[i].lastNearKey !== key){
    beep(1);
    slotMarks[i].lastNearKey = key;
  }
  slotMarks[i].nearUntil = Math.max(slotMarks[i].nearUntil, until);
}

function markConfirm(i, key){
  const now = Date.now();
  const until = now + confirmShowMin * 60 * 1000;
  if (slotMarks[i].lastConfirmKey !== key){
    beep(3);
    slotMarks[i].lastConfirmKey = key;
  }
  slotMarks[i].confirmUntil = Math.max(slotMarks[i].confirmUntil, until);
}

// ====== UI refs ======
const grid = document.getElementById("grid");
const syncInfo = document.getElementById("syncInfo");

// header controls
const tfSel = document.getElementById("tfSel");
const nearShowSel = document.getElementById("nearShowSel");
const confirmShowSel = document.getElementById("confirmShowSel");
const nearPctEl = document.getElementById("nearPct");
const confirmPctEl = document.getElementById("confirmPct");
const soundBtn = document.getElementById("soundBtn");

// drawer
const drawer = document.getElementById("drawer");
const btnWatch = document.getElementById("btnWatch");
const btnClose = document.getElementById("btnClose");
const backdrop = document.getElementById("backdrop");
const wlInput = document.getElementById("wlInput");
const wlAdd = document.getElementById("wlAdd");
const wlList = document.getElementById("wlList");
const btnReset = document.getElementById("btnReset");

// init header UI
tfSel.value = String(tfMin);
nearShowSel.value = String(nearShowMin);
confirmShowSel.value = String(confirmShowMin);
nearPctEl.value = String(nearPctGlobal);
confirmPctEl.value = String(confirmPctGlobal);
soundBtn.textContent = soundOn ? "🔊 ON" : "🔇 OFF";

tfSel.onchange = () => { tfMin = Number(tfSel.value)||15; saveAll(); };
nearShowSel.onchange = () => { nearShowMin = Number(nearShowSel.value)||3; saveAll(); };
confirmShowSel.onchange = () => { confirmShowMin = Number(confirmShowSel.value)||5; saveAll(); };
nearPctEl.onchange = () => { nearPctGlobal = Number(nearPctEl.value)||0.15; saveAll(); };
confirmPctEl.onchange = () => { confirmPctGlobal = Number(confirmPctEl.value)||0.30; saveAll(); };

soundBtn.onclick = async () => {
  soundOn = !soundOn;
  soundBtn.textContent = soundOn ? "🔊 ON" : "🔇 OFF";
  saveAll();
  if (soundOn) beep(1);
};

// drawer
btnWatch.onclick = () => { drawer.classList.add("open"); renderWatchlist(); };
btnClose.onclick = () => drawer.classList.remove("open");
backdrop.onclick = () => drawer.classList.remove("open");

wlAdd.onclick = () => {
  const v = normSymForUI(wlInput.value);
  if (!v) return;
  if (!watchlist.includes(v)) watchlist.unshift(v);
  wlInput.value = "";
  saveAll();
  renderAll();
  renderWatchlist();
};

btnReset.onclick = () => {
  slots = Array.from({ length: SLOT_COUNT }, (_, i) => watchlist[i % watchlist.length]);
  saveAll();
  renderAll();
};

function renderWatchlist(){
  wlList.innerHTML = "";
  watchlist.forEach(sym => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `<code>${sym}</code><button class="xbtn">삭제</button>`;
    row.querySelector("button").onclick = () => {
      watchlist = watchlist.filter(s => s !== sym);
      if (watchlist.length === 0) watchlist = DEFAULT_WATCHLIST.slice();
      slots = slots.map(s => (s === sym ? watchlist[0] : s));
      saveAll();
      renderAll();
      renderWatchlist();
    };
    wlList.appendChild(row);
  });
}

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

    <label>심볼 (와치리스트 드롭다운)</label>
    <select id="sym_${i}">${options}</select>

    <div class="priceRow" style="margin-top:8px">
      <div class="priceBox">
        <div class="big" id="price_${i}">현재가(Fair): -</div>
        <div class="muted" id="ma30_${i}">MA30: -</div>
      </div>
      <div class="rsiBox">
        RSI(6): <span id="rsi6_${i}">-</span><br/>
        RSI(12): <span id="rsi12_${i}">-</span><br/>
        RSI(24): <span id="rsi24_${i}">-</span>
      </div>
    </div>

    <label>투자금(USDT)=마진(Margin)</label>
    <input id="margin_${i}" type="number" step="0.01" value="${inp.margin}"/>

    <label>레버리지</label>
    <select id="lev_${i}">${levOpts}</select>

    <label>진입가(직접입력)</label>
    <input id="entry_${i}" type="number" step="0.000001" value="${inp.entry}"/>

    <label>방향(LONG/SHORT)</label>
    <select id="side_${i}">
      <option value="LONG" ${inp.side==="LONG"?"selected":""}>LONG</option>
      <option value="SHORT" ${inp.side==="SHORT"?"selected":""}>SHORT</option>
    </select>

    <div class="row" style="margin-top:8px;gap:8px">
      <div style="flex:1">
        <label>목표수익(%)</label>
        <input id="tp_${i}" type="number" step="0.1" value="${inp.tp_pct}"/>
      </div>
      <div style="flex:1">
        <label>손절(%)</label>
        <input id="sl_${i}" type="number" step="0.1" value="${inp.sl_pct}"/>
      </div>
    </div>

    <label>근접기준(%)</label>
    <input id="near_${i}" type="number" step="0.1" value="${inp.near_pct}"/>

    <div style="margin-top:10px" class="row">
      <span class="pill neutral" id="status_${i}">상태: -</span>
      <span class="pill neutral" id="reco_${i}">추천: -</span>
    </div>

    <div style="margin-top:10px">
      <div>Long TP: <b id="ltp_${i}">-</b> / Long SL: <b id="lsl_${i}">-</b></div>
      <div>Short TP: <b id="stp_${i}">-</b> / Short SL: <b id="ssl_${i}">-</b></div>
    </div>

    <div style="margin-top:10px">
      <div>예상마진(PnL USDT): <b id="pnl_${i}" class="pnl">-</b></div>
      <div>ROI(%): <b id="roi_${i}">-</b></div>
      <div class="muted" id="meta_${i}">—</div>
    </div>
  `;

  // handlers
  card.querySelector(`#sym_${i}`).onchange = (e)=>{
    slots[i] = normSymForUI(e.target.value);
    saveAll();
    renderAll();
  };

  const bindNum = (id,key)=>{
    card.querySelector(id).onchange = (e)=>{
      const s = ensureInputs(sym);
      s[key] = Number(e.target.value);
      inputsMap[sym]=s;
      saveAll();
    };
  };
  const bindStr = (id,key)=>{
    card.querySelector(id).onchange = (e)=>{
      const s = ensureInputs(sym);
      s[key] = String(e.target.value).toUpperCase();
      inputsMap[sym]=s;
      saveAll();
    };
  };

  bindNum(`#margin_${i}`,"margin");
  bindNum(`#entry_${i}`,"entry");
  bindNum(`#tp_${i}`,"tp_pct");
  bindNum(`#sl_${i}`,"sl_pct");
  bindNum(`#near_${i}`,"near_pct");

  card.querySelector(`#lev_${i}`).onchange = (e)=>{
    const s=ensureInputs(sym);
    s.leverage = Number(e.target.value);
    inputsMap[sym]=s;
    saveAll();
  };
  bindStr(`#side_${i}`,"side");

  return card;
}

function renderAll(){
  grid.innerHTML = "";
  for(let i=0;i<SLOT_COUNT;i++){
    grid.appendChild(renderCard(i));
  }
}
renderAll();

// ====== Live refresh ======
async function refresh(){
  try{
    const uniqSyms = [...new Set(slots.map(normSymForUI).filter(Boolean))];
    const qs = new URLSearchParams({ symbols: uniqSyms.join(","), tf: String(tfMin) });

    const res = await fetch(`/api/quote_batch?${qs.toString()}`);
    const json = await res.json();
    if(!res.ok) throw new Error(json?.error || "API error");

    const map = new Map();
    (json.results||[]).forEach(r=>map.set(normSymForUI(r.symbol), r));

    const now = new Date();
    syncInfo.textContent = `갱신: ${now.toLocaleTimeString()} / TF=Min${tfMin} / ${IND_CACHE_NOTE}`;

    for(let i=0;i<SLOT_COUNT;i++){
      const symUI = normSymForUI(slots[i]);
      const symC = toContractSym(symUI);
      const q = map.get(symC) || map.get(symUI) || null;

      const card = document.getElementById(`card_${i}`);
      const priceEl = document.getElementById(`price_${i}`);
      const maEl = document.getElementById(`ma30_${i}`);
      const trendEl = document.getElementById(`trend_${i}`);
      const statusEl = document.getElementById(`status_${i}`);
      const recoEl = document.getElementById(`reco_${i}`);
      const metaEl = document.getElementById(`meta_${i}`);

      const r6El = document.getElementById(`rsi6_${i}`);
      const r12El = document.getElementById(`rsi12_${i}`);
      const r24El = document.getElementById(`rsi24_${i}`);

      // highlight reset (시간 지나면 자동 해제)
      const nowMs = Date.now();
      card.classList.remove("near","confirm","long","short");
      if (slotMarks[i].nearUntil > nowMs) card.classList.add("near");
      if (slotMarks[i].confirmUntil > nowMs) {
        card.classList.add("confirm");
        // 마지막 컨펌 방향은 status에서 결정되도록 아래에서 다시 세팅
      }

      if(!q || q.error){
        priceEl.textContent = `현재가(Fair): -`;
        maEl.textContent = `MA30: -`;
        trendEl.className = "pill neutral";
        trendEl.textContent = "트렌드: -";
        statusEl.className = "pill neutral";
        statusEl.textContent = "상태: -";
        recoEl.className = "pill warn";
        recoEl.textContent = `추천: 오류`;
        metaEl.textContent = q?.error ? `에러: ${q.error}` : "데이터 없음";

        r6El.textContent = "ERR";
        r12El.textContent = "ERR";
        r24El.textContent = "ERR";
        continue;
      }

      const inp = ensureInputs(symUI);
      const margin = Number(inp.margin)||0;
      const lev = Math.max(1, Number(inp.leverage)||1);
      const entry = Number(inp.entry)||0;
      const side = String(inp.side||"LONG").toUpperCase();
      const tpPct = Number(inp.tp_pct)||1.5;
      const slPct = Number(inp.sl_pct)||0.7;
      const nearPct = Number(inp.near_pct)||0.5;

      const price = Number(q.fair);
      const ma30 = Number(q.ma30);

      priceEl.textContent = `현재가(Fair): ${fmt(price,6)}`;
      maEl.textContent = `MA30: ${fmt(ma30,6)} (${tfMin}분)`;

      // RSI (겹침 방지: textContent로만 세팅)
      r6El.textContent = isFinite(q.rsi6) ? fmt(q.rsi6,2) : "-";
      r12El.textContent = isFinite(q.rsi12) ? fmt(q.rsi12,2) : "-";
      r24El.textContent = isFinite(q.rsi24) ? fmt(q.rsi24,2) : "-";

      // Trend pill
      const t = calcTrend(price, ma30, null);
      trendEl.className = `pill ${t==="UP"?"up":t==="DOWN"?"down":"neutral"}`;
      trendEl.textContent = `트렌드: ${t==="UP"?"상승":t==="DOWN"?"하락":"중립"}`;

      // Recommend
      let reco = "대기";
      if (t==="UP") reco="LONG 진입 추천";
      if (t==="DOWN") reco="SHORT 진입 추천";
      if ((t==="UP" && side==="SHORT") || (t==="DOWN" && side==="LONG")) reco="비추천(트렌드 반대)";
      const chk = validateTpSl(tpPct, slPct);
      if(!chk.ok) reco = "설정 오류: " + chk.msg;
      else if(chk.warn) reco = `${reco} / ⚠ ${chk.msg}`;
      recoEl.className = `pill ${reco.includes("오류")?"hit":reco.includes("⚠")?"warn":reco.includes("추천")?"ok":"neutral"}`;
      recoEl.textContent = `추천: ${reco}`;

      // TP/SL 계산
      const longTP = entry ? entry*(1+tpPct/100) : null;
      const longSL = entry ? entry*(1-slPct/100) : null;
      const shortTP = entry ? entry*(1-tpPct/100) : null;
      const shortSL = entry ? entry*(1+slPct/100) : null;

      document.getElementById(`ltp_${i}`).textContent = entry ? fmt(longTP,6) : "-";
      document.getElementById(`lsl_${i}`).textContent = entry ? fmt(longSL,6) : "-";
      document.getElementById(`stp_${i}`).textContent = entry ? fmt(shortTP,6) : "-";
      document.getElementById(`ssl_${i}`).textContent = entry ? fmt(shortSL,6) : "-";

      // 상태(근접/컨펌) + 표시시간 유지 + 소리
      let status = "-";
      let isNear = false;
      let isConfirm = false;

      if (entry && chk.ok){
        const tp = (side==="SHORT") ? shortTP : longTP;
        const sl = (side==="SHORT") ? shortSL : longSL;

        // 근접(%) 기준
        const nearTP = Math.abs(price - tp)/price*100 <= nearPct;
        const nearSL = Math.abs(price - sl)/price*100 <= nearPct;

        // 컨펌(%) 기준(더 넓은 ‘확정’ 영역)
        const confTP = Math.abs(price - tp)/price*100 <= confirmPctGlobal;
        const confSL = Math.abs(price - sl)/price*100 <= confirmPctGlobal;

        // 실제 터치/돌파
        let hitTP=false, hitSL=false;
        if (side==="LONG"){ hitTP = price >= tp; hitSL = price <= sl; }
        else { hitTP = price <= tp; hitSL = price >= sl; }

        if (hitSL){ status = `${side} SL 컨펌`; isConfirm = true; }
        else if (hitTP){ status = `${side} TP 컨펌`; isConfirm = true; }
        else if (confSL){ status = `${side} SL 컨펌근접`; isConfirm = true; }
        else if (confTP){ status = `${side} TP 컨펌근접`; isConfirm = true; }
        else if (nearSL){ status = `${side} SL 근접`; isNear = true; }
        else if (nearTP){ status = `${side} TP 근접`; isNear = true; }
      }

      // UI pill
      statusEl.className = `pill ${String(status).includes("컨펌")?"hit":String(status).includes("근접")?"warn":"neutral"}`;
      statusEl.textContent = `상태: ${status}`;

      // mark timers + 테두리 색상
      if (isNear){
        markNear(i, `${symC}:${status}`);
      }
      if (isConfirm){
        markConfirm(i, `${symC}:${status}`);
        card.classList.add("confirm");
        if (side==="SHORT"){ card.classList.add("short"); card.classList.remove("long"); }
        else { card.classList.add("long"); card.classList.remove("short"); }
      }

      // PnL/ROI
      let pnl=null, roi=null;
      if (entry && margin>0){
        const size = margin*lev;
        const frac = (side==="SHORT") ? ((entry-price)/entry) : ((price-entry)/entry);
        pnl = size*frac;
        roi = (pnl/margin)*100;
      }
      const pnlEl = document.getElementById(`pnl_${i}`);
      pnlEl.textContent = pnl===null ? "-" : fmt(pnl,6);
      pnlEl.className = (pnl!==null && pnl>=0) ? "pnLPlus" : "pnLMinus";
      document.getElementById(`roi_${i}`).textContent = roi===null ? "-" : fmt(roi,4);

      metaEl.textContent =
        `심볼: ${symC} / 레버리지: ${lev}x / price_ts=${new Date(q.price_ts).toLocaleTimeString()} / ind_ts=${new Date(q.ind_ts).toLocaleTimeString()}`;
    }
  }catch(e){
    syncInfo.textContent = `갱신 오류: ${String(e?.message||e)}`;
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
