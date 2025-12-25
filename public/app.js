// ===== 구글 DASH 계산 "동일 구조" =====
const TREND_BAND_PCT = 0.3;

const DEFAULT_WATCHLIST = [
  "BTCUSDT","ETHUSDT","COREUSDT","WLDUSDT","PIUSDT","DOGEUSDT",
  "XRPUSDT","TRXUSDT","SOLUSDT","BNBUSDT"
];

// 모바일 6 / PC 12 (같은 링크, 반응형으로 자동)
function maxCards() {
  return window.matchMedia("(min-width: 1100px)").matches ? 12 : 6;
}

function normSym(sym){
  const s = String(sym||"").trim().toUpperCase();
  if (!s) return "";
  if (s.includes("_")) return s.replace("_", ""); // BTC_USDT -> BTCUSDT(표시/저장 편의)
  return s;
}

function saveJSON(key, obj){ localStorage.setItem(key, JSON.stringify(obj)); }
function loadJSON(key, fallback){
  try { return JSON.parse(localStorage.getItem(key) || "") ?? fallback; }
  catch { return fallback; }
}

const WL_KEY = "mexc_wl";
const ACTIVE_KEY = "mexc_active";
const INPUTS_KEY = "mexc_inputs";

let watchlist = loadJSON(WL_KEY, DEFAULT_WATCHLIST).map(normSym);
let active = loadJSON(ACTIVE_KEY, watchlist.slice(0, 6)).map(normSym);
let inputs = loadJSON(INPUTS_KEY, {}); // inputs[sym] = {margin, lev, entry, side, tp, sl, near}

function ensureInputs(sym){
  inputs[sym] ||= { margin: 5.8, lev: 20, entry: 0, side: "SHORT", tp: 1.5, sl: 0.7, near: 0.2 };
  return inputs[sym];
}

function clampActive(){
  const max = maxCards();
  active = active.filter(s => !!s);
  if (active.length > max) active = active.slice(0, max);
  saveJSON(ACTIVE_KEY, active);
}

window.addEventListener("resize", () => { clampActive(); render(); });

const grid = document.getElementById("grid");
const wlSelect = document.getElementById("wlSelect");
const ma30TimeEl = document.getElementById("ma30Time");

function renderWatchlist(){
  wlSelect.innerHTML = "";
  watchlist.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    wlSelect.appendChild(opt);
  });
}

function trendKey(price, ma30){
  if (!price || !ma30) return "NONE";
  const upper = ma30 * (1 + TREND_BAND_PCT/100);
  const lower = ma30 * (1 - TREND_BAND_PCT/100);
  if (price > upper) return "UP";
  if (price < lower) return "DOWN";
  return "NEUTRAL";
}

function fmt(n, d=6){
  if (n === null || n === undefined) return "-";
  const x = Number(n);
  if (!Number.isFinite(x)) return "-";
  if (Math.abs(x) >= 1000) return x.toFixed(2);
  return x.toFixed(d).replace(/0+$/,"").replace(/\.$/,"");
}

// DASH 동일: size = margin*lev / pnl = size*frac / roi = pnl/margin*100
function computeDash(mkt, inp){
  const price = Number(mkt.fair);
  const ma30 = Number(mkt.ma30);
  const t = trendKey(price, ma30);

  const margin = Number(inp.margin)||0;
  const lev = Math.max(1, Number(inp.lev)||1);
  const entry = Number(inp.entry)||0;
  const side = String(inp.side||"LONG").toUpperCase();
  const tpPct = Number(inp.tp)||1.5;
  const slPct = Number(inp.sl)||0.7;
  const nearPct = Number(inp.near)||0.2;

  const size = margin * lev;

  const longTP = entry ? entry*(1+tpPct/100) : null;
  const longSL = entry ? entry*(1-slPct/100) : null;
  const shortTP = entry ? entry*(1-tpPct/100) : null;
  const shortSL = entry ? entry*(1+slPct/100) : null;

  let pnl=null, roi=null;
  if (entry>0 && margin>0 && size>0 && price>0){
    const frac = (side==="SHORT") ? ((entry - price)/entry) : ((price - entry)/entry);
    pnl = size * frac;
    roi = (pnl / margin) * 100;
  }

  // 상태(근접/터치) - 기존 방식 유지
  let status = "";
  if (entry>0 && price>0){
    const tp = (side==="SHORT") ? shortTP : longTP;
    const sl = (side==="SHORT") ? shortSL : longSL;
    const nearTP = Math.abs(price - tp) / price * 100 <= nearPct;
    const nearSL = Math.abs(price - sl) / price * 100 <= nearPct;
    const hitTP = (side==="LONG") ? price>=tp : price<=tp;
    const hitSL = (side==="LONG") ? price<=sl : price>=sl;

    if (hitSL) status = `${side} SL 터치/돌파`;
    else if (hitTP) status = `${side} TP 터치/돌파`;
    else if (nearSL) status = `${side} SL 근접`;
    else if (nearTP) status = `${side} TP 근접`;
  }

  // 추천(트렌드 방향일 때만)
  let recommend = "대기";
  if (t==="UP") recommend = "LONG 진입 추천";
  else if (t==="DOWN") recommend = "SHORT 진입 추천";
  if ((t==="UP" && side==="SHORT") || (t==="DOWN" && side==="LONG")) recommend = "비추천(트렌드 반대)";

  return { price, ma30, trend:t, longTP,longSL,shortTP,shortSL, pnl, roi, status, recommend, size };
}

function render(){
  renderWatchlist();
  clampActive();
  grid.innerHTML = "";

  active.forEach(sym => {
    const inp = ensureInputs(sym);

    const card = document.createElement("div");
    card.className = "card";
    card.dataset.sym = sym;

    card.innerHTML = `
      <div class="title">${sym}</div>

      <div class="row"><span class="muted">투자금(Margin)</span>
        <input data-k="margin" type="number" step="0.01" value="${inp.margin}" style="width:120px">
      </div>

      <div class="row"><span class="muted">레버리지</span>
        <select data-k="lev" style="width:120px">
          ${[1,3,5,10,15,20,25,30,35,40,45,50].map(v=>`<option value="${v}" ${Number(inp.lev)===v?"selected":""}>${v}x</option>`).join("")}
        </select>
      </div>

      <div class="row"><span class="muted">진입가(Avg)</span>
        <input data-k="entry" type="number" step="0.000001" value="${inp.entry}" style="width:120px">
      </div>

      <div class="row"><span class="muted">방향</span>
        <select data-k="side" style="width:120px">
          <option value="LONG" ${inp.side==="LONG"?"selected":""}>LONG</option>
          <option value="SHORT" ${inp.side==="SHORT"?"selected":""}>SHORT</option>
        </select>
      </div>

      <div class="row"><span class="muted">목표수익(%)</span>
        <input data-k="tp" type="number" step="0.1" value="${inp.tp}" style="width:120px">
      </div>

      <div class="row"><span class="muted">손절(%)</span>
        <input data-k="sl" type="number" step="0.1" value="${inp.sl}" style="width:120px">
      </div>

      <div class="row"><span class="muted">근접기준(%)</span>
        <input data-k="near" type="number" step="0.1" value="${inp.near}" style="width:120px">
      </div>

      <div class="row"><span class="pill trendNeutral" id="trend_${sym}">트렌드: -</span>
        <span class="pill" id="status_${sym}">상태: -</span>
      </div>

      <div class="row"><span class="big" id="price_${sym}">가격: -</span></div>
      <div class="row"><span class="muted" id="ma30_${sym}">MA30: -</span></div>

      <div class="row"><span class="muted">Long TP/SL</span>
        <span class="muted" id="ltp_${sym}">-</span> / <span class="muted" id="lsl_${sym}">-</span>
      </div>
      <div class="row"><span class="muted">Short TP/SL</span>
        <span class="muted" id="stp_${sym}">-</span> / <span class="muted" id="ssl_${sym}">-</span>
      </div>

      <div class="row"><span class="muted">예상마진(PnL)</span>
        <span id="pnl_${sym}">-</span>
      </div>
      <div class="row"><span class="muted">ROI(%)</span>
        <span id="roi_${sym}">-</span>
      </div>

      <div class="row"><span class="pill" id="reco_${sym}">추천: -</span></div>
      <div class="small" id="upd_${sym}">-</div>
    `;

    // 입력 저장 이벤트
    card.querySelectorAll("input,select").forEach(el=>{
      el.addEventListener("change", ()=>{
        const k = el.dataset.k;
        const v = (el.tagName==="SELECT") ? el.value : Number(el.value);
        const obj = ensureInputs(sym);
        obj[k] = (k==="side") ? String(v) : v;
        inputs[sym] = obj;
        saveJSON(INPUTS_KEY, inputs);
      });
    });

    grid.appendChild(card);
  });
}

async function refresh(){
  try{
    clampActive();
    const symbols = active.join(",");
    if (!symbols) return;

    const res = await fetch(`/api/market_batch?symbols=${encodeURIComponent(symbols)}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || "API error");

    // MA30 갱신 시간 (가장 최신값 표시)
    let ma30Latest = 0;

    json.results.forEach(mkt=>{
      const sym = normSym(mkt.symbol);
      ma30Latest = Math.max(ma30Latest, Number(mkt.ma30RefreshedAt||0));

      const inp = ensureInputs(sym);
      const d = computeDash(mkt, inp);

      // 트렌드 pill
      const tEl = document.getElementById(`trend_${sym}`);
      if (tEl){
        if (d.trend==="UP"){ tEl.className="pill trendUp"; tEl.textContent="트렌드: 상승"; }
        else if (d.trend==="DOWN"){ tEl.className="pill trendDown"; tEl.textContent="트렌드: 하락"; }
        else { tEl.className="pill trendNeutral"; tEl.textContent="트렌드: 중립"; }
      }

      // 상태 pill 색
      const sEl = document.getElementById(`status_${sym}`);
      if (sEl){
        const st = d.status || "-";
        sEl.textContent = `상태: ${st}`;
        if (st.includes("터치")) sEl.className = "pill hit";
        else if (st.includes("근접")) sEl.className = "pill warn";
        else sEl.className = "pill trendNeutral";
      }

      // 가격/MA30
      const pEl = document.getElementById(`price_${sym}`);
      if (pEl) pEl.textContent = `가격: ${fmt(d.price, 6)}`;

      const maEl = document.getElementById(`ma30_${sym}`);
      if (maEl) maEl.textContent = `MA30: ${fmt(d.ma30, 6)}`;

      // TP/SL
      const setTxt = (id,val)=>{ const el=document.getElementById(id); if(el) el.textContent=fmt(val,6); };
      setTxt(`ltp_${sym}`, d.longTP);
      setTxt(`lsl_${sym}`, d.longSL);
      setTxt(`stp_${sym}`, d.shortTP);
      setTxt(`ssl_${sym}`, d.shortSL);

      // PnL (수익=빨강 / 손실=파랑)
      const pnlEl = document.getElementById(`pnl_${sym}`);
      if (pnlEl){
        pnlEl.textContent = (d.pnl==null) ? "-" : fmt(d.pnl, 6);
        pnlEl.className = (d.pnl==null) ? "" : (d.pnl>=0 ? "pnlPlus" : "pnlMinus");
      }

      const roiEl = document.getElementById(`roi_${sym}`);
      if (roiEl) roiEl.textContent = (d.roi==null) ? "-" : fmt(d.roi, 2);

      // 추천 pill
      const rEl = document.getElementById(`reco_${sym}`);
      if (rEl){
        const txt = d.recommend || "-";
        rEl.textContent = `추천: ${txt}`;
        rEl.className = txt.includes("추천") ? "pill ok" : (txt.includes("비추천") ? "pill warn" : "pill trendNeutral");
      }

      const updEl = document.getElementById(`upd_${sym}`);
      if (updEl) updEl.textContent = `업데이트: ${new Date(Number(mkt.ts)).toLocaleTimeString()}`;
    });

    if (ma30Latest){
      ma30TimeEl.textContent = new Date(ma30Latest).toLocaleString();
    }
  }catch(e){
    console.error(e);
  }
}

// ===== 와치리스트/카드 버튼 =====
document.getElementById("wlAdd").addEventListener("click", ()=>{
  const v = normSym(document.getElementById("wlInput").value);
  if (!v) return;
  if (!watchlist.includes(v)) watchlist.unshift(v);
  watchlist = Array.from(new Set(watchlist)).slice(0, 300);
  saveJSON(WL_KEY, watchlist);
  document.getElementById("wlInput").value = "";
  render();
});

document.getElementById("wlDel").addEventListener("click", ()=>{
  const sel = wlSelect.value;
  if (!sel) return;
  watchlist = watchlist.filter(s=>s!==sel);
  active = active.filter(s=>s!==sel);
  saveJSON(WL_KEY, watchlist);
  saveJSON(ACTIVE_KEY, active);
  render();
});

document.getElementById("btnAdd").addEventListener("click", ()=>{
  const sel = wlSelect.value;
  if (!sel) return;
  if (active.includes(sel)) return;
  active.push(sel);
  clampActive();
  render();
});

document.getElementById("btnRemove").addEventListener("click", ()=>{
  const sel = wlSelect.value;
  if (!sel) return;
  active = active.filter(s=>s!==sel);
  saveJSON(ACTIVE_KEY, active);
  render();
});

render();
refresh();
setInterval(refresh, 5000); // 5초 갱신 (ticker 캐시 2초, ma30 캐시 5분)
