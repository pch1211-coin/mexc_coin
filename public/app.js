// ============================
// MEXC DASH Web - Full Client
// ============================

const TREND_BAND_PCT = 0.3;       // MA30 밴드 (DASH 동일)
const PRICE_REFRESH_MS = 5000;    // 가격 5초
const MA30_REFRESH_MS = 5 * 60 * 1000; // MA30 5분(서버 캐시)
const DEFAULT_TP = 1.5;
const DEFAULT_SL = 0.7;
const DEFAULT_NEAR = 0.2;

const LEV_LIST = [1,2,3,5,10,15,20,25,30,35,40,45,50];

// localStorage keys
const LS_WATCH = "mexc_watchlist_v1";
const LS_CARDS = "mexc_cards_v1";

const $ = (id) => document.getElementById(id);

// DOM
const grid = $("grid");
const watchSelect = $("watchSelect");
const watchAddInput = $("watchAddInput");
const btnAddWatch = $("btnAddWatch");
const btnRemoveWatch = $("btnRemoveWatch");

const btnAddCard = $("btnAddCard");
const btnRemoveCard = $("btnRemoveCard");

const btnStart = $("btnStart");
const btnStop = $("btnStop");

const priceBasis = $("priceBasis");
const modeText = $("modeText");
const ma30Timer = $("ma30Timer");

// state
let watchlist = [];
let cards = []; // array of {symbol, side, entry, margin, leverage, tp, sl, near}
let running = false;
let priceTimer = null;
let ma30TickTimer = null;

let lastMa30PullAt = 0;

// ---- helpers ----
function nowStr() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  const ss = String(d.getSeconds()).padStart(2,"0");
  return `${hh}:${mm}:${ss}`;
}

function normalizeSymbolForUI(s) {
  return String(s || "").trim().toUpperCase();
}
function normalizeSymbolForAPI(s) {
  const sym = normalizeSymbolForUI(s);
  if (!sym) return "";
  if (sym.includes("_")) return sym;
  if (sym.endsWith("USDT")) return sym.replace(/USDT$/, "_USDT");
  return sym;
}

function loadLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function saveLS(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function isMobile() {
  return window.matchMedia("(max-width: 599px)").matches;
}
function maxCards() {
  return isMobile() ? 6 : 12;
}

function setModeText() {
  modeText.textContent = `모드: ${isMobile() ? "모바일(최대 6개)" : "PC(최대 12개)"}`;
}

// ---- watchlist default ----
function defaultWatchlist() {
  return ["BTCUSDT","ETHUSDT","COREUSDT","WLDUSDT","PIUSDT","DOGEUSDT","XRPUSDT","TRXUSDT"];
}

function ensureInit() {
  watchlist = loadLS(LS_WATCH, defaultWatchlist());
  if (!Array.isArray(watchlist) || watchlist.length === 0) watchlist = defaultWatchlist();

  cards = loadLS(LS_CARDS, []);
  if (!Array.isArray(cards)) cards = [];

  // 카드가 너무 많으면 현재 모드에 맞게 잘라냄
  const m = maxCards();
  if (cards.length > m) cards = cards.slice(0, m);

  saveLS(LS_WATCH, watchlist);
  saveLS(LS_CARDS, cards);

  renderWatchSelect();
  renderCards();
  setModeText();
  updateMa30TimerLabel();
}

// ---- UI render ----
function renderWatchSelect() {
  watchSelect.innerHTML = "";
  watchlist.forEach(sym => {
    const opt = document.createElement("option");
    opt.value = sym;
    opt.textContent = sym;
    watchSelect.appendChild(opt);
  });
}

function makeLevSelect(value) {
  const sel = document.createElement("select");
  LEV_LIST.forEach(v => {
    const o = document.createElement("option");
    o.value = String(v);
    o.textContent = `${v}x`;
    if (Number(value) === v) o.selected = true;
    sel.appendChild(o);
  });
  return sel;
}

function computeTP_SL(entry, tpPct, slPct) {
  const e = Number(entry);
  const tp = Number(tpPct);
  const sl = Number(slPct);

  const longTP = e * (1 + tp/100);
  const longSL = e * (1 - sl/100);
  const shortTP = e * (1 - tp/100);
  const shortSL = e * (1 + sl/100);

  return { longTP, longSL, shortTP, shortSL };
}

function validateTpSl(tp, sl) {
  const t = Number(tp), s = Number(sl);
  if (!Number.isFinite(t) || !Number.isFinite(s)) return { ok:false, msg:"TP/SL 값 오류" };
  if (t <= 0 || s <= 0) return { ok:false, msg:"TP/SL은 0보다 커야 함" };
  if (t > 50 || s > 50) return { ok:false, msg:"TP/SL%가 너무 큼(>50%)" };
  if (t < s * 1.3) return { ok:true, warn:true, msg:"권장: 목표수익 ≥ 손절×1.3" };
  return { ok:true, warn:false, msg:"" };
}

function calcTrend(price, ma30, prevTrend) {
  if (!Number.isFinite(price) || !Number.isFinite(ma30) || ma30 === 0) return { key:"NONE", text:"" };

  const upper = ma30 * (1 + TREND_BAND_PCT/100);
  const lower = ma30 * (1 - TREND_BAND_PCT/100);

  if (price <= upper && price >= lower) return { key: prevTrend || "NEUTRAL", text: trendText(prevTrend || "NEUTRAL") };
  if (price > upper) return { key:"UP", text: trendText("UP") };
  if (price < lower) return { key:"DOWN", text: trendText("DOWN") };
  return { key: prevTrend || "NEUTRAL", text: trendText(prevTrend || "NEUTRAL") };
}
function trendText(k){
  if (k === "UP") return "상승 추세";
  if (k === "DOWN") return "하락 추세";
  if (k === "NEUTRAL") return "중립";
  return "";
}

function calcRecommend(trendKey, side) {
  const s = String(side || "LONG").toUpperCase();
  if (trendKey === "UP") {
    if (s === "SHORT") return { text:"비추천(트렌드 반대)", warn:true };
    return { text:"LONG 진입 추천", warn:false };
  }
  if (trendKey === "DOWN") {
    if (s === "LONG") return { text:"비추천(트렌드 반대)", warn:true };
    return { text:"SHORT 진입 추천", warn:false };
  }
  if (trendKey === "NEUTRAL") return { text:"대기", warn:false };
  return { text:"", warn:false };
}

function calcPnLRoi({side, entry, price, margin, lev}) {
  const e = Number(entry);
  const p = Number(price);
  const m = Number(margin);
  const l = Math.max(1, Number(lev));

  if (!Number.isFinite(e) || !Number.isFinite(p) || !Number.isFinite(m) || e <= 0 || m <= 0) {
    return { size:0, pnl:0, roi:0, frac:0, ok:false };
  }

  const size = m * l;
  const frac = (String(side).toUpperCase() === "SHORT") ? ((e - p) / e) : ((p - e) / e);
  const pnl = size * frac;
  const roi = (pnl / m) * 100;

  return { size, pnl, roi, frac, ok:true };
}

function calcStatus({side, price, tp, sl, nearPct}) {
  const s = String(side).toUpperCase();
  const p = Number(price);
  const TP = Number(tp);
  const SL = Number(sl);
  const near = Number(nearPct);

  if (!Number.isFinite(p) || !Number.isFinite(TP) || !Number.isFinite(SL) || p === 0) return { text:"", kind:"" };

  const nearTP = Math.abs(p - TP) / p * 100 <= near;
  const nearSL = Math.abs(p - SL) / p * 100 <= near;

  let hitTP=false, hitSL=false;
  if (s === "LONG") { hitTP = p >= TP; hitSL = p <= SL; }
  else { hitTP = p <= TP; hitSL = p >= SL; }

  if (hitSL) return { text:`${s} SL 터치/돌파`, kind:"hitSL" };
  if (hitTP) return { text:`${s} TP 터치/돌파`, kind:"hitTP" };
  if (nearSL) return { text:`${s} SL 근접`, kind:"nearSL" };
  if (nearTP) return { text:`${s} TP 근접`, kind:"nearTP" };
  return { text:"", kind:"" };
}

function renderCards() {
  grid.innerHTML = "";

  // 모드 변경 시 최대 카드 강제
  const m = maxCards();
  if (cards.length > m) {
    cards = cards.slice(0, m);
    saveLS(LS_CARDS, cards);
  }

  cards.forEach((c, idx) => {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.idx = String(idx);

    const title = document.createElement("h2");
    title.textContent = normalizeSymbolForUI(c.symbol);
    card.appendChild(title);

    const small = document.createElement("div");
    small.className = "small";
    small.textContent = "실시간 계산 카드";
    card.appendChild(small);

    // form
    const form = document.createElement("div");
    form.className = "form";

    // margin
    form.appendChild(field("투자금", makeInput(c.margin ?? 5.8, "number", "margin")));
    // leverage
    form.appendChild(field("레버리지", makeLevSelect(c.leverage ?? 20), "leverage"));
    // entry
    form.appendChild(field("진입가", makeInput(c.entry ?? 0, "number", "entry")));
    // side
    form.appendChild(field("방향", makeSelect(["LONG","SHORT"], c.side ?? "SHORT"), "side"));
    // tp
    form.appendChild(field("목표(%)", makeInput(c.tp ?? DEFAULT_TP, "number", "tp")));
    // sl
    form.appendChild(field("손절(%)", makeInput(c.sl ?? DEFAULT_SL, "number", "sl")));
    // near
    form.appendChild(field("근접(%)", makeInput(c.near ?? DEFAULT_NEAR, "number", "near")));

    card.appendChild(form);

    // badges
    const badges = document.createElement("div");
    badges.className = "badges";
    badges.innerHTML = `
      <span class="badge neutral" data-role="trendBadge">트렌드: -</span>
      <span class="badge" data-role="statusBadge">상태: -</span>
    `;
    card.appendChild(badges);

    // metrics
    const metrics = document.createElement("div");
    metrics.className = "metrics";
    metrics.innerHTML = `
      <div class="metricLine"><span class="label">현재가</span><span class="value big" data-role="price">-</span></div>
      <div class="metricLine"><span class="label">MA30</span><span class="value" data-role="ma30">-</span></div>
      <div class="metricLine"><span class="label">Long TP/SL</span><span class="value" data-role="longTPSL">-</span></div>
      <div class="metricLine"><span class="label">Short TP/SL</span><span class="value" data-role="shortTPSL">-</span></div>
      <div class="metricLine"><span class="label">Size(USDT)</span><span class="value" data-role="size">-</span></div>
      <div class="metricLine"><span class="label">예상마진(PnL)</span><span class="value pnl" data-role="pnl">-</span></div>
      <div class="metricLine"><span class="label">ROI(%)</span><span class="value roi" data-role="roi">-</span></div>
    `;
    card.appendChild(metrics);

    // recommend
    const reco = document.createElement("div");
    reco.className = "reco";
    reco.dataset.role = "reco";
    reco.textContent = "추천: -";
    card.appendChild(reco);

    // updated
    const updated = document.createElement("div");
    updated.className = "updated";
    updated.dataset.role = "updated";
    updated.textContent = "업데이트: -";
    card.appendChild(updated);

    grid.appendChild(card);

    // bind events
    bindCardInputs(card, idx);
  });
}

function field(label, inputEl, role) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const k = document.createElement("div");
  k.className = "k";
  k.textContent = label;
  const v = document.createElement("div");
  v.appendChild(inputEl);
  if (role) inputEl.dataset.role = role;
  wrap.appendChild(k);
  wrap.appendChild(v);
  return wrap;
}

function makeInput(value, type, role) {
  const inp = document.createElement("input");
  inp.type = type || "text";
  inp.value = String(value ?? "");
  inp.inputMode = "decimal";
  if (role) inp.dataset.role = role;
  return inp;
}

function makeSelect(list, value) {
  const sel = document.createElement("select");
  list.forEach(v => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    if (String(value).toUpperCase() === v) o.selected = true;
    sel.appendChild(o);
  });
  return sel;
}

function bindCardInputs(cardEl, idx) {
  const handler = () => {
    const c = cards[idx];
    if (!c) return;

    const getVal = (role) => cardEl.querySelector(`[data-role="${role}"]`);

    c.margin = Number(getVal("margin").value) || 0;
    c.leverage = Number(getVal("leverage").value) || 1;
    c.entry = Number(getVal("entry").value) || 0;
    c.side = String(getVal("side").value || "LONG").toUpperCase();
    c.tp = Number(getVal("tp").value) || DEFAULT_TP;
    c.sl = Number(getVal("sl").value) || DEFAULT_SL;
    c.near = Number(getVal("near").value) || DEFAULT_NEAR;

    saveLS(LS_CARDS, cards);
    // 입력 변경 즉시 재계산
    refreshOneCard(idx);
  };

  ["margin","entry","tp","sl","near"].forEach(r => {
    const el = cardEl.querySelector(`[data-role="${r}"]`);
    if (el) el.addEventListener("input", handler);
  });

  ["leverage","side"].forEach(r => {
    const el = cardEl.querySelector(`[data-role="${r}"]`);
    if (el) el.addEventListener("change", handler);
  });
}

// ---- API calls ----
async function apiTicker
