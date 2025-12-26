// ====== Config ======
const REFRESH_MS = 3000; // 화면 갱신 주기
const STORAGE_KEY = "mexc_dash_web_v1";

// 기본 와치리스트(없으면 이걸로 시작)
const DEFAULT_WATCHLIST = [
  "BTCUSDT","ETHUSDT","COREUSDT","WLDUSDT","PIUSDT","DOGEUSDT","XRPUSDT","TRXUSDT"
];

const LEV_OPTIONS = [1,3,5,10,15,20,25,30,35,40,45,50];
const SLOT_COUNT = 12;

// 진동 쿨다운(ms) (손실/SL 근접 때 너무 자주 울리지 않게)
const VIBRATE_COOLDOWN_MS = 12_000;

// ====== Utils ======
function $(id) { return document.getElementById(id); }

function safeJSONParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

function normalizeSymbol(sym) {
  const s = String(sym || "").trim().toUpperCase();
  if (!s) return "";
  // 사용자 편의: BTC_USDT도 BTCUSDT도 허용(서버가 처리하더라도, UI/저장 일관성 위해 BTCUSDT 형태로 보관)
  return s.replace("_", "");
}

function fmt(n, d = 6) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "-";
  // 너무 길어 보이면 자동으로 자리수 줄임
  const abs = Math.abs(x);
  if (abs >= 1000) return x.toFixed(2);
  if (abs >= 1) return x.toFixed(4).replace(/0+$/,"").replace(/\.$/,"");
  return x.toFixed(d).replace(/0+$/,"").replace(/\.$/,"");
}

function isMobile() {
  return window.matchMedia && window.matchMedia("(max-width: 640px)").matches;
}

// ====== Style injection (index.html 안 건드리고 점멸/강조 구현) ======
(function injectStyles(){
  const style = document.createElement("style");
  style.textContent = `
    @keyframes blinkYellow {
      0% { background: transparent; }
      50% { background: rgba(255, 211, 107, 0.35); }
      100% { background: transparent; }
    }
    .blink-sl {
      animation: blinkYellow 0.9s infinite;
      border-radius: 6px;
      padding: 1px 4px;
    }
    .tp-near {
      color: #59d38a !important;
      font-weight: 900 !important;
    }
    .hit-tp {
      color: #59d38a !important;
      font-weight: 900 !important;
    }
    .hit-sl {
      color: #ff5a5a !important;
      font-weight: 900 !important;
    }
  `;
  document.head.appendChild(style);
})();

// ====== Storage state ======
function defaultInputs() {
  return {
    margin: 5.8,
    leverage: 20,
    entry: 0,
    side: "LONG",
    tp_pct: 1.5,
    sl_pct: 0.7,
    near_pct: 0.5
  };
}

function defaultState() {
  // 12슬롯: 처음 8개는 기본 와치리스트로, 나머지는 비움
  const slots = Array.from({ length: SLOT_COUNT }, (_, i) => normalizeSymbol(DEFAULT_WATCHLIST[i] || ""));
  const inputsMap = {};
  DEFAULT_WATCHLIST.forEach(s => inputsMap[normalizeSymbol(s)] = defaultInputs());

  return {
    watchlist: DEFAULT_WATCHLIST.map(normalizeSymbol),
    slots,
    inputsMap
  };
}

function loadState() {
  const saved = safeJSONParse(localStorage.getItem(STORAGE_KEY), null);
  if (!saved || typeof saved !== "object") return defaultState();

  const st = defaultState();
  if (Array.isArray(saved.watchlist) && saved.watchlist.length) {
    st.watchlist = saved.watchlist.map(normalizeSymbol).filter(Boolean);
  }
  if (Array.isArray(saved.slots)) {
    st.slots = saved.slots.map(normalizeSymbol).slice(0, SLOT_COUNT);
    while (st.slots.length < SLOT_COUNT) st.slots.push("");
  }
  if (saved.inputsMap && typeof saved.inputsMap === "object") {
    st.inputsMap = {};
    for (const [k,v] of Object.entries(saved.inputsMap)) {
      const sym = normalizeSymbol(k);
      if (!sym) continue;
      st.inputsMap[sym] = { ...defaultInputs(), ...(v||{}) };
    }
  }
  return st;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ====== UI: Watchlist drawer ======
function openDrawer() {
  $("drawer").classList.add("open");
  renderWatchlist();
}

function closeDrawer() {
  $("drawer").classList.remove("open");
}

function renderWatchlist() {
  const wlList = $("wlList");
  wlList.innerHTML = "";

  state.watchlist.forEach(sym => {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <code>${sym}</code>
      <button class="xbtn" data-del="${sym}">삭제</button>
    `;
    wlList.appendChild(div);
  });

  wlList.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", () => {
      const sym = btn.getAttribute("data-del");
      // 슬롯에서 사용 중이면 슬롯도 비움
      state.slots = state.slots.map(s => (s === sym ? "" : s));
      // 입력값도 같이 제거(원하면 유지 가능)
      delete state.inputsMap[sym];

      state.watchlist = state.watchlist.filter(s => s !== sym);
      // 와치리스트가 비면 기본값 넣기
      if (!state.watchlist.length) state.watchlist = DEFAULT_WATCHLIST.map(normalizeSymbol);

      saveState();
      renderWatchlist();
      renderGrid(); // 드롭다운 옵션 갱신
    });
  });
}

function addWatchSymbol(raw) {
  const sym = normalizeSymbol(raw);
  if (!sym) return;
  if (!state.watchlist.includes(sym)) state.watchlist.unshift(sym);
  if (!state.inputsMap[sym]) state.inputsMap[sym] = defaultInputs();
  saveState();
  renderWatchlist();
  renderGrid();
}

// ====== UI: Grid / Cards ======
function ensureInputs(sym) {
  const s = normalizeSymbol(sym);
  if (!s) return null;
  if (!state.inputsMap[s]) state.inputsMap[s] = defaultInputs();
  return state.inputsMap[s];
}

function optionsHtml(selected) {
  const opts = state.watchlist
    .map(sym => `<option value="${sym}" ${sym===selected?"selected":""}>${sym}</option>`)
    .join("");
  return `<option value="">(비움)</option>${opts}`;
}

function renderGrid() {
  const grid = $("grid");
  grid.innerHTML = "";

  for (let i=0; i<SLOT_COUNT; i++) {
    const sym = state.slots[i];
    const inputs = sym ? ensureInputs(sym) : defaultInputs();

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="row">
        <div class="title">슬롯 ${i+1}</div>
        <span class="pill neutral" id="trend_${i}">트렌드: —</span>
      </div>

      <label>코인 선택(와치리스트)</label>
      <select id="sym_${i}">${optionsHtml(sym)}</select>

      <label>투자금(USDT)</label>
      <input id="margin_${i}" type="number" step="0.01" value="${inputs.margin}"/>

      <label>레버리지</label>
      <select id="lev_${i}">
        ${LEV_OPTIONS.map(v => `<option value="${v}" ${Number(inputs.leverage)===v?"selected":""}>${v}x</option>`).join("")}
      </select>

      <label>진입가</label>
      <input id="entry_${i}" type="number" step="0.0000001" value="${inputs.entry}"/>

      <label>방향</label>
      <select id="side_${i}">
        <option value="LONG" ${String(inputs.side).toUpperCase()==="LONG"?"selected":""}>LONG</option>
        <option value="SHORT" ${String(inputs.side).toUpperCase()==="SHORT"?"selected":""}>SHORT</option>
      </select>

      <div class="row" style="gap:10px;margin-top:10px">
        <div style="flex:1">
          <label>목표수익(%)</label>
          <input id="tp_${i}" type="number" step="0.1" value="${inputs.tp_pct}"/>
        </div>
        <div style="flex:1">
          <label>손절(%)</label>
          <input id="sl_${i}" type="number" step="0.1" value="${inputs.sl_pct}"/>
        </div>
      </div>

      <label>근접기준(%)</label>
      <input id="near_${i}" type="number" step="0.1" value="${inputs.near_pct}"/>

      <div class="big" id="price_${i}">현재가: —</div>
      <div class="muted" id="ma30_${i}">MA30: —</div>

      <div style="margin-top:10px">
        <div>Long TP: <b id="ltp_${i}">-</b></div>
        <div>Long SL: <b id="lsl_${i}">-</b></div>
        <div>Short TP: <b id="stp_${i}">-</b></div>
        <div>Short SL: <b id="ssl_${i}">-</b></div>
      </div>

      <div style="margin-top:10px">
        <div>상태: <b id="status_${i}">-</b></div>
        <div>예상마진(PnL USDT): <b id="pnl_${i}">-</b></div>
        <div>ROI(%): <b id="roi_${i}">-</b></div>
        <div class="muted" id="meta_${i}">—</div>
      </div>

      <div style="margin-top:10px">
        <span class="pill neutral" id="reco_${i}">추천: —</span>
      </div>
    `;
    grid.appendChild(card);

    // bind events
    bindSlotEvents(i);
  }
}

function bindSlotEvents(i) {
  const symSel = $(`sym_${i}`);
  const marginEl = $(`margin_${i}`);
  const levEl = $(`lev_${i}`);
  const entryEl = $(`entry_${i}`);
  const sideEl = $(`side_${i}`);
  const tpEl = $(`tp_${i}`);
  const slEl = $(`sl_${i}`);
  const nearEl = $(`near_${i}`);

  function onChange() {
    const sym = normalizeSymbol(symSel.value);
    state.slots[i] = sym;

    if (sym) {
      const inp = ensureInputs(sym);
      inp.margin = Number(marginEl.value) || inp.margin;
      inp.leverage = Number(levEl.value) || inp.leverage;
      inp.entry = Number(entryEl.value) || 0;
      inp.side = String(sideEl.value || "LONG").toUpperCase();
      inp.tp_pct = Number(tpEl.value) || inp.tp_pct;
      inp.sl_pct = Number(slEl.value) || inp.sl_pct;
      inp.near_pct = Number(nearEl.value) || inp.near_pct;
    }

    saveState();
  }

  // 심볼 변경 시: 해당 심볼 inputs를 로드해서 입력칸 갱신
  symSel.addEventListener("change", () => {
    const sym = normalizeSymbol(symSel.value);
    state.slots[i] = sym;

    if (sym) {
      const inp = ensureInputs(sym);
      marginEl.value = inp.margin;
      levEl.value = inp.leverage;
      entryEl.value = inp.entry;
      sideEl.value = inp.side;
      tpEl.value = inp.tp_pct;
      slEl.value = inp.sl_pct;
      nearEl.value = inp.near_pct;
    } else {
      // 비움
      marginEl.value = defaultInputs().margin;
      levEl.value = defaultInputs().leverage;
      entryEl.value = 0;
      sideEl.value = "LONG";
      tpEl.value = defaultInputs().tp_pct;
      slEl.value = defaultInputs().sl_pct;
      nearEl.value = defaultInputs().near_pct;
    }

    saveState();
  });

  [marginEl, levEl, entryEl, sideEl, tpEl, slEl, nearEl].forEach(el => {
    el.addEventListener("change", onChange);
  });
}

// ====== Live refresh ======
let state = loadState();

// 손실 진동 제어용
const lastVibrateAtBySlot = new Array(SLOT_COUNT).fill(0);
const lastPnlSignBySlot = new Array(SLOT_COUNT).fill(null);

function setTrendPill(i, trend) {
  const el = $(`trend_${i}`);
  if (!el) return;

  // index.html의 클래스(up/down/neutral) 활용
  el.classList.remove("up","down","neutral");
  if (trend === "UP") {
    el.classList.add("up");
    el.textContent = "트렌드: 상승";
  } else if (trend === "DOWN") {
    el.classList.add("down");
    el.textContent = "트렌드: 하락";
  } else {
    el.classList.add("neutral");
    el.textContent = "트렌드: 중립";
  }
}

function setRecoPill(i, recommend) {
  const el = $(`reco_${i}`);
  if (!el) return;
  el.classList.remove("ok","warn","neutral","hit");

  const txt = String(recommend || "—");
  el.textContent = `추천: ${txt}`;

  if (txt.includes("오류")) el.classList.add("hit");
  else if (txt.includes("⚠") || txt.includes("비추천")) el.classList.add("warn");
  else if (txt.includes("추천")) el.classList.add("ok");
  else el.classList.add("neutral");
}

function clearTpSlEffects(i) {
  const ids = [`ltp_${i}`, `lsl_${i}`, `stp_${i}`, `ssl_${i}`];
  ids.forEach(id => {
    const el = $(id);
    if (!el) return;
    el.classList.remove("blink-sl", "tp-near", "hit-tp", "hit-sl");
    el.style.color = ""; // reset inline color
    el.style.fontWeight = "";
  });
}

function applyTpSlEffects(i, status, side) {
  clearTpSlEffects(i);

  const s = String(status || "");
  const chosenTP = side === "SHORT" ? `stp_${i}` : `ltp_${i}`;
  const chosenSL = side === "SHORT" ? `ssl_${i}` : `lsl_${i}`;

  const tpEl = $(chosenTP);
  const slEl = $(chosenSL);

  if (s.includes("TP 근접") && tpEl) {
    tpEl.classList.add("tp-near"); // 초록 강조
  }
  if (s.includes("SL 근접") && slEl) {
    slEl.classList.add("blink-sl"); // 노란 점멸
  }
  if (s.includes("TP 터치") && tpEl) {
    tpEl.classList.add("hit-tp");
  }
  if (s.includes("SL 터치") && slEl) {
    slEl.classList.add("hit-sl");
  }
}

function vibrateLoss(i, pnl) {
  // 모바일에서만 + 브라우저가 지원할 때만
  if (!isMobile() || typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;

  const now = Date.now();
  if (now - lastVibrateAtBySlot[i] < VIBRATE_COOLDOWN_MS) return;

  // 손실 진입 순간(부호가 +/null -> -로 바뀔 때) 또는 SL 근접/터치 시에는 더 적극적으로 울릴 수 있음
  if (pnl < 0) {
    lastVibrateAtBySlot[i] = now;
    // 짧게 2번
    navigator.vibrate([120, 80, 120]);
  }
}

async function refreshOnce() {
  // 슬롯에서 선택된 심볼들만 요청
  const activeSyms = Array.from(new Set(state.slots.filter(Boolean)));
  if (!activeSyms.length) {
    $("syncInfo").textContent = "선택된 심볼이 없습니다.";
    return;
  }

  // 심볼별 입력값 모아서 서버로 전달
  const inputsMap = {};
  for (const sym of activeSyms) {
    inputsMap[sym] = ensureInputs(sym);
  }

  const qs = new URLSearchParams({
    symbols: activeSyms.join(","),
    inputsMap: JSON.stringify(inputsMap)
  });

  let json;
  try {
    const res = await fetch(`/api/dash_batch?${qs.toString()}`);
    json = await res.json();
    if (!res.ok) throw new Error(json?.error || "API error");
  } catch (e) {
    $("syncInfo").textContent = `연결 오류: ${e.message || e}`;
    return;
  }

  const bySymbol = {};
  (json.results || []).forEach(r => {
    const sym = normalizeSymbol(r.symbol);
    bySymbol[sym] = r;
  });

  // 화면 갱신
  for (let i=0; i<SLOT_COUNT; i++) {
    const sym = state.slots[i];
    if (!sym) {
      // 비어있는 슬롯
      $(`price_${i}`).textContent = "현재가: —";
      $(`ma30_${i}`).textContent = "MA30: —";
      $(`status_${i}`).textContent = "-";
      $(`pnl_${i}`).textContent = "-";
      $(`roi_${i}`).textContent = "-";
      $(`meta_${i}`).textContent = "—";
      setTrendPill(i, "NEUTRAL");
      setRecoPill(i, "—");
      clearTpSlEffects(i);
      continue;
    }

    const r = bySymbol[normalizeSymbol(sym)];
    if (!r) {
      $(`price_${i}`).textContent = "현재가: (데이터 없음)";
      $(`meta_${i}`).textContent = "—";
      continue;
    }

    // Trend/Recommend
    setTrendPill(i, r.trend);
    setRecoPill(i, r.recommend);

    // Price/MA30
    $(`price_${i}`).textContent = `현재가: ${fmt(r.price, 6)}`;
    $(`ma30_${i}`).textContent = `MA30: ${fmt(r.ma30, 6)}`;

    // TP/SL 값 표시
    const tp = r.tp_sl || {};
    $(`ltp_${i}`).textContent = fmt(tp.longTP, 6);
    $(`lsl_${i}`).textContent = fmt(tp.longSL, 6);
    $(`stp_${i}`).textContent = fmt(tp.shortTP, 6);
    $(`ssl_${i}`).textContent = fmt(tp.shortSL, 6);

    // Status
    const status = r.status || "";
    $(`status_${i}`).textContent = status || "-";

    // PnL / ROI 표시 + 색상
    const pnlEl = $(`pnl_${i}`);
    const roiEl = $(`roi_${i}`);

    const pnl = Number(r.pnl);
    const roi = Number(r.roi);

    pnlEl.textContent = Number.isFinite(pnl) ? fmt(pnl, 6) : "-";
    roiEl.textContent = Number.isFinite(roi) ? fmt(roi, 4) : "-";

    // ✅ 요청: 수익=빨간색 / 손실=파란색 (텍스트 색상만)
    if (Number.isFinite(pnl)) {
      pnlEl.style.color = (pnl >= 0) ? "#ff4d4d" : "#4d79ff";
      pnlEl.style.fontWeight = "900";
    } else {
      pnlEl.style.color = "";
      pnlEl.style.fontWeight = "";
    }

    // (ROI도 같이 보고 싶으면 동일 적용 — 필요없으면 아래 2줄 삭제해도 됨)
    if (Number.isFinite(roi)) {
      roiEl.style.color = (roi >= 0) ? "#ff4d4d" : "#4d79ff";
      roiEl.style.fontWeight = "800";
    } else {
      roiEl.style.color = "";
      roiEl.style.fontWeight = "";
    }

    // ✅ 손실 시 모바일 진동 (쿨다운 적용)
    if (Number.isFinite(pnl)) {
      const prevSign = lastPnlSignBySlot[i];
      const curSign = pnl >= 0 ? "POS" : "NEG";
      lastPnlSignBySlot[i] = curSign;

      // 손실로 전환된 순간(또는 계속 손실인데 쿨다운 끝났을 때)
      if (curSign === "NEG" && prevSign !== "NEG") {
        vibrateLoss(i, pnl);
      }
    }

    // ✅ SL 근접 점멸 / TP 근접 강조 / 터치 색상
    const side = String((ensureInputs(sym)?.side || "LONG")).toUpperCase();
    applyTpSlEffects(i, status, side);

    // Meta
    $(`meta_${i}`).textContent = r.updated_at ? `업데이트: ${new Date(r.updated_at).toLocaleTimeString()}` : "—";
  }

  $("syncInfo").textContent = `동기화: ${new Date().toLocaleTimeString()} / ${activeSyms.length}개`;
}

// ====== Header buttons ======
$("btnWatch").addEventListener("click", openDrawer);
$("btnClose").addEventListener("click", closeDrawer);
$("backdrop").addEventListener("click", closeDrawer);

$("wlAdd").addEventListener("click", () => {
  addWatchSymbol($("wlInput").value);
  $("wlInput").value = "";
});
$("wlInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    addWatchSymbol($("wlInput").value);
    $("wlInput").value = "";
  }
});

// 슬롯 초기화(모바일/PC 표시 개수는 CSS가 처리, 슬롯 자체는 12 유지)
$("btnReset").addEventListener("click", () => {
  state = defaultState();
  saveState();
  renderGrid();
});

// ====== Init ======
renderGrid();
refreshOnce();
setInterval(refreshOnce, REFRESH_MS);
