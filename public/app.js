// ====== Config ======
const TREND_BAND_PCT = 0.3;
const REFRESH_MS = 3000;       // 현재가 갱신 주기(서버 캐시 2초)
const MA30_TTL_NOTE = "MA30/RSI는 서버에서 60초 캐시(15분봉 기준)";

const DEFAULT_WATCHLIST = [
  "BTCUSDT","ETHUSDT","COREUSDT","WLDUSDT","PIUSDT","DOGEUSDT","XRPUSDT","TRXUSDT"
];

const LEV_OPTIONS = [1,3,5,10,15,20,25,30,35,40,45,50];

// 슬롯 개수: 모바일 6 / PC 12 (반응형이라 슬롯은 12 고정 렌더, 모바일은 스크롤 없이 6개가 ‘한 화면’ 목표)
const SLOT_COUNT = 12;

// ====== Storage ======
function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || ""); } catch { return fallback; }
}
function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

function normSymForUI(s) {
  return String(s || "").trim().toUpperCase();
}

// MEXC 선물 심볼로 변환(표시도 통일)
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

// 슬롯별 선택된 심볼
let slots = loadJSON("slots", null);
if (!Array.isArray(slots) || slots.length !== SLOT_COUNT) {
  // 기본 배치: 와치리스트 앞에서 12개 채우기(모자라면 반복)
  slots = Array.from({ length: SLOT_COUNT }, (_, i) => watchlist[i % watchlist.length]);
  saveJSON("slots", slots);
}

// 심볼별 입력값(=DASH 입력칸들)
let inputsMap = loadJSON("inputsMap", {});
function ensureInputs(sym) {
  const s = normSymForUI(sym);
  inputsMap[s] ||= {
    margin: 5.8,      // 투자금(USDT) = Margin
    leverage: 20,     // 레버리지
    entry: 0,         // 진입가
    side: "SHORT",    // LONG/SHORT
    tp_pct: 1.5,      // 목표수익(%)
    sl_pct: 0.7,      // 손절(%)
    near_pct: 0.5     // 근접기준(%)
  };
  return inputsMap[s];
}
function saveAll() {
  saveJSON("wl", watchlist);
  saveJSON("slots", slots);
  saveJSON("inputsMap", inputsMap);
}

// ====== Calculations (DASH 방식 유지) ======
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

// drawer
const drawer = document.getElementById("drawer");
const btnWatch = document.getElementById("btnWatch");
const btnClose = document.getElementById("btnClose");
const backdrop = document.getElementById("backdrop");
const wlInput = document.getElementById("wlInput");
const wlAdd = document.getElementById("wlAdd");
const wlList = document.getElementById("wlList");
const btnReset = document.getElementById("btnReset");

btnWatch.onclick = () => { drawer.classList.add("open"); renderWatchlist(); };
btnClose.onclick = () => drawer.classList.remove("open");
backdrop.onclick = () => drawer.classList.remove("open");

wlAdd.onclick = () => {
  const v = normSymForUI(wlInput.value);
  if (!v) return;
  if (!watchlist.includes(v)) watchlist.unshift(v);
  wlInput.value = "";
  saveAll();
  renderAll(); // 드롭다운 옵션 갱신
  renderWatchlist();
};

btnReset.onclick = () => {
  // 슬롯을 와치리스트 기준으로 다시 자동 배치
  slots = Array.from({ length: SLOT_COUNT }, (_, i) => watchlist[i % watchlist.length]);
  saveAll();
  renderAll();
};

function renderWatchlist() {
  wlList.innerHTML = "";
  watchlist.forEach((sym) => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `<code>${sym}</code><button class="xbtn">삭제</button>`;
    row.querySelector("button").onclick = () => {
      watchlist = watchlist.filter(s => s !== sym);
      if (watchlist.length === 0) watchlist = DEFAULT_WATCHLIST.slice();
      // 슬롯에서 지워진 심볼은 첫번째로 치환
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

  // 드롭다운 옵션
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

    <div style="position:relative;margin-top:10px">
      <div class="big" id="price_${slotIndex}">현재가(Fair): -</div>
      <div class="muted" id="ma30_${slotIndex}">MA30: -</div>
      <div class="muted" id="hl24_${slotIndex}">24h High: - / 24h Low: -</div>

      <!-- ✅ RSI 표시(우측 고정) -->
      <div id="rsiBox_${slotIndex}" style="
        position:absolute; right:0; top:0;
        text-align:right; font-weight:900;
        color:#d8b55a; line-height:1.55;
      ">
        <div id="rsi6_${slotIndex}">RSI(6): -</div>
        <div id="rsi12_${slotIndex}">RSI(12): -</div>
        <div id="rsi24_${slotIndex}">RSI(24): -</div>
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
      <div>
        예상마진(PnL USDT):
        <b id="pnl_${slotIndex}" class="pnl">-</b>
      </div>
      <div>ROI(%): <b id="roi_${slotIndex}">-</b></div>
      <div class="muted" id="meta_${slotIndex}">—</div>
    </div>
  `;

  // handlers
  card.querySelector(`#sym_${slotIndex}`).onchange = (e) => {
    slots[slotIndex] = normSymForUI(e.target.value);
    saveAll();
    renderAll(); // 심볼 바뀌면 카드 전체 리렌더(입력맵/표시 매칭)
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
  for (let i = 0; i < SLOT_COUNT; i++) {
    grid.appendChild(renderCard(i));
  }
}
renderAll();

// ====== Live refresh ======
async function refresh() {
  try {
    const uniqSyms = [...new Set(slots.map(normSymForUI).filter(Boolean))];
    const qs = new URLSearchParams({ symbols: uniqSyms.join(",") });
    const res = await fetch(`/api/quote_batch?${qs.toString()}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || "API error");

    const map = new Map();
    (json.results || []).forEach(r => map.set(normSymForUI(r.symbol), r));

    // 화면 업데이트
    const now = new Date();
    syncInfo.textContent = `갱신: ${now.toLocaleTimeString()} / ${MA30_TTL_NOTE}`;

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
      const hlEl = document.getElementById(`hl24_${i}`);

      const rsi6El = document.getElementById(`rsi6_${i}`);
      const rsi12El = document.getElementById(`rsi12_${i}`);
      const rsi24El = document.getElementById(`rsi24_${i}`);

      const trendEl = document.getElementById(`trend_${i}`);
      const statusEl = document.getElementById(`status_${i}`);
      const recoEl = document.getElementById(`reco_${i}`);
      const metaEl = document.getElementById(`meta_${i}`);

      if (!q || q.error) {
        priceEl.textContent = `현재가(Fair): -`;
        maEl.textContent = `MA30: -`;
        hlEl.textContent = `24h High: - / 24h Low: -`;

        rsi6El.textContent = `RSI(6): ERR`;
        rsi12El.textContent = `RSI(12): ERR`;
        rsi24El.textContent = `RSI(24): ERR`;

        trendEl.className = "pill neutral";
        trendEl.textContent = "트렌드: -";
        statusEl.className = "pill neutral";
        statusEl.textContent = "상태: -";
        recoEl.className = "pill warn";
        recoEl.textContent = `추천: 오류`;
        metaEl.textContent = q?.error ? `에러: ${q.error}` : "데이터 없음";
        continue;
      }

      const price = Number(q.fair);
      const ma30 = Number(q.ma30);

      priceEl.textContent = `현재가(Fair): ${fmt(price, 6)}`;
      maEl.textContent = `MA30: ${fmt(ma30, 6)} (15분)`;

      // ✅ 24h High/Low
      const h24 = q.high24;
      const l24 = q.low24;
      hlEl.textContent = `24h High: ${fmt(h24, 6)} / 24h Low: ${fmt(l24, 6)}`;

      // ✅ RSI
      rsi6El.textContent = `RSI(6): ${fmt(q.rsi6, 2)}`;
      rsi12El.textContent = `RSI(12): ${fmt(q.rsi12, 2)}`;
      rsi24El.textContent = `RSI(24): ${fmt(q.rsi24, 2)}`;

      // Trend
      const t = calcTrend(price, ma30, null);
      trendEl.className = `pill ${t==="UP"?"up":t==="DOWN"?"down":"neutral"}`;
      trendEl.textContent = `트렌드: ${t==="UP"?"상승":t==="DOWN"?"하락":"중립"}`;

      // Recommend (트렌드 방향일 때만 추천)
      let reco = "대기";
      if (t === "UP") reco = "LONG 진입 추천";
      if (t === "DOWN") reco = "SHORT 진입 추천";
      if ((t === "UP" && side === "SHORT") || (t === "DOWN" && side === "LONG")) reco = "비추천(트렌드 반대)";
      const chk = validateTpSl(tpPct, slPct);
      if (!chk.ok) reco = "설정 오류: " + chk.msg;
      else if (chk.warn) reco = `${reco} / ⚠ ${chk.msg}`;

      recoEl.className = `pill ${reco.includes("오류")?"hit":reco.includes("⚠")?"warn":reco.includes("추천")?"ok":"neutral"}`;
      recoEl.textContent = `추천: ${reco}`;

      // TP/SL
      const longTP = entry ? entry * (1 + tpPct/100) : null;
      const longSL = entry ? entry * (1 - slPct/100) : null;
      const shortTP = entry ? entry * (1 - tpPct/100) : null;
      const shortSL = entry ? entry * (1 + slPct/100) : null;

      document.getElementById(`ltp_${i}`).textContent = entry ? fmt(longTP, 6) : "-";
      document.getElementById(`lsl_${i}`).textContent = entry ? fmt(longSL, 6) : "-";
      document.getElementById(`stp_${i}`).textContent = entry ? fmt(shortTP, 6) : "-";
      document.getElementById(`ssl_${i}`).textContent = entry ? fmt(shortSL, 6) : "-";

      // Status (근접/터치)
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

      // PnL/ROI (전 방식 유지: Size=Margin*Lev, ROI=PnL/Margin)
      let pnl = null, roi = null;
      if (entry && margin > 0) {
        const size = margin * lev;
        const frac = (side === "SHORT") ? ((entry - price)/entry) : ((price - entry)/entry);
        pnl = size * frac;
        roi = (pnl / margin) * 100;
      }

      document.getElementById(`pnl_${i}`).textContent = pnl===null ? "-" : fmt(pnl, 6);
      document.getElementById(`roi_${i}`).textContent = roi===null ? "-" : fmt(roi, 4);

      metaEl.textContent =
        `심볼: ${symC} / 레버리지: ${lev}x / Size=마진×레버리지 / price_ts=${new Date(q.price_ts).toLocaleTimeString()}`;
    }
  } catch (e) {
    syncInfo.textContent = `갱신 오류: ${String(e?.message || e)}`;
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
