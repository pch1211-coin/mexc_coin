// ====== Config ======
const TREND_BAND_PCT = 0.3;
const REFRESH_MS = 3000;
const MA30_TTL_NOTE = "MA30는 서버에서 캐시";

// RSI는 MEXC 차트와 동일한 15분봉 기준(원하면 이것도 드롭다운으로 확장 가능)
const RSI_INTERVAL = "Min15";
const RSI_DAYS = 7;

const DEFAULT_WATCHLIST = [
  "BTCUSDT","ETHUSDT","COREUSDT","WLDUSDT","PIUSDT","DOGEUSDT","XRPUSDT","TRXUSDT"
];

const LEV_OPTIONS = [1,3,5,10,15,20,25,30,35,40,45,50];
const SLOT_COUNT = 12;

// ✅ MA30 interval 드롭다운 옵션
const MA_INTERVAL_OPTIONS = [
  { v:"Min1",  label:"1분"  },
  { v:"Min3",  label:"3분"  },
  { v:"Min5",  label:"5분"  },
  { v:"Min10", label:"10분" },
  { v:"Min15", label:"15분" },
  { v:"Min30", label:"30분" }
];

// ====== Storage ======
function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || ""); } catch { return fallback; }
}
function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

function loadStr(key, fallback) {
  const v = localStorage.getItem(key);
  return v == null ? fallback : String(v);
}
function saveStr(key, val) { localStorage.setItem(key, String(val)); }

function normSymForUI(s) { return String(s || "").trim().toUpperCase(); }

function toContractSym(sym) {
  const s = normSymForUI(sym);
  if (!s) return "";
  if (s.includes("_")) return s;
  if (s.endsWith("USDT")) return s.replace(/USDT$/, "_USDT");
  return s;
}

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
function ensureInputs(sym) {
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
function saveAll() {
  saveJSON("wl", watchlist);
  saveJSON("slots", slots);
  saveJSON("inputsMap", inputsMap);
}

// ✅ 선택된 MA interval
let maInterval = loadStr("ma_interval", "Min15");
if (!MA_INTERVAL_OPTIONS.some(o => o.v === maInterval)) maInterval = "Min15";

// ====== Calculations ======
function calcTrend(price, ma30, prevTrend) {
  if (!price || !ma30) return "NONE";
  const upper = ma30 * (1 + TREND_BAND_PCT / 100);
  const lower = ma30 * (1 - TREND_BAND_PCT / 100);
  if (price <= upper && price >= lower) return prevTrend || "NEUTRAL";
  if (price > upper) return "UP";
  if (price < lower) return "DOWN";
  return prevTrend || "NEUTRAL";
}

function validateTpSl(tp, sl) {
  if (!isFinite(tp) || !isFinite(sl)) return { ok: false, msg: "TP/SL 값 오류" };
  if (tp <= 0 || sl <= 0) return { ok: false, msg: "TP/SL은 0보다 커야 함" };
  if (tp > 50 || sl > 50) return { ok: false, msg: "TP/SL%가 너무 큼(>50%)" };
  const warn = tp < sl * 1.3;
  return { ok: true, warn, msg: warn ? "권장: 목표수익 ≥ 손절×1.3" : "" };
}

function fmt(n, d=6) {
  const x = Number(n);
  if (!isFinite(x)) return "-";
  if (Math.abs(x) >= 1000) return x.toFixed(2);
  return x.toFixed(d).replace(/0+$/,"").replace(/\.$/,"");
}

// ====== UI ======
const grid = document.getElementById("grid");
const syncInfo = document.getElementById("syncInfo");

// header buttons
const btnWatch = document.getElementById("btnWatch");
const btnReset = document.getElementById("btnReset");

// drawer
const drawer = document.getElementById("drawer");
const btnClose = document.getElementById("btnClose");
const backdrop = document.getElementById("backdrop");
const wlInput = document.getElementById("wlInput");
const wlAdd = document.getElementById("wlAdd");
const wlList = document.getElementById("wlList");

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

// ✅ 헤더에 MA30 시간 드롭다운 추가(자동)
function ensureMaDropdown() {
  const header = document.querySelector("header");
  if (!header) return;

  if (document.getElementById("maIntervalSel")) return;

  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.gap = "6px";
  wrap.style.alignItems = "center";

  const label = document.createElement("span");
  label.className = "muted";
  label.textContent = "MA30:";

  const sel = document.createElement("select");
  sel.id = "maIntervalSel";
  sel.className = "btn";
  sel.style.padding = "6px 10px";
  sel.style.borderRadius = "10px";

  sel.innerHTML = MA_INTERVAL_OPTIONS.map(o => {
    const s = o.v === maInterval ? "selected" : "";
    return `<option value="${o.v}" ${s}>${o.label}</option>`;
  }).join("");

  sel.onchange = (e) => {
    maInterval = String(e.target.value);
    saveStr("ma_interval", maInterval);
    refresh(); // 즉시 반영
  };

  wrap.appendChild(label);
  wrap.appendChild(sel);

  // syncInfo 앞에 넣기
  header.insertBefore(wrap, syncInfo);
}
ensureMaDropdown();

function renderWatchlist() {
  wlList.innerHTML = "";
  watchlist.forEach((sym) => {
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

function renderCard(slotIndex) {
  const sym = normSymForUI(slots[slotIndex]);
  const inp = ensureInputs(sym);

  const card = document.createElement("div");
  card.className = "card";
  card.id = `card_${slotIndex}`;

  const options = watchlist.map(s => {
    const sel = (s === sym) ? "selected" : "";
    return `<option value="${s}" ${sel}>${s}</option>`;
  }).join("");

  const levOpts = LEV_OPTIONS.map(v => {
    const sel = Number(inp.leverage) === v ? "selected" : "";
    return `<option value="${v}" ${sel}>${v}x</option>`;
  }).join("");

  card.innerHTML = `
    <div class="row">
      <div class="title">슬롯 ${slotIndex+1}</div>
      <span class="pill neutral" id="trend_${slotIndex}">트렌드: -</span>
    </div>

    <label>심볼 (와치리스트 드롭다운)</label>
    <select id="sym_${slotIndex}">${options}</select>

    <div class="priceWrap">
      <div>
        <div class="big" id="price_${slotIndex}">현재가(Fair): -</div>
        <div class="muted" id="ma30_${slotIndex}">MA30: -</div>
      </div>
      <div class="rsiPanel">
        RSI(6): <span id="rsi6_${slotIndex}">-</span><br/>
        RSI(12): <span id="rsi12_${slotIndex}">-</span><br/>
        RSI(24): <span id="rsi24_${slotIndex}">-</span>
      </div>
    </div>

    <label>투자금(USDT)=마진(Margin)</label>
    <input id="margin_${slotIndex}" type="number" step="0.01" value="${inp.margin}"/>

    <label>레버리지</label>
    <select id="lev_${slotIndex}">${levOpts}</select>

    <label>진입가(직접입력)</label>
    <input id="entry_${slotIndex}" type="number" step="0.000001" value="${inp.entry}"/>

    <label>방향(LONG/SHORT)</label>
    <select id="side_${slotIndex}">
      <option value="LONG" ${inp.side==="LONG"?"selected":""}>LONG</option>
      <option value="SHORT" ${inp.side==="SHORT"?"selected":""}>SHORT</option>
    </select>

    <div class="row" style="margin-top:8px;gap:8px">
      <div style="flex:1">
        <label>목표수익(%)</label>
        <input id="tp_${slotIndex}" type="number" step="0.1" value="${inp.tp_pct}"/>
      </div>
      <div style="flex:1">
        <label>손절(%)</label>
        <input id="sl_${slotIndex}" type="number" step="0.1" value="${inp.sl_pct}"/>
      </div>
    </div>

    <label>근접기준(%)</label>
    <input id="near_${slotIndex}" type="number" step="0.1" value="${inp.near_pct}"/>

    <div style="margin-top:10px" class="row">
      <span class="pill neutral" id="status_${slotIndex}">상태: -</span>
      <span class="pill neutral" id="reco_${slotIndex}">추천: -</span>
    </div>

    <div style="margin-top:10px">
      <div>Long TP: <b id="ltp_${slotIndex}">-</b> / Long SL: <b id="lsl_${slotIndex}">-</b></div>
      <div>Short TP: <b id="stp_${slotIndex}">-</b> / Short SL: <b id="ssl_${slotIndex}">-</b></div>
    </div>

    <div style="margin-top:10px">
      <div>예상마진(PnL USDT): <b id="pnl_${slotIndex}" class="pnl">-</b></div>
      <div>ROI(%): <b id="roi_${slotIndex}">-</b></div>
      <div class="muted" id="meta_${slotIndex}">—</div>
    </div>
  `;

  card.querySelector(`#sym_${slotIndex}`).onchange = (e) => {
    slots[slotIndex] = normSymForUI(e.target.value);
    saveAll();
    renderAll();
  };

  const bindNum = (id, key) => {
    card.querySelector(id).onchange = (e) => {
      const s = ensureInputs(sym);
      s[key] = Number(e.target.value);
      inputsMap[sym] = s;
      saveAll();
    };
  };
  const bindStr = (id, key) => {
    card.querySelector(id).onchange = (e) => {
      const s = ensureInputs(sym);
      s[key] = String(e.target.value).toUpperCase();
      inputsMap[sym] = s;
      saveAll();
    };
  };

  bindNum(`#margin_${slotIndex}`, "margin");
  bindNum(`#entry_${slotIndex}`, "entry");
  bindNum(`#tp_${slotIndex}`, "tp_pct");
  bindNum(`#sl_${slotIndex}`, "sl_pct");
  bindNum(`#near_${slotIndex}`, "near_pct");

  card.querySelector(`#lev_${slotIndex}`).onchange = (e) => {
    const s = ensureInputs(sym);
    s.leverage = Number(e.target.value);
    inputsMap[sym] = s;
    saveAll();
  };
  bindStr(`#side_${slotIndex}`, "side");

  return card;
}

function renderAll() {
  grid.innerHTML = "";
  for (let i = 0; i < SLOT_COUNT; i++) grid.appendChild(renderCard(i));
}
renderAll();

// ====== Live refresh ======
async function refresh() {
  try {
    const uniqSyms = [...new Set(slots.map(normSymForUI).filter(Boolean))];
    const qs = new URLSearchParams({
      symbols: uniqSyms.join(","),
      ma_interval: maInterval
    });

    const res = await fetch(`/api/quote_batch?${qs.toString()}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || "API error");

    const map = new Map();
    (json.results || []).forEach(r => map.set(normSymForUI(r.symbol), r));

    const now = new Date();
    const maText = MA_INTERVAL_OPTIONS.find(o => o.v === maInterval)?.label || maInterval;
    syncInfo.textContent = `갱신: ${now.toLocaleTimeString()} / MA30(${maText}) / ${MA30_TTL_NOTE}`;

    for (let i = 0; i < SLOT_COUNT; i++) {
      const symUI = normSymForUI(slots[i]);
      const symC = toContractSym(symUI);
      const q = map.get(symC) || map.get(symUI) || null;

      const inp = ensureInputs(symUI);
      const margin = Number(inp.margin) || 0;
      const lev = Math.max(1, Number(inp.leverage) || 1);
      const entry = Number(inp.entry) || 0;
      const side = String(inp.side || "LONG").toUpperCase();
      const tpPct = Number(inp.tp_pct) || 1.5;
      const slPct = Number(inp.sl_pct) || 0.7;
      const nearPct = Number(inp.near_pct) || 0.5;

      const priceEl = document.getElementById(`price_${i}`);
      const maEl = document.getElementById(`ma30_${i}`);
      const trendEl = document.getElementById(`trend_${i}`);
      const statusEl = document.getElementById(`status_${i}`);
      const recoEl = document.getElementById(`reco_${i}`);
      const metaEl = document.getElementById(`meta_${i}`);

      const rsi6El  = document.getElementById(`rsi6_${i}`);
      const rsi12El = document.getElementById(`rsi12_${i}`);
      const rsi24El = document.getElementById(`rsi24_${i}`);

      if (!q || q.error) {
        priceEl.textContent = `현재가(Fair): -`;
        maEl.textContent = `MA30: -`;
        trendEl.className = "pill neutral";
        trendEl.textContent = "트렌드: -";
        statusEl.className = "pill neutral";
        statusEl.textContent = "상태: -";
        recoEl.className = "pill warn";
        recoEl.textContent = `추천: 오류`;
        metaEl.textContent = q?.error ? `에러: ${q.error}` : "데이터 없음";
        if (rsi6El) rsi6El.textContent = "-";
        if (rsi12El) rsi12El.textContent = "-";
        if (rsi24El) rsi24El.textContent = "-";
        continue;
      }

      const price = Number(q.fair);
      const ma30 = Number(q.ma30);

      priceEl.textContent = `현재가(Fair): ${fmt(price, 6)}`;
      maEl.textContent = `MA30: ${fmt(ma30, 6)} (${MA_INTERVAL_OPTIONS.find(o=>o.v===maInterval)?.label || maInterval})`;

      const t = calcTrend(price, ma30, null);
      trendEl.className = `pill ${t==="UP"?"up":t==="DOWN"?"down":"neutral"}`;
      trendEl.textContent = `트렌드: ${t==="UP"?"상승":t==="DOWN"?"하락":"중립"}`;

      let reco = "대기";
      if (t === "UP") reco = "LONG 진입 추천";
      if (t === "DOWN") reco = "SHORT 진입 추천";
      if ((t === "UP" && side === "SHORT") || (t === "DOWN" && side === "LONG")) reco = "비추천(트렌드 반대)";
      const chk = validateTpSl(tpPct, slPct);
      if (!chk.ok) reco = "설정 오류: " + chk.msg;
      else if (chk.warn) reco = `${reco} / ⚠ ${chk.msg}`;

      recoEl.className = `pill ${reco.includes("오류")?"hit":reco.includes("⚠")?"warn":reco.includes("추천")?"ok":"neutral"}`;
      recoEl.textContent = `추천: ${reco}`;

      const longTP = entry ? entry * (1 + tpPct/100) : null;
      const longSL = entry ? entry * (1 - slPct/100) : null;
      const shortTP = entry ? entry * (1 - tpPct/100) : null;
      const shortSL = entry ? entry * (1 + slPct/100) : null;

      document.getElementById(`ltp_${i}`).textContent = entry ? fmt(longTP, 6) : "-";
      document.getElementById(`lsl_${i}`).textContent = entry ? fmt(longSL, 6) : "-";
      document.getElementById(`stp_${i}`).textContent = entry ? fmt(shortTP, 6) : "-";
      document.getElementById(`ssl_${i}`).textContent = entry ? fmt(shortSL, 6) : "-";

      let status = "";
      if (entry && chk.ok) {
        const tp = (side==="SHORT") ? shortTP : longTP;
        const sl = (side==="SHORT") ? shortSL : longSL;

        const nearTP = Math.abs(price - tp) / price * 100 <= nearPct;
        const nearSL = Math.abs(price - sl) / price * 100 <= nearPct;

        let hitTP=false, hitSL=false;
        if (side === "LONG") { hitTP = price >= tp; hitSL = price <= sl; }
        else { hitTP = price <= tp; hitSL = price >= sl; }

        if (hitSL) status = `${side} SL 터치/돌파`;
        else if (hitTP) status = `${side} TP 터치/돌파`;
        else if (nearSL) status = `${side} SL 근접`;
        else if (nearTP) status = `${side} TP 근접`;
      }

      statusEl.className = `pill ${status.includes("터치")?"hit":status.includes("근접")?"warn":"neutral"}`;
      statusEl.textContent = `상태: ${status || "-"}`;

      let pnl = null, roi = null;
      if (entry && margin > 0) {
        const size = margin * lev;
        const frac = (side === "SHORT") ? ((entry - price)/entry) : ((price - entry)/entry);
        pnl = size * frac;
        roi = (pnl / margin) * 100;
      }

      const pnlEl = document.getElementById(`pnl_${i}`);
      const roiEl = document.getElementById(`roi_${i}`);

      pnlEl.textContent = pnl===null ? "-" : fmt(pnl, 6);
      roiEl.textContent = roi===null ? "-" : fmt(roi, 4);

      pnlEl.classList.remove("pnLPlus", "pnLMinus");
      if (pnl !== null && isFinite(pnl)) pnlEl.classList.add(pnl >= 0 ? "pnLPlus" : "pnLMinus");

      metaEl.textContent =
        `심볼: ${symC} / 레버리지: ${lev}x / MA30=${maInterval} / price_ts=${new Date(q.price_ts).toLocaleTimeString()}`;

      // RSI 표시(캐시 반영)
      const c = _rsiCache.get(symUI);
      if (rsi6El)  rsi6El.textContent  = c && Number.isFinite(c.rsi6)  ? c.rsi6.toFixed(2)  : "-";
      if (rsi12El) rsi12El.textContent = c && Number.isFinite(c.rsi12) ? c.rsi12.toFixed(2) : "-";
      if (rsi24El) rsi24El.textContent = c && Number.isFinite(c.rsi24) ? c.rsi24.toFixed(2) : "-";
    }
  } catch (e) {
    syncInfo.textContent = `갱신 오류: ${String(e?.message || e)}`;
  }
}

refresh();
setInterval(refresh, REFRESH_MS);

// ====== RSI(15분봉) ======
function calcRSI_Wilder_(closes, period) {
  const arr = closes.map(Number).filter(v => Number.isFinite(v));
  if (arr.length < period + 2) return NaN;

  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = arr[i] - arr[i - 1];
    if (d >= 0) gain += d;
    else loss += (-d);
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

async function fetchKlineCloses_(symUI) {
  const msym = toContractSym(symUI);
  const url = `/api/kline?symbol=${encodeURIComponent(msym)}&interval=${encodeURIComponent(RSI_INTERVAL)}&days=${encodeURIComponent(RSI_DAYS)}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `kline http ${res.status}`);
  const closes = (json?.close || []).map(Number).filter(v => Number.isFinite(v));
  if (closes.length < 30) throw new Error("not enough closes");
  return closes;
}

// sym -> {ts, rsi6,rsi12,rsi24, err?}
const _rsiCache = new Map();
const RSI_CACHE_MS = 30 * 1000;
let _rsiBusy = false;

function updateRsiUIForSlot_(slotIndex, symKey) {
  const c = _rsiCache.get(symKey);

  const e6  = document.getElementById(`rsi6_${slotIndex}`);
  const e12 = document.getElementById(`rsi12_${slotIndex}`);
  const e24 = document.getElementById(`rsi24_${slotIndex}`);
  if (!e6 || !e12 || !e24) return;

  if (!c) {
    e6.textContent = "-";
    e12.textContent = "-";
    e24.textContent = "-";
    return;
  }

  if (c.err) {
    e6.textContent = "ERR";
    e12.textContent = "ERR";
    e24.textContent = "ERR";
    return;
  }

  e6.textContent  = Number.isFinite(c.rsi6)  ? c.rsi6.toFixed(2)  : "-";
  e12.textContent = Number.isFinite(c.rsi12) ? c.rsi12.toFixed(2) : "-";
  e24.textContent = Number.isFinite(c.rsi24) ? c.rsi24.toFixed(2) : "-";
}

function updateAllRsiUI_() {
  for (let i = 0; i < SLOT_COUNT; i++) {
    const symKey = normSymForUI(slots[i]);
    updateRsiUIForSlot_(i, symKey);
  }
}

async function refreshRSI_Once() {
  if (_rsiBusy) return;
  _rsiBusy = true;

  try {
    const uniqSyms = [...new Set(slots.map(normSymForUI).filter(Boolean))];
    const now = Date.now();

    // ✅ 캐시 만료된 것만 병렬로 처리
    const need = uniqSyms.filter(sym => {
      const c = _rsiCache.get(sym);
      return !c || (now - c.ts) >= RSI_CACHE_MS;
    });

    const jobs = need.map(async (sym) => {
      try {
        const closes = await fetchKlineCloses_(sym);
        const rsi6  = calcRSI_Wilder_(closes, 6);
        const rsi12 = calcRSI_Wilder_(closes, 12);
        const rsi24 = calcRSI_Wilder_(closes, 24);
        _rsiCache.set(sym, { ts: now, rsi6, rsi12, rsi24 });
      } catch (e) {
        _rsiCache.set(sym, { ts: now, err: String(e?.message || e), rsi6: NaN, rsi12: NaN, rsi24: NaN });
        console.log("[RSI] fail", sym, e);
      }
    });

    await Promise.allSettled(jobs);

    // ✅ 계산 끝나면 즉시 화면 반영 (refresh() 기다리지 않음)
    updateAllRsiUI_();
  } finally {
    _rsiBusy = false;
  }
}

// 최초 1회 바로 + 주기 갱신
refreshRSI_Once();
setInterval(refreshRSI_Once, 5000);
