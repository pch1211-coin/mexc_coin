/****************************************************
 * MEXC DASH Web - public/app.js (FULL REPLACE)
 *
 * ✅ 포함 기능
 * - PnL(예상마진) 글자색: 수익=빨강 / 손실=파랑
 * - 손실 시 모바일 진동 경고 (옵션/쿨다운 포함)
 * - SL 근접 시 점멸(빨강 점멸)
 * - TP 근접 시 강조(연두/노랑 강조)
 * - /api 가 HTML(<DOCTYPE)로 오는 경우 자동 감지 + 안내 문구 표시
 *
 * ✅ 계산 방식(구글 DASH와 동일)
 * - Size(USDT) = Margin * Leverage
 * - LONG  : frac = (price - entry) / entry
 * - SHORT : frac = (entry - price) / entry
 * - PnL(USDT) = Size * frac
 * - ROI(%) = (PnL / Margin) * 100
 ****************************************************/

// ====== Config ======
const TREND_BAND_PCT = 0.3;
const REFRESH_MS = 3000; // 가격 갱신 주기
const MA30_CACHE_MS = 5 * 60 * 1000; // MA30 로컬 캐시 5분
const VIBRATE_COOLDOWN_MS = 8000; // 진동 쿨다운(너무 자주 울리지 않게)

const DEFAULT_WATCHLIST = [
  "BTCUSDT","ETHUSDT","COREUSDT","WLDUSDT","PIUSDT","DOGEUSDT","XRPUSDT","TRXUSDT"
];

const LEV_OPTIONS = [1,3,5,10,15,20,25,30,35,40,45,50];
const SLOT_COUNT = 12; // PC 12, 모바일은 CSS 그리드로 6개가 한 화면 목표(스크롤은 가능)

// ====== Storage ======
function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || ""); }
  catch { return fallback; }
}
function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

// ====== Helpers ======
function normSymbol(input) {
  const s = String(input || "").trim().toUpperCase();
  if (!s) return "";
  if (s.includes("_")) return s;
  if (s.endsWith("USDT")) return s.replace(/USDT$/, "_USDT");
  return s;
}

function fmt(n, d=6) {
  if (!isFinite(n)) return "-";
  // 큰 값은 소수점 줄이기
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 10) return n.toFixed(3);
  return n.toFixed(d);
}
function pct(n, d=2) {
  if (!isFinite(n)) return "-";
  return n.toFixed(d);
}

function nowKST() {
  // 브라우저 로컬 기준 표시(한국이면 KST)
  const dt = new Date();
  const hh = String(dt.getHours()).padStart(2,"0");
  const mm = String(dt.getMinutes()).padStart(2,"0");
  const ss = String(dt.getSeconds()).padStart(2,"0");
  return `${hh}:${mm}:${ss}`;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setHTML(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function addClass(el, cls, on=true) {
  if (!el) return;
  if (on) el.classList.add(cls);
  else el.classList.remove(cls);
}

// ====== Inject CSS (index.html 안 고치고 기능 추가) ======
(function injectStyles(){
  const css = `
    .pnl-profit{ color:#ff4d4d !important; font-weight:900; }
    .pnl-loss{ color:#4d79ff !important; font-weight:900; }
    .pnl-flat{ color:#e8f0ff !important; font-weight:900; }

    /* TP 근접 강조 */
    .tp-near{ color:#59d38a !important; font-weight:900; }

    /* SL 근접 점멸 */
    @keyframes blinkRed { 0%,100%{opacity:1} 50%{opacity:.25} }
    .sl-blink{ animation: blinkRed 0.55s linear infinite; color:#ff5a5a !important; font-weight:900; }

    /* 카드 테두리(요청이 “텍스트만”이라도 최소 표시) */
    .card-border-profit{ border-color:#ff4d4d !important; box-shadow:0 0 0 1px rgba(255,77,77,.15) inset; }
    .card-border-loss{ border-color:#4d79ff !important; box-shadow:0 0 0 1px rgba(77,121,255,.15) inset; }
    .card-border-warn{ border-color:#ffd36b !important; box-shadow:0 0 0 1px rgba(255,211,107,.18) inset; }
  `;
  const tag = document.createElement("style");
  tag.textContent = css;
  document.head.appendChild(tag);
})();

// ====== State ======
const KEY_WL = "mexc_dash_watchlist_v1";
const KEY_SLOTS = "mexc_dash_slots_v1";
const KEY_PRICE_MODE = "mexc_dash_price_mode_v1";

let watchlist = loadJSON(KEY_WL, DEFAULT_WATCHLIST).map(normSymbol).filter(Boolean);
watchlist = Array.from(new Set(watchlist));

/**
 * slots: [{symbol, margin, lev, entry, side, tpPct, slPct, nearPct}]
 * 빈 슬롯은 null
 */
let slots = loadJSON(KEY_SLOTS, []);
if (!Array.isArray(slots) || slots.length !== SLOT_COUNT) {
  slots = Array.from({length: SLOT_COUNT}, () => null);
}

let priceMode = loadJSON(KEY_PRICE_MODE, "fair"); // fair | last | index
if (!["fair","last","index"].includes(priceMode)) priceMode = "fair";

let timer = null;
let lastVibrateAt = 0;

// MA30 local cache
const ma30Cache = new Map(); // symbol -> {value, ts}

// ====== API Fetch (HTML 반환 방지/진단 포함) ======
async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const txt = await res.text();

  // HTML이 온 경우(=<!DOCTYPE...) JSON.parse 금지
  if (txt.trim().startsWith("<")) {
    const msg =
      `연결 오류: API가 JSON이 아니라 HTML을 반환했습니다.\n` +
      `- Render가 Static Site로 배포되어 /api 요청이 index.html로 가는 상태일 수 있어요.\n` +
      `- 해결: Render를 Web Service(node)로 배포하고 server.js에서 /api 라우팅을 처리해야 합니다.\n` +
      `요청: ${url}`;
    throw new Error(msg);
  }

  // content-type이 json이 아니어도 파싱 시도(서버가 헤더를 안 붙이는 경우 대비)
  try { return JSON.parse(txt); }
  catch (e) {
    throw new Error(`JSON 파싱 실패: ${e?.message || e}\n응답 일부: ${txt.slice(0,120)}...`);
  }
}

async function apiTicker(symbol) {
  // ✅ 같은 도메인에서 Web Service로 돌 때: /api/ticker
  // 서버가 다른 경우라면 여기를 절대 URL로 바꿔야 함
  const s = normSymbol(symbol);
  return fetchJSON(`/api/ticker?symbol=${encodeURIComponent(s)}`);
}

async function apiMA30(symbol) {
  const s = normSymbol(symbol);

  const cached = ma30Cache.get(s);
  if (cached && (Date.now() - cached.ts) < MA30_CACHE_MS) {
    return { ma30: cached.value, cached: true };
  }

  const data = await fetchJSON(`/api/ma30?symbol=${encodeURIComponent(s)}`);
  const v = Number(data?.ma30);
  if (isFinite(v)) {
    ma30Cache.set(s, { value: v, ts: Date.now() });
  }
  return { ma30: v, cached: false };
}

// ====== Calc ======
function calcTrend(price, ma30, prevTrend) {
  if (!isFinite(price) || !isFinite(ma30) || ma30 <= 0) return "NONE";
  const upper = ma30 * (1 + TREND_BAND_PCT / 100);
  const lower = ma30 * (1 - TREND_BAND_PCT / 100);
  if (price >= lower && price <= upper) return prevTrend || "NEUTRAL";
  if (price > upper) return "UP";
  if (price < lower) return "DOWN";
  return prevTrend || "NEUTRAL";
}

function calcTPSL(entry, tpPct, slPct) {
  const longTP = entry * (1 + tpPct/100);
  const longSL = entry * (1 - slPct/100);
  const shortTP = entry * (1 - tpPct/100);
  const shortSL = entry * (1 + slPct/100);
  return { longTP, longSL, shortTP, shortSL };
}

function fracBySide(side, entry, price) {
  if (!isFinite(entry) || entry === 0 || !isFinite(price)) return 0;
  const S = String(side || "LONG").toUpperCase();
  return (S === "SHORT")
    ? ((entry - price) / entry)
    : ((price - entry) / entry);
}

function nearPctHit(price, target, nearPct) {
  if (!isFinite(price) || price === 0 || !isFinite(target) || !isFinite(nearPct)) return false;
  return (Math.abs(price - target) / price) * 100 <= nearPct;
}

// ====== UI Render ======
const grid = document.getElementById("grid");
const drawer = document.getElementById("drawer");
const wlList = document.getElementById("wlList");
const wlInput = document.getElementById("wlInput");

const btnWatch = document.getElementById("btnWatch");
const btnClose = document.getElementById("btnClose");
const btnReset = document.getElementById("btnReset");
const backdrop = document.getElementById("backdrop");
const wlAdd = document.getElementById("wlAdd");
const syncInfo = document.getElementById("syncInfo");

btnWatch.addEventListener("click", () => openDrawer(true));
btnClose.addEventListener("click", () => openDrawer(false));
backdrop.addEventListener("click", () => openDrawer(false));

btnReset.addEventListener("click", () => {
  if (!confirm("슬롯(카드) 12개를 초기화할까요?")) return;
  slots = Array.from({length:SLOT_COUNT}, () => null);
  saveJSON(KEY_SLOTS, slots);
  renderAll();
});

wlAdd.addEventListener("click", () => {
  const s = normSymbol(wlInput.value);
  if (!s) return;
  if (!watchlist.includes(s)) watchlist.unshift(s);
  watchlist = Array.from(new Set(watchlist));
  saveJSON(KEY_WL, watchlist);
  wlInput.value = "";
  renderWatchlist();
  renderAll(); // dropdown 업데이트
});

function openDrawer(on) {
  drawer.classList.toggle("open", !!on);
  if (on) renderWatchlist();
}

function renderWatchlist() {
  wlList.innerHTML = "";
  watchlist.forEach(sym => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `<code>${sym}</code>`;
    const del = document.createElement("button");
    del.className = "xbtn";
    del.textContent = "삭제";
    del.onclick = () => {
      if (!confirm(`${sym} 를 와치리스트에서 삭제할까요?`)) return;
      watchlist = watchlist.filter(x => x !== sym);
      saveJSON(KEY_WL, watchlist);

      // 슬롯에서 해당 심볼을 쓰고 있으면 그대로 두되, 드롭다운 목록에서만 제거됨
      renderWatchlist();
      renderAll();
    };
    row.appendChild(del);
    wlList.appendChild(row);
  });
}

function makeSelect(options, value, onChange) {
  const sel = document.createElement("select");
  options.forEach(o => {
    const opt = document.createElement("option");
    opt.value = String(o.value);
    opt.textContent = String(o.label);
    sel.appendChild(opt);
  });
  sel.value = String(value);
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

function makeInput(value, onInput, type="number", step="any") {
  const inp = document.createElement("input");
  inp.type = type;
  inp.step = step;
  inp.value = (value ?? "") === null ? "" : String(value ?? "");
  inp.addEventListener("input", () => onInput(inp.value));
  return inp;
}

function slotDefault(symbol) {
  return {
    symbol: normSymbol(symbol),
    margin: 5.8,
    lev: 20,
    entry: 0,
    side: "SHORT",
    tpPct: 1.5,
    slPct: 0.7,
    nearPct: 0.2,
    prevTrend: "NEUTRAL",
  };
}

function renderAll() {
  grid.innerHTML = "";
  for (let i=0; i<SLOT_COUNT; i++) {
    grid.appendChild(renderSlot(i));
  }
}

function renderSlot(slotIndex) {
  const st = slots[slotIndex];

  const card = document.createElement("div");
  card.className = "card";
  card.id = `card_${slotIndex}`;

  // 비어있는 슬롯
  if (!st) {
    card.innerHTML = `
      <div class="row">
        <div class="title">슬롯 ${slotIndex+1}</div>
        <span class="muted">비어있음</span>
      </div>
      <div style="margin-top:10px">
        <label>심볼 선택</label>
        <div id="pick_${slotIndex}"></div>
        <div class="muted" style="margin-top:8px">와치리스트에서 심볼을 추가/삭제할 수 있어요.</div>
      </div>
    `;

    const pick = card.querySelector(`#pick_${slotIndex}`);
    const sel = makeSelect(
      watchlist.map(s => ({value:s, label:s})),
      watchlist[0] || "BTC_USDT",
      (v) => {
        slots[slotIndex] = slotDefault(v);
        saveJSON(KEY_SLOTS, slots);
        renderAll();
      }
    );
    pick.appendChild(sel);
    return card;
  }

  // 카드 UI
  card.innerHTML = `
    <div class="row">
      <div class="title">${st.symbol}</div>
      <span class="muted" id="updated_${slotIndex}">—</span>
    </div>

    <label>투자금(USDT) = Margin</label>
    <div id="margin_${slotIndex}"></div>

    <label>레버리지</label>
    <div id="lev_${slotIndex}"></div>

    <label>진입가(Entry / Avg)</label>
    <div id="entry_${slotIndex}"></div>

    <label>방향(롱/숏)</label>
    <div id="side_${slotIndex}"></div>

    <label>목표수익(%)</label>
    <div id="tpPct_${slotIndex}"></div>

    <label>손절(%)</label>
    <div id="slPct_${slotIndex}"></div>

    <label>근접기준(%)</label>
    <div id="nearPct_${slotIndex}"></div>

    <div style="margin-top:10px">
      <div class="row">
        <span class="pill neutral" id="trend_${slotIndex}">트렌드: -</span>
        <span class="pill neutral" id="status_${slotIndex}">상태: -</span>
      </div>

      <div class="big">가격: <b id="price_${slotIndex}">-</b></div>
      <div class="muted">MA30: <b id="ma30_${slotIndex}">-</b></div>

      <div class="muted" style="margin-top:6px">
        Long TP/SL: <b id="ltpsl_${slotIndex}">-</b><br/>
        Short TP/SL: <b id="stpsl_${slotIndex}">-</b>
      </div>

      <div style="margin-top:10px">
        <div>Size(USDT): <b id="size_${slotIndex}">-</b></div>
        <div>예상마진(PnL USDT): <b id="pnl_${slotIndex}">-</b></div>
        <div>ROI(%): <b id="roi_${slotIndex}">-</b></div>
        <div class="muted" id="meta_${slotIndex}">—</div>
      </div>
    </div>

    <div style="margin-top:10px" class="row">
      <button class="btn" id="remove_${slotIndex}">카드 제거</button>
    </div>
  `;

  // bindings
  card.querySelector(`#remove_${slotIndex}`).onclick = () => {
    slots[slotIndex] = null;
    saveJSON(KEY_SLOTS, slots);
    renderAll();
  };

  // Inputs
  card.querySelector(`#margin_${slotIndex}`).appendChild(
    makeInput(st.margin, (v) => { st.margin = Number(v)||0; saveJSON(KEY_SLOTS, slots); })
  );

  card.querySelector(`#lev_${slotIndex}`).appendChild(
    makeSelect(
      LEV_OPTIONS.map(n=>({value:n,label:`${n}x`})),
      st.lev,
      (v) => { st.lev = Number(v)||1; saveJSON(KEY_SLOTS, slots); }
    )
  );

  card.querySelector(`#entry_${slotIndex}`).appendChild(
    makeInput(st.entry, (v)=>{ st.entry = Number(v)||0; saveJSON(KEY_SLOTS, slots); })
  );

  card.querySelector(`#side_${slotIndex}`).appendChild(
    makeSelect(
      [{value:"LONG",label:"LONG"},{value:"SHORT",label:"SHORT"}],
      st.side,
      (v)=>{ st.side = String(v).toUpperCase(); saveJSON(KEY_SLOTS, slots); }
    )
  );

  card.querySelector(`#tpPct_${slotIndex}`).appendChild(
    makeInput(st.tpPct, (v)=>{ st.tpPct = Number(v)||0; saveJSON(KEY_SLOTS, slots); }, "number", "0.1")
  );

  card.querySelector(`#slPct_${slotIndex}`).appendChild(
    makeInput(st.slPct, (v)=>{ st.slPct = Number(v)||0; saveJSON(KEY_SLOTS, slots); }, "number", "0.1")
  );

  card.querySelector(`#nearPct_${slotIndex}`).appendChild(
    makeInput(st.nearPct, (v)=>{ st.nearPct = Number(v)||0; saveJSON(KEY_SLOTS, slots); }, "number", "0.1")
  );

  return card;
}

// ====== Update Loop ======
async function tickOnce() {
  const startedAt = Date.now();
  let okCount = 0;

  for (let i=0; i<SLOT_COUNT; i++) {
    const st = slots[i];
    if (!st?.symbol) continue;

    const card = document.getElementById(`card_${i}`);
    const pnlEl = document.getElementById(`pnl_${i}`);
    const roiEl = document.getElementById(`roi_${i}`);
    const priceEl = document.getElementById(`price_${i}`);
    const ma30El = document.getElementById(`ma30_${i}`);
    const trendEl = document.getElementById(`trend_${i}`);
    const statusEl = document.getElementById(`status_${i}`);
    const updatedEl = document.getElementById(`updated_${i}`);
    const metaEl = document.getElementById(`meta_${i}`);
    const sizeEl = document.getElementById(`size_${i}`);
    const ltpslEl = document.getElementById(`ltpsl_${i}`);
    const stpslEl = document.getElementById(`stpsl_${i}`);

    // reset visual
    if (pnlEl) {
      pnlEl.classList.remove("pnl-profit","pnl-loss","pnl-flat","tp-near","sl-blink");
    }
    if (card) {
      card.classList.remove("card-border-profit","card-border-loss","card-border-warn");
    }

    try {
      // 1) ticker
      const t = await apiTicker(st.symbol);
      const last = Number(t?.last);
      const fair = Number(t?.fair);
      const index = Number(t?.index);

      const price =
        priceMode === "last" ? last :
        priceMode === "index" ? index :
        fair;

      // 2) ma30
      const m = await apiMA30(st.symbol);
      const ma30 = Number(m?.ma30);

      // display
      if (priceEl) priceEl.textContent = `${fmt(price, 6)} (${priceMode})`;
      if (ma30El) ma30El.textContent = isFinite(ma30) ? fmt(ma30, 6) : "-";
      if (updatedEl) updatedEl.textContent = `업데이트: ${nowKST()}`;
      if (metaEl) metaEl.textContent = `MA30: ${m.cached ? "캐시" : "갱신"} / ${priceMode.toUpperCase()}`;

      // trend
      const tkey = calcTrend(price, ma30, st.prevTrend);
      st.prevTrend = tkey === "NONE" ? st.prevTrend : tkey;

      if (trendEl) {
        trendEl.className = "pill " + (tkey==="UP"?"up":tkey==="DOWN"?"down":"neutral");
        trendEl.textContent = `트렌드: ${tkey==="UP"?"상승":tkey==="DOWN"?"하락":tkey==="NEUTRAL"?"중립":"-"}`;
      }

      // tp/sl
      const entry = Number(st.entry)||0;
      const tpPct = Number(st.tpPct)||0;
      const slPct = Number(st.slPct)||0;
      const nearPct = Number(st.nearPct)||0;

      const { longTP, longSL, shortTP, shortSL } = calcTPSL(entry, tpPct, slPct);
      if (ltpslEl) ltpslEl.textContent = `${fmt(longTP)} / ${fmt(longSL)}`;
      if (stpslEl) stpslEl.textContent = `${fmt(shortTP)} / ${fmt(shortSL)}`;

      // pnl/roi
      const margin = Number(st.margin)||0;
      const lev = Math.max(1, Number(st.lev)||1);
      const size = margin * lev;
      if (sizeEl) sizeEl.textContent = fmt(size, 2);

      let pnl = 0, roi = 0;
      if (margin > 0 && entry > 0 && isFinite(price)) {
        const frac = fracBySide(st.side, entry, price);
        pnl = size * frac;
        roi = (pnl / margin) * 100;
      }

      // ===== PnL 색상(요청사항) =====
      if (pnlEl) {
        pnlEl.textContent = fmt(pnl, 6);
        if (pnl > 0) pnlEl.classList.add("pnl-profit");
        else if (pnl < 0) pnlEl.classList.add("pnl-loss");
        else pnlEl.classList.add("pnl-flat");
      }
      if (roiEl) roiEl.textContent = pct(roi, 4);

      // ===== 카드 테두리(가벼운 표시) =====
      if (card) {
        if (pnl > 0) card.classList.add("card-border-profit");
        else if (pnl < 0) card.classList.add("card-border-loss");
      }

      // ===== TP/SL 근접 판정 + 점멸/강조 =====
      let statusText = "-";
      const side = String(st.side||"LONG").toUpperCase();
      const tp = (side==="SHORT") ? shortTP : longTP;
      const sl = (side==="SHORT") ? shortSL : longSL;

      const isNearTP = nearPctHit(price, tp, nearPct);
      const isNearSL = nearPctHit(price, sl, nearPct);

      const hitTP = (side==="LONG") ? (price >= tp) : (price <= tp);
      const hitSL = (side==="LONG") ? (price <= sl) : (price >= sl);

      if (hitSL) {
        statusText = `${side} SL 터치/돌파`;
        if (card) card.classList.add("card-border-warn");
        if (pnlEl) pnlEl.classList.add("sl-blink"); // SL은 점멸로 더 강하게
      } else if (hitTP) {
        statusText = `${side} TP 터치/돌파`;
        if (pnlEl) pnlEl.classList.add("tp-near"); // TP는 강조
      } else if (isNearSL) {
        statusText = `${side} SL 근접`;
        if (pnlEl) pnlEl.classList.add("sl-blink"); // ✅ SL 근접 점멸(요청)
        if (card) card.classList.add("card-border-warn");
      } else if (isNearTP) {
        statusText = `${side} TP 근접`;
        if (pnlEl) pnlEl.classList.add("tp-near"); // ✅ TP 근접 강조(요청)
      }

      if (statusEl) {
        statusEl.className = "pill " + (
          hitSL || isNearSL ? "hit" :
          hitTP || isNearTP ? "ok" :
          "neutral"
        );
        statusEl.textContent = `상태: ${statusText}`;
      }

      // ===== 손실 진동/경고 (모바일) =====
      // - 손실(pnl<0)일 때만
      // - 너무 자주 울리지 않게 쿨다운 적용
      if (pnl < 0 && typeof navigator !== "undefined" && navigator.vibrate) {
        const tnow = Date.now();
        if (tnow - lastVibrateAt > VIBRATE_COOLDOWN_MS) {
          // 짧게 2번
          navigator.vibrate([120, 80, 120]);
          lastVibrateAt = tnow;
        }
      }

      okCount++;
      saveJSON(KEY_SLOTS, slots); // prevTrend 저장 포함
    } catch (e) {
      // 표시
      if (metaEl) metaEl.textContent = String(e?.message || e);

      // JSON 에러(HTML)면 상단에도 띄우기
      if (syncInfo) {
        syncInfo.textContent = `연결 오류: ${String(e?.message || e).slice(0,120)}`;
      }

      // 카드 경고 테두리
      if (card) card.classList.add("card-border-warn");
    }
  }

  const took = Date.now() - startedAt;
  if (syncInfo && okCount > 0) {
    syncInfo.textContent = `정상 갱신: ${okCount}개 / ${nowKST()} / ${took}ms`;
  }
}

function startLoop() {
  if (timer) return;
  tickOnce(); // 즉시 1회
  timer = setInterval(tickOnce, REFRESH_MS);
}
function stopLoop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

// ====== Boot ======
renderAll();
renderWatchlist();
startLoop();
