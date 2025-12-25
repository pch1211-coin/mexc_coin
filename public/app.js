// ====== Settings (Dash 방식 유지) ======
const TREND_BAND_PCT = 0.3;  // MA30 ±0.3% 밴드
const DEFAULTS = {
  margin: 5.8,
  lev: 20,
  entry: 0,
  side: "SHORT",
  tpPct: 1.5,
  slPct: 0.7,
  nearPct: 0.2
};

const STORAGE = {
  watch: "mexc_watchlist_v1",
  cards: "mexc_cards_v1",
  cardCfg: (sym) => `mexc_cardcfg_${sym}`
};

// ====== Basic helpers ======
const $ = (id) => document.getElementById(id);

function toContractSymbol(sym){
  const s = String(sym||"").trim().toUpperCase();
  if (!s) return "";
  if (s.includes("_")) return s;
  if (s.endsWith("USDT")) return s.replace(/USDT$/, "_USDT");
  return s;
}
function toUiSymbol(sym){
  // 카드 표시는 BTCUSDT 형태로 보기 편하게 (원하면 그대로도 OK)
  const s = String(sym||"").trim().toUpperCase();
  return s.includes("_") ? s.replace("_","") : s;
}
function num(v){
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function clampMin(n, m){ return n < m ? m : n; }
function fmt(n, d=4){
  if (!Number.isFinite(n)) return "-";
  // 큰 값은 소수 줄이기
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n.toLocaleString(undefined, { maximumFractionDigits: d });
}

// ====== Watchlist ======
function loadWatchlist(){
  const raw = localStorage.getItem(STORAGE.watch);
  if (raw){
    try{
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr.map(toContractSymbol);
    }catch{}
  }
  // 기본값
  const init = ["BTC_USDT","ETH_USDT","CORE_USDT","WLD_USDT","PI_USDT","DOGE_USDT"];
  localStorage.setItem(STORAGE.watch, JSON.stringify(init));
  return init;
}
function saveWatchlist(list){
  localStorage.setItem(STORAGE.watch, JSON.stringify(list));
}
function renderWatchSelect(list){
  const sel = $("watchSelect");
  sel.innerHTML = "";
  list.forEach(s=>{
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  });
}

// ====== Cards ======
function maxCards(){
  return window.matchMedia("(max-width: 820px)").matches ? 6 : 12;
}
function loadCards(){
  const raw = localStorage.getItem(STORAGE.cards);
  if (!raw) return [];
  try{
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(toContractSymbol) : [];
  }catch{
    return [];
  }
}
function saveCards(cards){
  localStorage.setItem(STORAGE.cards, JSON.stringify(cards));
}

function loadCardCfg(sym){
  const raw = localStorage.getItem(STORAGE.cardCfg(sym));
  if (!raw) return { ...DEFAULTS };
  try{
    const cfg = JSON.parse(raw);
    return { ...DEFAULTS, ...cfg };
  }catch{
    return { ...DEFAULTS };
  }
}
function saveCardCfg(sym, cfg){
  localStorage.setItem(STORAGE.cardCfg(sym), JSON.stringify(cfg));
}

// ====== API calls (our server) ======
async function apiTicker(sym){
  const r = await fetch(`/api/ticker?symbol=${encodeURIComponent(sym)}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "ticker fail");
  return j;
}
async function apiMA30(sym){
  const r = await fetch(`/api/ma30?symbol=${encodeURIComponent(sym)}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "ma30 fail");
  return j;
}

// ====== Trend / TP SL / PnL ROI (Dash 방식 동일) ======
function calcTP_SL(entry, tpPct, slPct){
  const longTP  = entry * (1 + tpPct/100);
  const longSL  = entry * (1 - slPct/100);
  const shortTP = entry * (1 - tpPct/100);
  const shortSL = entry * (1 + slPct/100);
  return { longTP, longSL, shortTP, shortSL };
}
function calcTrend(price, ma30){
  if (!price || !ma30) return { key:"NONE", text:"-", cls:"neu" };
  const upper = ma30 * (1 + TREND_BAND_PCT/100);
  const lower = ma30 * (1 - TREND_BAND_PCT/100);
  if (price > upper) return { key:"UP", text:"상승", cls:"up" };
  if (price < lower) return { key:"DOWN", text:"하락", cls:"down" };
  return { key:"NEUTRAL", text:"중립", cls:"neu" };
}
function calcPnlRoi({side, entry, price, margin, lev}){
  const m = num(margin);
  const L = clampMin(num(lev), 1);
  const size = m * L; // ✅ Dash 구조 유지: Size = Margin * Leverage
  if (!entry || !price || !m) return { size, pnl: 0, roi: 0 };

  const frac = (side === "SHORT")
    ? ((entry - price) / entry)
    : ((price - entry) / entry);

  const pnl = size * frac;     // ✅ Unrealized PnL(USDT)
  const roi = (pnl / m) * 100; // ✅ ROI(%)
  return { size, pnl, roi };
}
function validateTpSl(tpPct, slPct){
  if (!Number.isFinite(tpPct) || !Number.isFinite(slPct)) return { ok:false, msg:"TP/SL 값 오류" };
  if (tpPct <= 0 || slPct <= 0) return { ok:false, msg:"TP/SL은 0보다 커야 함" };
  if (tpPct > 50 || slPct > 50) return { ok:false, msg:"TP/SL%가 너무 큼(>50%)" };
  if (tpPct < slPct*1.3) return { ok:true, warn:true, msg:"권장: 목표수익 ≥ 손절×1.3" };
  return { ok:true, warn:false, msg:"" };
}
function recommendByTrend(trendKey){
  if (trendKey === "UP") return { text:"LONG 진입 추천", cls:"ok" };
  if (trendKey === "DOWN") return { text:"SHORT 진입 추천", cls:"ok" };
  if (trendKey === "NEUTRAL") return { text:"대기", cls:"wait" };
  return { text:"-", cls:"wait" };
}

// ====== UI: card template ======
function cardHTML(sym){
  const uiSym = sym; // BTC_USDT 형태로 보여줌(원하면 toUiSymbol(sym))
  return `
    <div class="card" data-sym="${sym}">
      <div class="cardHead">
        <div class="sym">${uiSym}</div>
        <div class="cardTopBtns">
          <span class="badge neu" data-role="trendBadge">트렌드: -</span>
          <button class="xbtn" data-role="removeOne">삭제</button>
        </div>
      </div>

      <div class="form">
        <div class="field">
          <label>투자금(USDT) = Margin</label>
          <input data-role="margin" inputmode="decimal" />
        </div>
        <div class="field">
          <label>레버리지</label>
          <select data-role="lev">
            ${[1,2,3,5,10,20,30,50,75,100,125,150].map(x=>`<option value="${x}">${x}x</option>`).join("")}
          </select>
        </div>

        <div class="field full">
          <label>진입가 (Entry / Avg Price)</label>
          <input data-role="entry" inputmode="decimal" />
        </div>

        <div class="field">
          <label>방향</label>
          <select data-role="side">
            <option value="LONG">LONG</option>
            <option value="SHORT" selected>SHORT</option>
          </select>
        </div>
        <div class="field">
          <label>목표수익(%)</label>
          <input data-role="tpPct" inputmode="decimal" />
        </div>

        <div class="field">
          <label>손절(%)</label>
          <input data-role="slPct" inputmode="decimal" />
        </div>
        <div class="field">
          <label>근접기준(%)</label>
          <input data-role="nearPct" inputmode="decimal" />
        </div>
      </div>

      <div class="kv"><span class="k">현재가</span><span class="v" data-role="price">-</span></div>
      <div class="kv"><span class="k">MA30</span><span class="v" data-role="ma30">-</span></div>

      <div class="kv"><span class="k">Long TP / SL</span><span class="v" data-role="longTpsl">-</span></div>
      <div class="kv"><span class="k">Short TP / SL</span><span class="v" data-role="shortTpsl">-</span></div>

      <div class="kv"><span class="k">Size(USDT)</span><span class="v" data-role="size">-</span></div>
      <div class="kv"><span class="k">예상마진(USDT) (PnL)</span><span class="v" data-role="pnl">-</span></div>
      <div class="kv"><span class="k">ROI(%)</span><span class="v" data-role="roi">-</span></div>

      <div class="kv"><span class="k">상태</span><span class="v" data-role="status">-</span></div>

      <div class="footerReco wait" data-role="reco">추천: -</div>
      <div class="small" data-role="updated">업데이트: -</div>
    </div>
  `;
}

function bindCardEvents(cardEl){
  const sym = cardEl.dataset.sym;
  const cfg = loadCardCfg(sym);

  // set defaults
  cardEl.querySelector('[data-role="margin"]').value = cfg.margin;
  cardEl.querySelector('[data-role="lev"]').value = cfg.lev;
  cardEl.querySelector('[data-role="entry"]').value = cfg.entry;
  cardEl.querySelector('[data-role="side"]').value = cfg.side;
  cardEl.querySelector('[data-role="tpPct"]').value = cfg.tpPct;
  cardEl.querySelector('[data-role="slPct"]').value = cfg.slPct;
  cardEl.querySelector('[data-role="nearPct"]').value = cfg.nearPct;

  // inputs -> save
  const saveNow = () => {
    const ncfg = {
      margin: num(cardEl.querySelector('[data-role="margin"]').value),
      lev: clampMin(num(cardEl.querySelector('[data-role="lev"]').value), 1),
      entry: num(cardEl.querySelector('[data-role="entry"]').value),
      side: String(cardEl.querySelector('[data-role="side"]').value || "SHORT").toUpperCase(),
      tpPct: num(cardEl.querySelector('[data-role="tpPct"]').value) || DEFAULTS.tpPct,
      slPct: num(cardEl.querySelector('[data-role="slPct"]').value) || DEFAULTS.slPct,
      nearPct: num(cardEl.querySelector('[data-role="nearPct"]').value) || DEFAULTS.nearPct
    };
    saveCardCfg(sym, ncfg);
  };

  ["margin","lev","entry","side","tpPct","slPct","nearPct"].forEach(role=>{
    cardEl.querySelector(`[data-role="${role}"]`).addEventListener("change", saveNow);
    cardEl.querySelector(`[data-role="${role}"]`).addEventListener("input", () => {
      // 입력 중에도 계산 반영(저장은 change에서)
      renderCardOnce(sym, cardEl, lastMarket.get(sym));
    });
  });

  cardEl.querySelector('[data-role="removeOne"]').addEventListener("click", ()=>{
    removeCard(sym);
  });
}

// ====== Render / Update ======
const lastMarket = new Map(); // sym -> {price, ma30, updatedAt, priceType, tickerRaw, maRaw}

function renderCards(){
  const grid = $("grid");
  const cards = loadCards();

  grid.innerHTML = "";
  cards.forEach(sym=>{
    grid.insertAdjacentHTML("beforeend", cardHTML(sym));
  });

  [...grid.querySelectorAll(".card")].forEach(bindCardEvents);
}

function addCard(sym){
  sym = toContractSymbol(sym);
  if (!sym) return;

  const cards = loadCards();
  const limit = maxCards();
  if (cards.includes(sym)) return;
  if (cards.length >= limit){
    alert(`카드는 최대 ${limit}개까지 가능합니다. (화면 크기 기준)`);
    return;
  }
  cards.push(sym);
  saveCards(cards);
  renderCards();
}

function removeCard(sym){
  const cards = loadCards().filter(s => s !== sym);
  saveCards(cards);
  renderCards();
}

function removeAllCards(){
  saveCards([]);
  renderCards();
}

function setPnlColor(el, pnl){
  el.classList.remove("good","bad");
  if (pnl > 0) el.classList.add("good");     // ✅ 수익 빨강
  else if (pnl < 0) el.classList.add("bad"); // ✅ 손실 파랑
}

function renderCardOnce(sym, cardEl, market){
  const cfg = loadCardCfg(sym);
  const priceType = $("priceMode").value; // fair/last/index

  const price = market?.price ?? 0;
  const ma30 = market?.ma30 ?? 0;

  // trend
  const tr = calcTrend(price, ma30);
  const badge = cardEl.querySelector('[data-role="trendBadge"]');
  badge.className = `badge ${tr.cls}`;
  badge.textContent = `트렌드: ${tr.text}`;

  // TP/SL
  const tpPct = num(cardEl.querySelector('[data-role="tpPct"]').value) || cfg.tpPct;
  const slPct = num(cardEl.querySelector('[data-role="slPct"]').value) || cfg.slPct;
  const entry = num(cardEl.querySelector('[data-role="entry"]').value) || cfg.entry;
  const nearPct = num(cardEl.querySelector('[data-role="nearPct"]').value) || cfg.nearPct;
  const side = String(cardEl.querySelector('[data-role="side"]').value || cfg.side).toUpperCase();

  const chk = validateTpSl(tpPct, slPct);
  const tpsl = calcTP_SL(entry, tpPct, slPct);

  cardEl.querySelector('[data-role="price"]').textContent = price ? `${fmt(price, 6)} (${priceType})` : "-";
  cardEl.querySelector('[data-role="ma30"]').textContent = ma30 ? fmt(ma30, 6) : "-";

  cardEl.querySelector('[data-role="longTpsl"]').textContent =
    entry ? `${fmt(tpsl.longTP, 6)} / ${fmt(tpsl.longSL, 6)}` : "-";
  cardEl.querySelector('[data-role="shortTpsl"]').textContent =
    entry ? `${fmt(tpsl.shortTP, 6)} / ${fmt(tpsl.shortSL, 6)}` : "-";

  // PnL/ROI (Dash 방식)
  const margin = num(cardEl.querySelector('[data-role="margin"]').value) || cfg.margin;
  const lev = clampMin(num(cardEl.querySelector('[data-role="lev"]').value) || cfg.lev, 1);

  const { size, pnl, roi } = calcPnlRoi({ side, entry, price, margin, lev });

  cardEl.querySelector('[data-role="size"]').textContent = size ? fmt(size, 2) : "-";

  const pnlEl = cardEl.querySelector('[data-role="pnl"]');
  pnlEl.textContent = entry && price ? fmt(pnl, 6) : "-";
  setPnlColor(pnlEl, pnl);

  const roiEl = cardEl.querySelector('[data-role="roi"]');
  roiEl.textContent = entry && price ? fmt(roi, 4) : "-";
  roiEl.classList.remove("good","bad");
  if (roi > 0) roiEl.classList.add("good");
  else if (roi < 0) roiEl.classList.add("bad");

  // Status (근접/터치)
  let status = "-";
  if (entry && price && chk.ok){
    const tp = (side === "SHORT") ? tpsl.shortTP : tpsl.longTP;
    const sl = (side === "SHORT") ? tpsl.shortSL : tpsl.longSL;

    const nearTP = Math.abs(price - tp) / price * 100 <= nearPct;
    const nearSL = Math.abs(price - sl) / price * 100 <= nearPct;

    const hitTP = (side === "LONG") ? (price >= tp) : (price <= tp);
    const hitSL = (side === "LONG") ? (price <= sl) : (price >= sl);

    if (hitSL) status = `${side} SL 터치/돌파`;
    else if (hitTP) status = `${side} TP 터치/돌파`;
    else if (nearSL) status = `${side} SL 근접`;
    else if (nearTP) status = `${side} TP 근접`;
    else status = "-";
  } else if (!chk.ok){
    status = `설정 오류: ${chk.msg}`;
  }
  const statusEl = cardEl.querySelector('[data-role="status"]');
  statusEl.textContent = status;
  statusEl.classList.remove("warn");
  if (!chk.ok) statusEl.classList.add("warn");

  // recommend
  let reco = recommendByTrend(tr.key);
  // trend 반대면 비추천
  if ((tr.key === "UP" && side === "SHORT") || (tr.key === "DOWN" && side === "LONG")){
    reco = { text:"비추천(트렌드 반대)", cls:"warn" };
  }
  if (chk.ok && chk.warn){
    reco = { text: `${reco.text} / ⚠ ${chk.msg}`, cls:"warn" };
  }
  if (!chk.ok){
    reco = { text: `설정 오류: ${chk.msg}`, cls:"warn" };
  }
  const recoEl = cardEl.querySelector('[data-role="reco"]');
  recoEl.className = `footerReco ${reco.cls}`;
  recoEl.textContent = `추천: ${reco.text}`;

  // updated
  const up = cardEl.querySelector('[data-role="updated"]');
  const ts = market?.updatedAt ? new Date(market.updatedAt) : null;
  up.textContent = ts ? `업데이트: ${ts.toLocaleTimeString()}` : `업데이트: -`;
}

// ====== Polling ======
let timer = null;

async function tickOnce(){
  const cards = loadCards();
  const priceType = $("priceMode").value;

  for (const sym of cards){
    try{
      const [t, m] = await Promise.all([
        apiTicker(sym),
        apiMA30(sym)
      ]);

      const price = (priceType === "last") ? t.last :
                    (priceType === "index") ? t.index : t.fair;

      lastMarket.set(sym, {
        price: num(price),
        ma30: num(m.ma30),
        updatedAt: Date.now(),
        priceType
      });

      const cardEl = document.querySelector(`.card[data-sym="${sym}"]`);
      if (cardEl) renderCardOnce(sym, cardEl, lastMarket.get(sym));
    } catch (e){
      const cardEl = document.querySelector(`.card[data-sym="${sym}"]`);
      if (cardEl){
        cardEl.querySelector('[data-role="status"]').textContent = `데이터 오류: ${String(e.message||e)}`;
        cardEl.querySelector('[data-role="status"]').classList.add("warn");
      }
    }
  }
}

function start(){
  if (timer) return;
  $("btnStart").disabled = true;
  $("btnStop").disabled = false;
  tickOnce();
  timer = setInterval(tickOnce, 5000);
}
function stop(){
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  $("btnStart").disabled = false;
  $("btnStop").disabled = true;
}

// ====== Boot ======
function boot(){
  // watchlist
  let watch = loadWatchlist();
  renderWatchSelect(watch);

  // cards
  const cards = loadCards();
  if (!cards.length){
    // 처음엔 선택된 심볼 1개만 카드로
    addCard(watch[0]);
  }else{
    renderCards();
  }

  // buttons
  $("btnAddWatch").addEventListener("click", ()=>{
    let sym = toContractSymbol($("watchInput").value);
    if (!sym) return;
    let list = loadWatchlist();
    if (!list.includes(sym)){
      list.push(sym);
      saveWatchlist(list);
      renderWatchSelect(list);
    }
    $("watchInput").value = "";
  });

  $("btnDelWatch").addEventListener("click", ()=>{
    const sel = $("watchSelect").value;
    if (!sel) return;
    let list = loadWatchlist().filter(s=>s!==sel);
    if (!list.length){
      alert("와치리스트는 최소 1개는 남겨야 합니다.");
      return;
    }
    saveWatchlist(list);
    renderWatchSelect(list);
    // 카드에서도 제거
    const cards = loadCards().filter(s=>s!==sel);
    saveCards(cards);
    renderCards();
  });

  $("btnAddCard").addEventListener("click", ()=>{
    const sel = $("watchSelect").value;
    addCard(sel);
  });

  $("btnRemoveAll").addEventListener("click", ()=>{
    if (confirm("카드를 모두 제거할까요?")) removeAllCards();
  });

  $("btnStart").addEventListener("click", start);
  $("btnStop").addEventListener("click", stop);

  $("priceMode").addEventListener("change", ()=>{
    // 모드 바꾸면 즉시 한번 반영
    tickOnce();
  });

  // 화면 크기 바뀌면 카드 제한만 안내 (자동 제거는 안 함)
  window.addEventListener("resize", ()=>{
    const limit = maxCards();
    const cur = loadCards().length;
    if (cur > limit){
      // 사용자 데이터를 지우진 않고 알림만
      console.log(`현재 카드 ${cur}개, 이 화면 기준 권장 최대 ${limit}개`);
    }
  });
}

boot();
