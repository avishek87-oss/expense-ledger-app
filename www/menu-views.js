'use strict';
// ── Monthly category totals ────────────────────────────────────────────────
function monthCategoryTotals(mk) {
  const md = getMDFor(mk), dim = daysInMonth(mk);
  let maids = MAIDS.reduce((s,m) => s + (isDiscontinued(m.key,mk) ? 0 : maidPayout(effectiveBase(mk,m.key,m.base), md.maidLeaves[m.key]??2, dim)), 0);
  if (mk >= '2026-08' && mk <= '2026-10' && !isDiscontinued('japaMaid',mk)) maids += japaMaidPayout(mk, md.japaDaysPresent);
  maids += customSectionTotal(mk, 'maids');
  const aavia = (isDiscontinued('schoolFees',mk) ? 0 : schoolTuition(mk)+schoolTermFee(mk)+schoolBusFee(mk))
    + (isDiscontinued('bizone',mk) ? 0 : bizoneFee(mk))
    + (!isDiscontinued('swimming',mk) && md.swimmingAttended ? effectiveBase(mk,'swimming',4000) : 0)
    + (!isDiscontinued('bharatnatyam',mk) && md.bharatnatyamAttended ? effectiveBase(mk,'bharatnatyam',1500) : 0)
    + (isDiscontinued('chess',mk) ? 0 : (md.chessDates||[]).length * effectiveBase(mk,'chessRate',500))
    + (isDiscontinued('skating',mk) ? 0 : (md.skatingDates||[]).length * effectiveBase(mk,'skatingRate',375))
    + (isDiscontinued('english',mk) ? 0 : englishFee(mk))
    + (md.aaviaMisc||[]).reduce((s,it)=>s+Number(it.amount||0),0)
    + customSectionTotal(mk, 'aavia');
  const fixed = (isDiscontinued('sukanya',mk) ? 0 : sukanyaFee(mk))
    + (isDiscontinued('carEmi',mk) ? 0 : carEmiFee(mk))
    + (isDiscontinued('rent',mk) ? 0 : effectiveBase(mk,'rent',rentFee(mk)))
    + customSectionTotal(mk, 'fixed');
  const sum = arr => (arr||[]).reduce((s,it)=>s+Number(it.amount||0),0);
  const household = sum(md.householdGroceries) + sum(md.householdMisc) + customSectionTotal(mk, 'household');
  const neha = sum(md.nehaMisc) + customSectionTotal(mk, 'neha');
  const avishek = sum(md.avishekMisc) + customSectionTotal(mk, 'avishek');
  return { maids, aavia, fixed, household, neha, avishek, total: maids+aavia+fixed+household+neha+avishek };
}

// ── Hero: tap-to-expand Monthly Spends / Source of Spends (current month) ──
function toggleHeroSpends() { heroSpendsOpen = !heroSpendsOpen; render(); }
function heroSpendsHtml(mk) {
  const t = monthCategoryTotals(mk);
  const cats = [['maids','Maids'],['aavia','Aavia'],['fixed','Fixed'],['household','Household'],['neha','Neha'],['avishek','Avishek']];
  const catRows = cats.filter(([k]) => t[k] > 0.5).map(([k,lbl]) =>
    `<div class="hspend-row"><span>${lbl}</span><span class="mono">₹${inr(t[k])}</span></div>`).join('')
    || `<div class="hspend-row"><span>Nothing tracked yet</span><span></span></div>`;

  const paid = collectPaidItems(mk);
  const byM = {};
  paid.forEach(it => { if (it.method) byM[it.method] = (byM[it.method]||0) + it.amount; });
  const paidSum = paid.reduce((s,it) => s+it.amount, 0);
  const unpaid  = Math.max(0, t.total - paidSum);
  const srcRows = PAY_METHODS.filter(m => byM[m.key]).map(m =>
    `<div class="hspend-row"><span>${pmDot(m.key)}${m.label}</span><span class="mono">₹${inr(byM[m.key])}</span></div>`).join('');
  const unpaidRow = unpaid > 0.5
    ? `<div class="hspend-row due"><span>Unpaid</span><span class="mono">₹${inr(unpaid)}</span></div>` : '';

  return `<div class="hero-spends-inner">
    <div class="hspend-h">Monthly Spends</div>
    ${catRows}
    <div class="hspend-h">Source of Spends</div>
    ${srcRows || unpaidRow ? srcRows+unpaidRow : `<div class="hspend-row"><span>Nothing paid yet</span><span></span></div>`}
  </div>`;
}

// ── Hamburger drawer ───────────────────────────────────────────────────────
const MENU_TRANSITION_MS = 280; // keep in sync with #menu-panel/.menu-overlay transition duration
function openMenu()  { openMenuTo('home'); }
// Opens the hamburger drawer directly to a specific view (used by openMenu()
// itself, and by Home dashboard tiles drilling into CC/Neha/Budgets).
function openMenuTo(view) {
  menuView = view;
  renderMenu();
  const overlay = document.getElementById('menu-overlay');
  overlay.classList.remove('hidden');
  overlay.offsetHeight; // force layout so the slide-in transition actually runs
  overlay.classList.add('open');
  menuBackHandler = attachOverlayBackHandler('menu-overlay', closeMenu);
}
function closeMenu() {
  const overlay = document.getElementById('menu-overlay');
  overlay.classList.remove('open');
  setTimeout(() => overlay.classList.add('hidden'), MENU_TRANSITION_MS);
  if (menuBackHandler) {
    document.removeEventListener('keydown', menuBackHandler);
    menuBackHandler = null;
  }
}
function setMenuView(v) { menuView = v; renderMenu(); }

// ── FAB: tap for Quick Add, hold for shortcuts, drag to reposition ─────────
// Tap/hold/drag are disambiguated by movement: a plain press starts the
// existing 550ms hold-for-shortcuts timer; if the pointer moves past
// FAB_DRAG_THRESHOLD before that (or before release), it's a drag instead —
// the hold timer is cancelled and neither the shortcuts menu nor Quick Add
// opens. Only a press that stays still the whole time reaches fabClick().
const FAB_DRAG_THRESHOLD = 10;
let fabPressTimer = null;
let fabSuppressClick = false;
let fabDragging = false;
let fabDragStartX = null, fabDragStartY = null, fabDragOffX = 0, fabDragOffY = 0;
function fabPointerDown(e) {
  fabSuppressClick = false;
  fabDragging = false;
  fabDragStartX = e.clientX;
  fabDragStartY = e.clientY;
  const rect = e.currentTarget.getBoundingClientRect();
  fabDragOffX = e.clientX - rect.left;
  fabDragOffY = e.clientY - rect.top;
  fabPressTimer = setTimeout(() => { fabSuppressClick = true; doHaptic(); openFabShortcuts(); }, 550);
}
function fabPointerMove(e) {
  if (fabDragStartX === null) return;
  const fab = e.currentTarget;
  const dx = e.clientX - fabDragStartX, dy = e.clientY - fabDragStartY;
  if (!fabDragging && Math.hypot(dx, dy) > FAB_DRAG_THRESHOLD) {
    fabDragging = true;
    fabSuppressClick = true;
    clearTimeout(fabPressTimer);
    fab.classList.add('fab-dragging');
    try { fab.setPointerCapture(e.pointerId); } catch (err) {}
  }
  if (!fabDragging) return;
  const w = fab.offsetWidth || 56, h = fab.offsetHeight || 56;
  let left = e.clientX - fabDragOffX;
  let top = e.clientY - fabDragOffY;
  left = Math.max(4, Math.min(window.innerWidth - w - 4, left));
  const range = fabVerticalRange(h);
  top = Math.max(range.min, Math.min(range.max, top));
  fab.style.left = left + 'px';
  fab.style.right = '';
  fab.style.top = top + 'px';
  fab.style.bottom = '';
}
function fabPointerUp(e) {
  clearTimeout(fabPressTimer);
  const fab = e.currentTarget;
  if (fabDragging) {
    fabDragging = false;
    fab.classList.remove('fab-dragging');
    try { fab.releasePointerCapture(e.pointerId); } catch (err) {}
    const rect = fab.getBoundingClientRect();
    const h = fab.offsetHeight || 56;
    const side = (rect.left + rect.width / 2) < (window.innerWidth / 2) ? 'left' : 'right';
    uiPrefs.fabPos = { side, topFrac: fabPxToTopFrac(rect.top, h) };
    saveUI();
    applyFabPosition(); // animates the snap into place (CSS transition on #fab)
  }
  fabDragStartX = null;
}
function fabClick() {
  if (fabSuppressClick) { fabSuppressClick = false; return; } // handled by hold or drag above
  openQuickAdd();
}
function bindFabLongPress() {
  const fab = document.getElementById('fab');
  if (!fab || fab.dataset.lpBound) return;
  fab.dataset.lpBound = '1';
  fab.addEventListener('pointerdown', fabPointerDown);
  fab.addEventListener('pointermove', fabPointerMove);
  fab.addEventListener('pointerup', fabPointerUp);
  fab.addEventListener('pointerleave', fabPointerUp);
  fab.addEventListener('pointercancel', fabPointerUp);
}
// Ranks past grocery/misc entries by how often the same vendor+category (or misc
// text) was logged before, so the 3 most-repeated ones can be one-tap shortcuts.
let fabShortcuts = [];
function topQuickAddShortcuts() {
  const counts = {};
  Object.values(appState.months||{}).forEach(md => {
    ['householdGroceries','householdMisc','nehaMisc','avishekMisc','aaviaMisc'].forEach(cat => {
      (md[cat]||[]).forEach(it => {
        const text = (it.text||'').trim();
        if (!text) return;
        const key = cat + '|' + text.toLowerCase() + '|' + text; // last segment preserves original casing
        counts[key] = (counts[key]||0) + 1;
      });
    });
  });
  return Object.entries(counts)
    .sort((a,b) => b[1]-a[1])
    .slice(0,3)
    .map(([key,count]) => {
      const [bucket, , b] = key.split('|');
      return { bucket, text:b, label:b, count };
    });
}
function openFabShortcuts() {
  fabShortcuts = topQuickAddShortcuts();
  const list = document.getElementById('qa-shortcuts-list');
  list.innerHTML = fabShortcuts.length
    ? fabShortcuts.map((s,i) => `<button class="add-btn" style="width:100%;margin-bottom:8px;text-align:left" onclick="applyFabShortcut(${i})">${esc(s.label)}</button>`).join('')
    : `<div class="cc-empty">No repeated items yet — add a few with + and shortcuts will show up here.</div>`;
  document.getElementById('qa-shortcuts-overlay').classList.remove('hidden');
  attachOverlayBackHandler('qa-shortcuts-overlay', closeFabShortcuts);
}
function closeFabShortcuts() { document.getElementById('qa-shortcuts-overlay').classList.add('hidden'); }
function applyFabShortcut(i) {
  const s = fabShortcuts[i];
  closeFabShortcuts();
  if (!s) return;
  openQuickAdd();
  document.getElementById('qa-bucket').value = s.bucket;
  document.getElementById('qa-text').value = s.text;
}

// ── Quick-add (floating +) ─────────────────────────────────────────────────
function openQuickAdd() {
  document.getElementById('qa-text').value = '';
  document.getElementById('qa-amt').value = '';
  document.getElementById('qa-date').value = today();
  document.getElementById('qa-paid').checked = false;
  const overlay = document.getElementById('qa-overlay');
  overlay.classList.remove('hidden');
  attachOverlayBackHandler('qa-overlay', closeQuickAdd);
}
function closeQuickAdd() { document.getElementById('qa-overlay').classList.add('hidden'); }
function submitQuickAdd() {
  const bucket = document.getElementById('qa-bucket').value;
  const amt  = Number(document.getElementById('qa-amt').value);
  const date = document.getElementById('qa-date').value || today();
  if (!(amt > 0)) return;
  const mk = clampMonth(monthKeyOf(date));
  const tmd = getMDFor(mk);
  const text = (document.getElementById('qa-text').value || '').trim();
  if (!text) return;
  const entry = { text, amount: Math.round(amt), date, paid:false };
  if (document.getElementById('qa-paid').checked) {
    startPayment('quickAdd', mk, bucket, entry);
    return;
  }
  updateMonthFor(mk, { [bucket]: [...(tmd[bucket]||[]), entry] },
    `added ₹${entry.amount} ${bucket} (${entry.text})`);
  closeQuickAdd();
}

// ── Search (all transactions, all months) ──────────────────────────────────
const SEARCH_CATS = { householdGroceries:'HH Groceries', householdMisc:'HH Misc', aaviaMisc:'Aavia', nehaMisc:'Neha', avishekMisc:'Avishek', fixed:'Fixed' };
// Synthetic search entries for "fixed" ledger items (rent, maids, sukanya, etc.) —
// these aren't stored as discrete array items like groceries/misc, so this mirrors
// getOutstandingItems()'s per-item amount math but includes paid items too (search
// should surface a fixed item regardless of paid status, not just when it's due).
function fixedSearchEntries(mk) {
  if (!appState.months[mk]) return [];
  const md = getMDFor(mk);
  const dim = daysInMonth(mk);
  const out = [];
  const chk = (key, amount) => {
    if (isDiscontinued(key, mk)) return;
    if (amount > 0) out.push({ mk, cat:'fixed', i:-1, text: fixedLabel(key), amount, paid: !!md.paid[key], payMethod: (md.payMethod||{})[key] || null });
  };
  MAIDS.forEach(m => chk(m.key, maidPayout(effectiveBase(mk, m.key, m.base), md.maidLeaves[m.key] ?? 2, dim)));
  if (mk>='2026-08' && mk<='2026-10') chk('japaMaid', (28000/dim) * (md.japaDaysPresent ?? defaultJapaDays(mk)));
  chk('schoolFees', schoolTuition(mk) + schoolTermFee(mk) + schoolBusFee(mk));
  chk('bizone', bizoneFee(mk));
  chk('english', englishFee(mk));
  if (md.swimmingAttended)     chk('swimming',     effectiveBase(mk,'swimming',4000));
  if (md.bharatnatyamAttended) chk('bharatnatyam', effectiveBase(mk,'bharatnatyam',1500));
  chk('chess',   (md.chessDates||[]).length   * effectiveBase(mk,'chessRate',500));
  chk('skating', (md.skatingDates||[]).length * effectiveBase(mk,'skatingRate',375));
  chk('sukanya', sukanyaFee(mk));
  chk('carEmi',  carEmiFee(mk));
  chk('rent',    effectiveBase(mk,'rent', rentFee(mk)));
  ['maids','aavia','fixed','household','neha','avishek'].forEach(section => {
    activeCustomItems(mk, section).forEach(it => chk(it.key, customItemAmount(mk, it.key, it)));
  });
  return out;
}
let searchFilters = { paid:'', cat:'', via:'' };
function openSearch() {
  const overlay = document.getElementById('search-overlay');
  overlay.classList.remove('hidden');
  const inp = document.getElementById('search-inp');
  inp.value = '';
  searchFilters = { paid:'', cat:'', via:'' };
  document.getElementById('sf-cat').value = '';
  document.getElementById('sf-via').value = '';
  renderSearch();
  setTimeout(() => inp.focus(), 50);
  attachOverlayBackHandler('search-overlay', closeSearch);
}
function closeSearch() { document.getElementById('search-overlay').classList.add('hidden'); }
function toggleSearchFilter(kind, val) {
  searchFilters[kind] = searchFilters[kind] === val ? '' : val;
  renderSearch();
}
function setSearchFilter(kind, val) {
  searchFilters[kind] = val;
  renderSearch();
}
function searchIndex() {
  return Object.keys(appState.months||{}).flatMap(mk => {
    const md = getMDFor(mk);
    const arrayHits = Object.keys(SEARCH_CATS).flatMap(cat =>
      (md[cat]||[]).map((it,i) => ({ mk, cat, i, ...it })));
    return [...arrayHits, ...fixedSearchEntries(mk)];
  });
}
function renderSearch() {
  const q = (document.getElementById('search-inp').value || '').trim().toLowerCase();
  const box = document.getElementById('search-results');
  document.getElementById('sf-unpaid').classList.toggle('active', searchFilters.paid === 'unpaid');
  document.getElementById('sf-paid').classList.toggle('active', searchFilters.paid === 'paid');
  const anyFilter = searchFilters.paid || searchFilters.cat || searchFilters.via;
  if (!q && !anyFilter) { box.innerHTML = `<div class="sr-empty">Type to search, or use a filter above.</div>`; return; }
  const hits = searchIndex().filter(it => {
    if (q) {
      const hay = ((it.text||'') + ' ' + (it.vendor||'') + ' ' + (it.category||'') + ' ' + SEARCH_CATS[it.cat] + (it.cat==='fixed' ? '' : ' ' + (it.amount||''))).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (searchFilters.paid === 'unpaid' && it.paid) return false;
    if (searchFilters.paid === 'paid' && !it.paid) return false;
    if (searchFilters.cat && it.cat !== searchFilters.cat) return false;
    if (searchFilters.via && it.payMethod !== searchFilters.via) return false;
    return true;
  }).sort((a,b) => { // newest date first (fixed entries have no exact date — treat as start-of-month)
    const ka = a.date || (a.mk + '-01'), kb = b.date || (b.mk + '-01');
    return kb.localeCompare(ka);
  });
  if (!hits.length) { box.innerHTML = `<div class="sr-empty">No matches${q?` for “${esc(q)}”`:''}.</div>`; return; }
  box.innerHTML = hits.slice(0, 100).map(it => {
    const name = esc(it.text||'');
    return `<div class="sr-item" onclick="jumpToSearch('${it.mk}')">
      <div><div class="sr-name">${name}</div><div class="sr-sub">${SEARCH_CATS[it.cat]} · ${monthShort(it.mk)}${it.date?' · '+fmtDate(it.date):''}</div></div>
      <span class="sr-amt ${it.paid?'paid':'due'}">₹${inr(it.amount)}</span>
    </div>`;
  }).join('');
}
function jumpToSearch(mk) {
  currentMonth = mk;
  closeSearch();
  switchTab('ledger');
}

// ── Swipe actions on Ledger rows (delegated on #app-body) ──────────────────
let swipe = null;
function swipeStart(e) {
  const row = e.target.closest('.mitem, .lrow');
  if (!row || (!row.dataset.cat && !row.dataset.key) || currentTab !== 'ledger') { swipe = null; return; }
  // Don't hijack taps that start on an interactive control inside the row.
  if (e.target.closest('button, input, select, .date-chip')) { swipe = null; return; }
  const t = e.touches[0];
  swipe = { row, x0:t.clientX, y0:t.clientY, dx:0, lock:null };
}
function swipeMove(e) {
  if (!swipe) return;
  const t = e.touches[0];
  const dx = t.clientX - swipe.x0, dy = t.clientY - swipe.y0;
  if (swipe.lock === null) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    swipe.lock = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
  }
  if (swipe.lock !== 'h') { swipe = null; return; } // vertical → let the page scroll
  e.preventDefault();
  swipe.dx = dx;
  swipe.row.style.transition = 'none';
  swipe.row.style.transform = `translateX(${dx}px)`;
  swipe.row.style.background = dx < -70 ? 'rgba(184,67,60,.14)' : dx > 70 ? 'rgba(47,122,92,.14)' : '';
}
function swipeEnd() {
  if (!swipe) return;
  const { row, dx, lock } = swipe;
  swipe = null;
  row.style.transition = 'transform .18s ease';
  row.style.transform = '';
  row.style.background = '';
  if (lock !== 'h') return;
  const TH = 90;
  if (row.classList.contains('lrow')) {
    // Fixed/maids/Aavia-class rows have no delete — right = pay/change method, left = unmark paid.
    const key = row.dataset.key, amount = Number(row.dataset.amount), paid = row.dataset.paid === 'true';
    if (dx > TH)       { doHaptic(); startPayment('fixed', key, amount); }
    else if (dx < -TH && paid) { doHaptic(); togglePaid(key); }
    return;
  }
  const cat = row.dataset.cat, idx = Number(row.dataset.idx);
  if (dx < -TH)      { doHaptic(); deleteMiscItem(cat, idx); }
  else if (dx > TH)  { doHaptic(); startPayment('misc', cat, idx); }
}
function doHaptic(type='impact') {
  const Haptics = getNativePlugin('Haptics');
  if (!Haptics) return;
  try { if (type==='impact') Haptics.impact({style:1}); } catch(e){}
}
function bindSwipe() {
  const body = document.getElementById('app-body');
  if (!body || body.dataset.swipeBound) return;
  body.dataset.swipeBound = '1';
  body.addEventListener('touchstart', swipeStart, { passive:true });
  body.addEventListener('touchmove',  swipeMove,  { passive:false });
  body.addEventListener('touchend',   swipeEnd,   { passive:true });
  body.addEventListener('touchcancel', swipeEnd,  { passive:true });
}

// ── Swipe to change month (delegated on #app-body, Ledger tab only) ────────
// Only activates when the touch doesn't start on a row/control — those already
// own horizontal swipes (delete/mark-paid above) or their own taps.
let monthSwipe = null;
function monthSwipeStart(e) {
  if (currentTab !== 'ledger') { monthSwipe = null; return; }
  // Exclude rows (their own swipe above) and specific action controls, but NOT
  // .card-hd — it's a <button> too, yet is most of the screen's open surface,
  // and a tap (near-zero movement) still reaches its onclick normally either way.
  if (e.target.closest('.mitem, .lrow, .pbtn, .base-edit-btn, .del-btn, .sbtn, .chip, input, select, .date-chip')) { monthSwipe = null; return; }
  const t = e.touches[0];
  monthSwipe = { x0:t.clientX, y0:t.clientY, dx:0, lock:null };
}
function monthSwipeMove(e) {
  if (!monthSwipe) return;
  const t = e.touches[0];
  const dx = t.clientX - monthSwipe.x0, dy = t.clientY - monthSwipe.y0;
  if (monthSwipe.lock === null) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    monthSwipe.lock = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
  }
  if (monthSwipe.lock !== 'h') { monthSwipe = null; return; } // vertical → let the page scroll
  e.preventDefault();
  monthSwipe.dx = dx;
}
function monthSwipeEnd() {
  if (!monthSwipe) return;
  const { dx, lock } = monthSwipe;
  monthSwipe = null;
  if (lock !== 'h') return;
  const TH = 90;
  if (dx < -TH)      { doHaptic(); shiftMonth(1); }
  else if (dx > TH)  { doHaptic(); shiftMonth(-1); }
}
function bindMonthSwipe() {
  const body = document.getElementById('app-body');
  if (!body || body.dataset.monthSwipeBound) return;
  body.dataset.monthSwipeBound = '1';
  body.addEventListener('touchstart', monthSwipeStart, { passive:true });
  body.addEventListener('touchmove',  monthSwipeMove,  { passive:false });
  body.addEventListener('touchend',   monthSwipeEnd,   { passive:true });
  body.addEventListener('touchcancel', () => { monthSwipe = null; }, { passive:true });
}
// ── Swipe to change day (delegated on #summary, Daily Expenses home tile only) ──
let dailySwipe = null;
function dailySwipeStart(e) {
  if (currentTab !== 'home' || currentHomeTile !== 'daily') { dailySwipe = null; return; }
  if (e.target.closest('.mitem, .nav-btn')) { dailySwipe = null; return; }
  const t = e.touches[0];
  dailySwipe = { x0:t.clientX, y0:t.clientY, dx:0, lock:null };
}
function dailySwipeMove(e) {
  if (!dailySwipe) return;
  const t = e.touches[0];
  const dx = t.clientX - dailySwipe.x0, dy = t.clientY - dailySwipe.y0;
  if (dailySwipe.lock === null) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    dailySwipe.lock = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
  }
  if (dailySwipe.lock !== 'h') { dailySwipe = null; return; }
  e.preventDefault();
  dailySwipe.dx = dx;
}
function dailySwipeEnd() {
  if (!dailySwipe) return;
  const { dx, lock } = dailySwipe;
  dailySwipe = null;
  if (lock !== 'h') return;
  const TH = 90;
  if (dx < -TH)      { doHaptic(); shiftDailyDate(1); }
  else if (dx > TH)  { doHaptic(); shiftDailyDate(-1); }
}
function bindDailySwipe() {
  const el = document.getElementById('summary');
  if (!el || el.dataset.dailySwipeBound) return;
  el.dataset.dailySwipeBound = '1';
  el.addEventListener('touchstart', dailySwipeStart, { passive:true });
  el.addEventListener('touchmove',  dailySwipeMove,  { passive:false });
  el.addEventListener('touchend',   dailySwipeEnd,   { passive:true });
  el.addEventListener('touchcancel', () => { dailySwipe = null; }, { passive:true });
}
function signOut() { try { localStorage.removeItem(AUTH_KEY); } catch(e){} auth = null; closeMenu(); location.reload(); }
function renderMenu() {
  const el = document.getElementById('menu-content');
  const titleEl = document.getElementById('menu-title');
  if (!el) return;
  if (menuView === 'cc') {
    if (titleEl) titleEl.textContent = 'Credit Card Payments';
    el.innerHTML = `<button class="menu-home-btn" onclick="setMenuView('home')">← Home</button>` + ccSectionHtml();
    return;
  }
  if (menuView === 'neha') {
    if (titleEl) titleEl.textContent = 'Neha Bank Balance';
    el.innerHTML = `<button class="menu-home-btn" onclick="setMenuView('home')">← Home</button>` + nehaBankSectionHtml();
    return;
  }
  if (menuView === 'budgets') {
    if (titleEl) titleEl.textContent = 'Budgets';
    el.innerHTML = `<button class="menu-home-btn" onclick="setMenuView('home')">← Home</button>` + budgetsSectionHtml();
    return;
  }
  if (menuView === 'trends') {
    if (titleEl) titleEl.textContent = 'Trends';
    el.innerHTML = `<button class="menu-home-btn" onclick="setMenuView('home')">← Home</button>` + trendsSectionHtml();
    return;
  }
  if (menuView === 'trash') {
    if (titleEl) titleEl.textContent = 'Recently Deleted';
    el.innerHTML = `<button class="menu-home-btn" onclick="setMenuView('home')">← Home</button>` + trashSectionHtml();
    return;
  }
  if (menuView === 'activity') {
    if (titleEl) titleEl.textContent = 'Activity';
    el.innerHTML = `<button class="menu-home-btn" onclick="setMenuView('home')">← Home</button>` + activitySectionHtml();
    return;
  }
  if (menuView === 'settings') {
    if (titleEl) titleEl.textContent = 'Settings';
    el.innerHTML = `
      <button class="menu-home-btn" onclick="setMenuView('home')">← Menu</button>
      <a class="menu-link" onclick="cycleNotifications()">Notifications <span>${notificationsLabel()}</span></a>
      <a class="menu-link" onclick="cycleLockEnabled()">Screen Lock <span>${lockLabel()}</span></a>
      <a class="menu-link" onclick="cycleTheme()">Appearance <span>${themeLabel()}</span></a>
      <a class="menu-link" onclick="cycleStyle()">Theme <span>${styleLabel()}</span></a>
      <a class="menu-link" onclick="resetFabPosition()">Quick-add button <span>Reset position</span></a>
    `;
    return;
  }
  if (titleEl) titleEl.textContent = 'Menu';
  el.innerHTML = `
    <a class="menu-link" onclick="openAddFixedItem()">Add Fixed Expense <span>›</span></a>
    <a class="menu-link" onclick="openTrashView()">Recently Deleted <span>›</span></a>
    <a class="menu-link" onclick="openActivityView()">Activity <span>›</span></a>
    <a class="menu-link" onclick="setMenuView('settings')">Settings <span>›</span></a>
    <a class="menu-link danger" onclick="signOut()">Sign out</a>
  `;
}
function trashSectionHtml() {
  const trash = getTrash();
  if (!trash.length) {
    return `<section class="cc-card"><div class="cc-head"><span class="cc-name">Recently Deleted</span></div>
      <div class="cc-empty" style="padding-top:0">Nothing here — deleted items are kept for 7 days.</div></section>`;
  }
  const rows = trash.slice().reverse().map(t => {
    if (t.kind === 'fixedItem') {
      return `<div class="cc-pay"><span>${esc(t.item.label)} · stopped after ${monthLabel(t.item.cutoffMonth)} · deleted ${fmtDMY(new Date(t.deletedAt))}</span><button class="add-btn" style="width:auto;padding:4px 12px;font-size:12px" onclick="restoreFromTrash('${t.id}')">Restore</button></div>`;
    }
    const label = t.item.text || t.item.vendor
      || (t.kind==='nehaTransfer' ? (t.item.direction==='in'?'Avishek → Neha':'Neha → Avishek') : 'CC payment');
    return `<div class="cc-pay"><span>₹${inr(t.item.amount)} · ${esc(label)} · deleted ${fmtDMY(new Date(t.deletedAt))}</span><button class="add-btn" style="width:auto;padding:4px 12px;font-size:12px" onclick="restoreFromTrash('${t.id}')">Restore</button></div>`;
  }).join('');
  return `<section class="cc-card"><div class="cc-head"><span class="cc-name">Recently Deleted</span></div>
    <div class="cc-empty" style="padding-top:0;font-size:13px">Kept for 7 days, then removed automatically.</div>${rows}</section>`;
}
function notificationsLabel() { return (uiPrefs.notificationsEnabled ?? true) ? 'On' : 'Off'; }
function cycleNotifications() {
  uiPrefs.notificationsEnabled = !uiPrefs.notificationsEnabled;
  saveUI();
  if (uiPrefs.notificationsEnabled) scheduleNotifications();
  renderMenu();
}
function lockLabel() { return (uiPrefs.lockEnabled ?? true) ? 'On' : 'Off'; }
function cycleLockEnabled() {
  uiPrefs.lockEnabled = !(uiPrefs.lockEnabled ?? true);
  saveUI();
  renderMenu();
}
// Due-soon/overdue chip + a thin close-date→due-date progress bar. Only shown
// once a statement has actually closed (statusClass 'due'/'over') — a 'cur'
// cycle is still accruing charges, so a countdown to its future due date isn't
// meaningful yet.
function dueCountdownHtml(c) {
  if (c.statusClass !== 'due' && c.statusClass !== 'over') return '';
  const over = c.statusClass === 'over';
  const cls = over ? 'over' : 'soon';
  const label = over ? `Overdue ${Math.abs(c.daysUntilDue)}d` : (c.daysUntilDue <= 0 ? 'Due today' : `Due in ${c.daysUntilDue}d`);
  return `<div class="cc-countdown">
    <span class="cc-countdown-chip ${cls}">${label}</span>
    <div class="cc-countdown-bar"><i class="${cls}" style="width:${c.cyclePct}%"></i></div>
  </div>`;
}
function ccSectionHtml() {
  let html = '';
  Object.keys(CC_CYCLES).forEach(cardKey => {
    const cfg = CC_CYCLES[cardKey];
    const b = ccBuildCycles(cardKey);
    html += `<section class="cc-card">
      <div class="cc-head">
        <span class="cc-name">${cfg.label}</span>
        <span class="cc-out ${b.outstanding>0?'due':'ok'}">₹${inr(Math.max(0,b.outstanding))} <small>owed</small></span>
      </div>`;
    // Hide fully-paid cycles — once a month's bill is settled it drops off the list.
    const visible = b.cycles.filter(c => c.statusClass !== 'ok');
    html += visible.length
      ? visible.map(c => `<div class="cc-cyc" onclick="openCcCycleReview('${cardKey}','${c.key}','${esc(c.label)}',${c.total})">
          <div class="cc-cyc-top">
            <div class="cc-cyc-l"><div class="cc-cyc-win">${c.label}</div><div class="cc-cyc-sub ${c.statusClass}">${c.statusLabel}</div></div>
            <div class="cc-cyc-amt">₹${inr(c.total)}</div>
          </div>
          ${dueCountdownHtml(c)}
        </div>`).join('')
      : (b.cycles.length ? `<div class="cc-empty">All cycles paid up ✓</div>`
                         : `<div class="cc-empty">No spends on this card yet</div>`);
    const cycleLabelByKey = {};
    b.cycles.forEach(c => { cycleLabelByKey[c.key] = c.label; });
    const pays = getCcPayments()[cardKey];
    // Payment log is hidden by default (collapsed) — recorded in the background
    // for the balance math above, only shown if the user taps to expand it.
    if (pays.length) {
      const secId = 'cc-hist-'+cardKey;
      const open = isOpen(secId, 0);
      const rows = pays.map((p,i) => {
        const tag = p.cycleKey && cycleLabelByKey[p.cycleKey] ? ` (${cycleLabelByKey[p.cycleKey]})` : '';
        return `<div class="cc-pay"><span>Paid ₹${inr(p.amount)} · ${fmtDMY(new Date(p.date))}${tag}</span><button class="cc-del" onclick="deleteCcPayment('${cardKey}',${i})" aria-label="delete">✕</button></div>`;
      }).join('');
      html += `<section class="card${open?' open':''}" data-sec="${secId}" aria-expanded="${open?'true':'false'}" style="margin-top:12px">
        <button class="card-hd" onclick="toggleCollapse('${secId}')">
          <span class="chev" aria-hidden="true">›</span>
          <span class="hd-main"><span class="hd-title" style="font-size:14px">Payment history</span><span class="hd-sub">${pays.length} payment${pays.length>1?'s':''}</span></span>
        </button>
        <div class="card-body-wrap"><div class="card-body">${rows}</div></div>
      </section>`;
    }
    html += `</section>`;
  });
  return html;
}
function nehaBankSectionHtml() {
  const nb = getNehaBank();
  const spent = nehaBankSpent();
  const transferNet = nehaBankTransferNet();
  const balance = nb.initialBalance + transferNet - spent;
  let html = `<section class="cc-card">
    <div class="cc-head">
      <span class="cc-name">Neha Bank</span>
      <span class="cc-out ${balance>=0?'ok':'due'}">₹${inr(balance)} <small>balance</small></span>
    </div>
    ${nehaBalanceEditControl(nb.initialBalance)}
    <div class="cc-cyc" style="cursor:default">
      <div class="cc-cyc-l"><div class="cc-cyc-win">Transfers (net)</div></div>
      <div class="cc-cyc-amt">${transferNet>=0?'+':'−'}₹${inr(Math.abs(transferNet))}</div>
    </div>
    <div class="cc-cyc" style="cursor:default">
      <div class="cc-cyc-l"><div class="cc-cyc-win">Spent via Neha Bank</div></div>
      <div class="cc-cyc-amt">−₹${inr(spent)}</div>
    </div>
    <div class="neha-xfer-btns">
      <button class="add-btn" onclick="openNehaXferSheet('in')">Avishek → Neha</button>
      <button class="add-btn" onclick="openNehaXferSheet('out')">Neha → Avishek</button>
    </div>`;
  const transfers = nb.transfers;
  if (transfers.length) {
    const secId = 'neha-hist';
    const open = isOpen(secId, 0);
    const rows = transfers.map((t,i) => {
      const sign = t.direction==='in' ? '+' : '−';
      const dir  = t.direction==='in' ? 'Avishek → Neha' : 'Neha → Avishek';
      return `<div class="cc-pay"><span>${sign}₹${inr(t.amount)} · ${fmtDMY(new Date(t.date))} (${dir})</span><button class="cc-del" onclick="deleteNehaTransfer(${i})" aria-label="delete">✕</button></div>`;
    }).join('');
    html += `<section class="card${open?' open':''}" data-sec="${secId}" aria-expanded="${open?'true':'false'}" style="margin-top:12px">
      <button class="card-hd" onclick="toggleCollapse('${secId}')">
        <span class="chev" aria-hidden="true">›</span>
        <span class="hd-main"><span class="hd-title" style="font-size:14px">Transfer history</span><span class="hd-sub">${transfers.length} transfer${transfers.length>1?'s':''}</span></span>
      </button>
      <div class="card-body-wrap"><div class="card-body">${rows}</div></div>
    </section>`;
  }
  html += `</section>`;
  return html;
}

// ── Budgets menu view ──────────────────────────────────────────────────────
let budgetEditCat = null;
function startBudgetEdit(cat) { budgetEditCat = cat; render(); }
function cancelBudgetEdit()   { budgetEditCat = null; render(); }
function saveBudgetEdit(cat) {
  const inp = document.getElementById('budget-inp-'+cat);
  budgetEditCat = null;
  if (inp) setBudget(cat, inp.value); else render();
}
function budgetsSectionHtml() {
  const budgets = getBudgets();
  const t = monthCategoryTotals(currentMonth);
  let html = `<section class="cc-card">
    <div class="cc-head">
      <span class="cc-name">Monthly caps</span>
      <span class="cc-out"><small>${monthLabel(currentMonth)}</small></span>
    </div>
    <div class="cc-empty" style="padding-top:0">Set a soft cap per category. Spend is this month's total; a cap turns maroon on the Ledger when exceeded. Blank/0 clears it.</div>`;
  BUDGET_CATS.forEach(([cat,label]) => {
    const cap = budgets[cat] || 0;
    const spent = t[cat] || 0;
    const over = cap > 0 && spent > cap;
    const pct = cap > 0 ? Math.min(100, Math.round(spent/cap*100)) : 0;
    html += `<div class="budget-row">
      <div class="budget-top">
        <span class="budget-cat">${label}</span>`;
    if (budgetEditCat === cat) {
      html += `<span class="base-row" style="margin-left:auto">
        <span class="base-lbl">Cap ₹</span>
        <input id="budget-inp-${cat}" class="base-inp" type="number" value="${cap||''}">
        <button class="base-ok" onclick="saveBudgetEdit('${cat}')">Save</button>
        <button class="base-cancel" onclick="cancelBudgetEdit()">✕</button>
      </span>`;
    } else {
      html += `<span class="base-row" style="margin-left:auto">
        <button class="base-edit-btn" onclick="startBudgetEdit('${cat}')" title="Edit cap">✎</button>
        <span class="base-lbl">${cap>0 ? 'Cap ₹'+inr(cap) : 'No cap'}</span>
      </span>`;
    }
    html += `</div>`;
    if (cap > 0) {
      html += `<div class="budget-meta ${over?'over':''}">₹${inr(spent)} spent${over?' · over by ₹'+inr(spent-cap):' of ₹'+inr(cap)}</div>
        <div class="hd-bar"><i style="width:${pct}%;background:${over?'var(--maroon)':'var(--green-soft)'}"></i></div>`;
    }
    html += ``;
  });
  html += `</section>`;
  return html;
}

// ── Trends menu view ───────────────────────────────────────────────────────
const DONUT_COLORS = { maids:'var(--accent)', aavia:'var(--green)', fixed:'var(--muted)', household:'var(--maroon)', neha:'var(--accent-soft)', avishek:'var(--due-amber)' };
function trendsSectionHtml() {
  const months = menuMonths().slice().reverse(); // ascending for a left→right time axis
  if (!months.length) return `<section class="cc-card"><div class="cc-empty">No data yet</div></section>`;
  const totals = months.map(mk => ({ mk, total: monthCategoryTotals(mk).total }));
  const maxTotal = totals.reduce((mx,x) => Math.max(mx, x.total), 0) || 1;

  // vs last month delta (current vs previous month that has data)
  const idxCur = months.indexOf(currentMonth);
  let deltaHtml = '';
  if (idxCur > 0) {
    const curT = monthCategoryTotals(currentMonth).total;
    const prevMk = months[idxCur-1];
    const prevT = monthCategoryTotals(prevMk).total;
    const d = curT - prevT;
    const up = d >= 0;
    deltaHtml = `<div class="trend-delta ${up?'up':'down'}">${up?'▲':'▼'} ₹${inr(Math.abs(d))} vs ${monthShort(prevMk)}</div>`;
  }

  // Month-over-month total bars
  let bars = totals.map(({mk,total}) => {
    const w = Math.round(total/maxTotal*100);
    const cur = mk === currentMonth;
    return `<div class="trend-bar-row">
      <span class="trend-bar-lbl${cur?' cur':''}">${monthShort(mk)}</span>
      <div class="trend-bar"><i style="width:${w}%;background:${cur?'var(--accent)':'var(--accent-soft)'}"></i></div>
      <span class="trend-bar-val">₹${inr(total)}</span>
    </div>`;
  }).join('');

  // Category donut for the current month
  const t = monthCategoryTotals(currentMonth);
  const donut = donutSvg(t);

  return `<section class="cc-card">
    <div class="cc-head"><span class="cc-name">Spend over time</span></div>
    ${deltaHtml}
    <div class="trend-bars">${bars}</div>
  </section>
  <section class="cc-card">
    <div class="cc-head"><span class="cc-name">Categories</span><span class="cc-out"><small>${monthLabel(currentMonth)}</small></span></div>
    ${donut}
  </section>`;
}
// Hand-rolled donut: stacked stroke-dasharray arcs on a single circle. No deps.
function donutSvg(t) {
  const total = t.total || 0;
  if (total <= 0) return `<div class="cc-empty">Nothing spent this month</div>`;
  const R = 54, C = 2 * Math.PI * R;
  let offset = 0;
  const segs = BUDGET_CATS.filter(([k]) => t[k] > 0).map(([k,label]) => {
    const frac = t[k] / total;
    const len = frac * C;
    const seg = `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${DONUT_COLORS[k]}" stroke-width="20"
      stroke-dasharray="${len.toFixed(2)} ${(C-len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 70 70)"></circle>`;
    offset += len;
    return { seg, k, label, frac };
  });
  const arcs = segs.map(s => s.seg).join('');
  const legend = segs.map(s =>
    `<div class="donut-leg"><span class="donut-dot" style="background:${DONUT_COLORS[s.k]}"></span><span class="donut-leg-lbl">${s.label}</span><span class="donut-leg-val">₹${inr(t[s.k])} · ${Math.round(s.frac*100)}%</span></div>`).join('');
  return `<div class="donut-wrap">
    <svg viewBox="0 0 140 140" width="140" height="140" class="donut-svg">${arcs}
      <text x="70" y="66" text-anchor="middle" class="donut-center-top">Total</text>
      <text x="70" y="86" text-anchor="middle" class="donut-center-val">₹${inr(total)}</text>
    </svg>
    <div class="donut-legend">${legend}</div>
  </div>`;
}
function menuMonths() {
  return Object.keys(appState.months||{}).filter(mk => mk >= MIN_MONTH).sort().reverse();
}
function monthlySpendsHtml() {
  const months = menuMonths();
  if (!months.length) return `<div class="cc-empty">No data yet</div>`;
  const cats = [['maids','Maids'],['aavia','Aavia'],['fixed','Fixed'],['household','Household'],['neha','Neha'],['avishek','Avishek']];
  return months.map(mk => {
    const t = monthCategoryTotals(mk);
    return `<section class="ms-month">
      <div class="ms-head"><span>${monthLabel(mk)}</span><span class="ms-total">₹${inr(t.total)}</span></div>
      <div class="ms-rows">` +
      cats.map(([k,lbl]) => `<div class="ms-row"><span>${lbl}</span><span>₹${inr(t[k])}</span></div>`).join('') +
      `</div></section>`;
  }).join('');
}
// Per-month spend grouped by payment source, with an Unpaid line so each month reconciles.
function sourceSpendsHtml() {
  const months = menuMonths();
  if (!months.length) return `<div class="cc-empty">No data yet</div>`;
  return months.map(mk => {
    const paid = collectPaidItems(mk);
    const byM = {};
    paid.forEach(it => { if (it.method) byM[it.method] = (byM[it.method]||0) + it.amount; });
    const paidSum = paid.reduce((s,it) => s+it.amount, 0);
    const unpaid  = Math.max(0, monthCategoryTotals(mk).total - paidSum);
    const rows = PAY_METHODS.filter(m => byM[m.key]).map(m =>
      `<div class="ms-row"><span>${pmDot(m.key)}${m.label}</span><span>₹${inr(byM[m.key])}</span></div>`).join('');
    const unpaidRow = unpaid > 0.5
      ? `<div class="ms-row"><span style="color:var(--maroon)">Unpaid</span><span style="color:var(--maroon)">₹${inr(unpaid)}</span></div>` : '';
    return `<section class="ms-month">
      <div class="ms-head"><span>${monthLabel(mk)}</span><span class="ms-total g">₹${inr(paidSum)}</span></div>
      <div class="ms-rows">${rows || '<div class="cc-empty">No paid spends</div>'}${unpaidRow}</div>
    </section>`;
  }).join('');
}

// ── Collapse handling ──────────────────────────────────────────────────────
function isOpen(id, pending) {
  const c = uiPrefs.collapsed[id];
  if (c === undefined) return pending > 0.5;
  return !c;
}
function toggleCollapse(id) {
  const card = document.querySelector('.card[data-sec="'+id+'"]');
  if (!card) return;
  const open = card.classList.toggle('open');
  card.setAttribute('aria-expanded', open ? 'true' : 'false');
  uiPrefs.collapsed[id] = !open;
  saveUI();
}
function setAllCollapsed(v) {
  document.querySelectorAll('.card[data-sec]').forEach(c => { uiPrefs.collapsed[c.dataset.sec] = v; });
  saveUI();
  render();
}

