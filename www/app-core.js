// ── PWA Manifest ─────────────────────────────────────────────────────────────
(function(){
  const icon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'%3E%3Crect width='512' height='512' rx='80' fill='%23171b21'/%3E%3Crect x='130' y='110' width='252' height='292' rx='12' fill='%23eef1f4'/%3E%3Crect x='158' y='170' width='196' height='18' rx='4' fill='%23171b21'/%3E%3Crect x='158' y='210' width='196' height='18' rx='4' fill='%23171b21'/%3E%3Crect x='158' y='250' width='140' height='18' rx='4' fill='%23171b21'/%3E%3Crect x='158' y='310' width='80' height='28' rx='4' fill='%23b8433c'/%3E%3Crect x='258' y='310' width='96' height='28' rx='4' fill='%233452c0'/%3E%3C/svg%3E";
  const m = {
    name: 'Household Ledger', short_name: 'Ledger',
    description: 'Avishek Family Household Ledger',
    start_url: location.href.split('?')[0],
    display: 'standalone', orientation: 'portrait',
    background_color: '#eef1f4', theme_color: '#171b21',
    icons: [{ src: icon, sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' }]
  };
  const blob = new Blob([JSON.stringify(m)], { type: 'application/manifest+json' });
  const el = document.getElementById('pwa-manifest');
  if (el) el.href = URL.createObjectURL(blob);
  const vp = document.querySelector('meta[name="viewport"]');
  if (vp) vp.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=5.0, viewport-fit=cover');
  // no zoom hack needed — Android Chrome handles viewport correctly
})();

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const MAIDS = [
  { key:'nirmala', label:'Nirmala', base:10000 },
  { key:'varsha',  label:'Varsha',  base:7500  },
  { key:'meenal',  label:'Meenal',  base:4000  },
  { key:'sujata',  label:'Sujata',  base:2800  },
];
const SUKANYA = 12500;
function sukanyaFee(mk) { return effectiveBase(mk, 'sukanya', SUKANYA); }
const STORAGE_KEY = 'household-ledger-v1';
const UI_KEY = 'household-ledger-ui-v1';
const PENDING_SYNC_KEY = 'household-ledger-pending-sync-v1';
const LAST_VERSION_CHECK_KEY = 'household-ledger-last-version-check-v1';
const VERSION_CHECK_THROTTLE_MS = 4*60*60*1000; // don't re-check version.json more than once per 4h
const MIN_MONTH = '2026-03';

const PAY_METHODS = [
  { key:'axisCC',      label:'Axis CC',      short:'Axis'    },
  { key:'scapiaCC',    label:'Scapia CC',    short:'Scapia'  },
  { key:'avishekBank', label:'Avishek Bank', short:'Avishek' },
  { key:'nehaCash',    label:'Neha Cash',    short:'N·Cash'  },
  { key:'nehaBank',    label:'Neha Bank',    short:'N·Bank'  },
];
// Items with exactly one valid payment method — skip picker, auto-confirm
const FIXED_METHOD = { rent:'avishekBank', sukanya:'nehaBank', carEmi:'avishekBank' };
// Items that cannot use credit cards — picker shows only bank/cash options
const NO_CC_KEYS = new Set(['nirmala','varsha','meenal','sujata','japaMaid','chess','skating','swimming','bharatnatyam']);
// Display labels for every "fixed"-type ledger item (maids + aavia + fixed sections),
// used to build real activity-log detail at payment time (no amount source exists there
// other than what's passed through the "Mark paid" click, so labels alone are looked up here).
const FIXED_LABELS = {
  ...Object.fromEntries(MAIDS.map(m => [m.key, m.label])),
  japaMaid:'Japa Maid', swimming:'Swimming', bharatnatyam:'Bharatnatyam', chess:'Chess', skating:'Skating',
  sukanya:'Sukanya Samriddhi', carEmi:'Car EMI', rent:'Rent',
  schoolFees:'P G Garodia School', bizone:'Bizone (snacks)', english:'English (Sheetal)',
};

// Credit-card billing cycles. cycle runs [startDay .. endDay(next month)];
// the statement closes on endDay and the bill is due on dueDay of the month after.
const CC_CYCLES = {
  axisCC:   { label:'Axis CC',   short:'Axis',   startDay:19, endDay:18, dueDay:7  },
  scapiaCC: { label:'Scapia CC', short:'Scapia', startDay:25, endDay:24, dueDay:13 },
};

// ── App config ─────────────────────────────────────────────────────────────
const APP_VERSION = '2.10.11';
// Google Apps Script JSON API over the shared household Google Sheet.
// Set after deploying Code.gs as a web app (the /exec URL). Empty = sync off.
const GAS_URL = '__GAS_URL__';
// OAuth "Web application" client ID — used for Google Sign-In
const GOOGLE_WEB_CLIENT_ID = '__WEB_CLIENT_ID__';
// Raw GitHub URL of version.json for self-update checks. Empty = updates off.
const UPDATE_URL = '__UPDATE_URL__';

const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
// Sync requires a configured GAS URL AND the native shell (Google Sign-In
// lives in the native plugin) — in a plain browser the app runs local-only.
const IN_GAS = GAS_URL.startsWith('https://') && IS_NATIVE;

// ── State ──────────────────────────────────────────────────────────────────
let appState = { months: {} };
let currentMonth = todayMonthKey();
let currentTab = 'home';
let syncTimer = null;
let uiPrefs = { collapsed: {} };
let gDraft = { vendor:'Sagar', category:'veges', amount:'', date:'' };
let miscDrafts = {};
let pendingPay = null;
let pendingCcPay = null; // { cardKey, cycleKey } while the CC pay sheet is open
let pendingNehaXfer = null; // { direction } while the Neha transfer sheet is open
let menuView = 'home'; // hamburger drawer: 'home' | 'cc' | 'neha'
let menuBackHandler = null;
let nehaEditingBalance = false;
let heroSpendsOpen = false;
let selectedOutKeys = new Set(); // composite keys `${mk}|${toggleType}|${toggleKey}|${toggleIdx}` selected on Outstanding
let undoStack = []; // { prevAppState, label }, capped at 4 — in-memory only, resets on reload
let suppressUndo = false; // set true while a batch of mutator calls should count as one undo step

function pushUndo(label) {
  if (suppressUndo) return;
  undoStack.push({ prevAppState: appState, label });
  if (undoStack.length > 4) undoStack.shift();
  updateUndoBtn();
}
function undoLastAction() {
  if (!undoStack.length) return;
  const { prevAppState } = undoStack.pop();
  appState = prevAppState;
  saveLocal(); render(); renderMenu(); if (IN_GAS) scheduleSync();
  updateUndoBtn();
}
function updateUndoBtn() {
  const btn = document.getElementById('undo-btn');
  if (!btn) return;
  btn.classList.toggle('hidden', undoStack.length === 0);
  const c = document.getElementById('undo-count');
  if (c) c.textContent = undoStack.length || '';
}

function todayMonthKey() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`;
}

function emptyMonth() {
  return {
    maidLeaves:{ nirmala:2, varsha:2, meenal:2, sujata:2 },
    japaDaysPresent:null,
    swimmingAttended:false,
    bharatnatyamAttended:false,
    chessDates:[],
    skatingDates:[],
    groceries:[],
    householdGroceries:[],
    householdMisc:[],
    aaviaMisc:[],
    nehaMisc:[],
    avishekMisc:[],
    paid:{},
    payMethod:{},
    payDate:{},
    bases:{},
    customAttended:{},
    customClassDates:{}
  };
}
// Soft-delete trash (top-level, cross-month). Rides in the synced blob;
// entries self-prune after 7 days so it never grows unbounded.
function getTrash() { return appState.trash || []; }
function moveToTrash(entry) {
  const id = Date.now() + '-' + Math.random().toString(36).slice(2);
  appState = { ...appState, trash: [...getTrash(), { id, deletedAt: today(), ...entry }] };
}
function pruneTrash() {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
  const kept = getTrash().filter(t => new Date(t.deletedAt) >= cutoff);
  if (kept.length !== getTrash().length) appState = { ...appState, trash: kept };
}
function openTrashView() { pruneTrash(); setMenuView('trash'); }

// ── Activity log view — reads the separate ActivityLog sheet, not appState ──
const ACTIVITY_LIMIT = 10;
let activityEntries = [];
let activityLoading = false;
function openActivityView() {
  setMenuView('activity');
  loadActivityLog();
}
async function loadActivityLog() {
  if (!IN_GAS || !auth || !auth.idToken) { activityEntries = []; renderMenu(); return; }
  activityLoading = true; renderMenu();
  let entries = [];
  try {
    // The log endpoint filters by date, not count — 90 days back is plenty
    // to cover the last ACTIVITY_LIMIT changes for a regularly-used ledger.
    const since = new Date(Date.now() - 90*24*60*60*1000).toISOString();
    const url = GAS_URL + '?id_token=' + encodeURIComponent(auth.idToken) + '&op=getLog&since=' + encodeURIComponent(since);
    const res = await fetch(url);
    const j = await res.json();
    entries = (j && j.ok && j.entries) || [];
  } catch (e) {
    entries = [];
  }
  activityEntries = entries.slice(0, ACTIVITY_LIMIT);
  activityLoading = false;
  renderMenu();
}
const ACTIVITY_NAMES = { 'avishek87@gmail.com': 'Avishek', 'nagrawal0988@gmail.com': 'Neha' };
function activitySectionHtml() {
  if (activityLoading) {
    return `<section class="cc-card"><div class="cc-head"><span class="cc-name">Activity</span></div><div class="cc-empty" style="padding-top:0">Loading…</div></section>`;
  }
  if (!activityEntries.length) {
    return `<section class="cc-card"><div class="cc-head"><span class="cc-name">Activity</span></div>
      <div class="cc-empty" style="padding-top:0">Nothing here yet — changes you and Neha make will show up here.</div></section>`;
  }
  const rows = activityEntries.map(e =>
    `<div class="cc-pay"><span>${esc(ACTIVITY_NAMES[e.email] || e.email)} · ${esc(e.entry)} · ${fmtDMY(new Date(e.ts))}</span></div>`
  ).join('');
  return `<section class="cc-card"><div class="cc-head"><span class="cc-name">Activity</span></div>
    <div class="cc-empty" style="padding-top:0;font-size:13px">Last ${activityEntries.length} changes.</div>${rows}</section>`;
}
function restoreFromTrash(id) {
  const entry = getTrash().find(t => t.id === id);
  if (!entry) return;
  appState = { ...appState, trash: getTrash().filter(t => t.id !== id) };
  if (entry.kind === 'month') {
    const md = getMDFor(entry.mk);
    updateMonthFor(entry.mk, { [entry.cat]: [...(md[entry.cat]||[]), entry.item] });
  } else if (entry.kind === 'nehaTransfer') {
    const nb = getNehaBank();
    saveNehaBank({ ...nb, transfers: [...nb.transfers, entry.item] });
  } else if (entry.kind === 'ccPayment') {
    const cur = getCcPayments();
    saveCcPayments({ ...cur, [entry.cardKey]: [...cur[entry.cardKey], entry.item] });
  } else if (entry.kind === 'fixedItem') {
    restoreDiscontinuedItem(entry.key);
  }
  renderMenu();
}
// Credit-card bill payments (top-level, cross-month). Rides in the synced blob.
function getCcPayments() {
  const c = appState.ccPayments || {};
  return { axisCC: c.axisCC || [], scapiaCC: c.scapiaCC || [] };
}

// Neha's bank balance (top-level, cross-month). Rides in the synced blob.
function getNehaBank() {
  const n = appState.nehaBank || {};
  return { initialBalance: Number(n.initialBalance||0), transfers: n.transfers || [] };
}
function saveNehaBank(next, logMsg) {
  pushUndo('Neha Bank change');
  appState = { ...appState, nehaBank: next };
  saveLocal(); renderMenu(); if (IN_GAS) scheduleSync();
  logActivity(logMsg || 'updated Neha Bank');
}
function setNehaInitialBalance(val) {
  saveNehaBank({ ...getNehaBank(), initialBalance: Math.round(Number(val)||0) });
}
function addNehaTransfer(direction, amount, date) {
  const amt = Math.round(Number(amount));
  if (!(amt > 0)) return;
  const nb = getNehaBank();
  saveNehaBank({ ...nb, transfers: [...nb.transfers, { amount:amt, date: date||today(), direction }] },
    `transferred ₹${amt} (${direction==='in'?'Avishek → Neha':'Neha → Avishek'})`);
}
function deleteNehaTransfer(idx) {
  const nb = getNehaBank();
  const item = nb.transfers[idx];
  if (item) moveToTrash({ kind:'nehaTransfer', item });
  saveNehaBank({ ...nb, transfers: nb.transfers.filter((_,i) => i!==idx) }, 'deleted a Neha transfer');
}
// Sum of every ledger item, any month, paid via Neha Bank — mirrors ccChargesFor's
// cross-month scan but reuses collectPaidItems (already normalizes both item shapes).
function nehaBankSpent() {
  return Object.keys(appState.months||{})
    .flatMap(mk => collectPaidItems(mk))
    .filter(it => it.method === 'nehaBank')
    .reduce((s,it) => s+it.amount, 0);
}
function nehaBankTransferNet() {
  return getNehaBank().transfers.reduce((s,t) => s + (t.direction==='in' ? t.amount : -t.amount), 0);
}
function nehaBankBalance() {
  return getNehaBank().initialBalance + nehaBankTransferNet() - nehaBankSpent();
}

// ── Budgets (per-category monthly cap; top-level, synced) ──────────────────
// Keys match monthCategoryTotals() so an over-budget check is a direct compare.
const BUDGET_CATS = [['maids','Maids'],['aavia','Aavia'],['fixed','Fixed'],['household','Household'],['neha','Neha'],['avishek','Avishek']];
function getBudgets() { return appState.budgets || {}; }
function saveBudgets(next, logMsg) {
  pushUndo('Budget change');
  appState = { ...appState, budgets: next };
  saveLocal(); render(); renderMenu(); if (IN_GAS) scheduleSync();
  logActivity(logMsg || 'updated a budget');
}
function setBudget(cat, val) {
  const amt = Math.round(Number(val)||0);
  const cur = { ...getBudgets() };
  if (amt > 0) cur[cat] = amt; else delete cur[cat]; // 0 / blank clears the cap
  saveBudgets(cur, amt > 0 ? `set ${cat} budget to ₹${amt}` : `cleared ${cat} budget`);
}

function getMD()        { return getMDFor(currentMonth); }
function getMDFor(mk)   { return { ...emptyMonth(), ...(appState.months[mk] || {}) }; }

function updateMonth(patch, logMsg) {
  pushUndo('Ledger change · ' + monthLabel(currentMonth));
  const next = { ...getMD(), ...patch };
  appState = { ...appState, months: { ...appState.months, [currentMonth]: next } };
  saveLocal();
  render();
  if (IN_GAS) scheduleSync();
  logActivity(logMsg || ('edited ' + monthLabel(currentMonth) + ' ledger'));
}
function updateMonthFor(mk, patch, logMsg, silent) {
  pushUndo('Ledger change · ' + monthLabel(mk));
  const next = { ...getMDFor(mk), ...patch };
  appState = { ...appState, months: { ...appState.months, [mk]: next } };
  saveLocal();
  render();
  if (IN_GAS) scheduleSync();
  if (!silent) logActivity(logMsg || ('edited ' + monthLabel(mk) + ' ledger'));
}

// ── Storage ────────────────────────────────────────────────────────────────
function saveLocal() { localStorage.setItem(STORAGE_KEY, JSON.stringify(appState)); }
function loadLocal() {
  try { const r = localStorage.getItem(STORAGE_KEY); if (r) appState = JSON.parse(r); } catch(e){}
}
// Durable "a save hasn't made it to the sheet yet" flag — survives an app
// restart, unlike the in-memory pushBusy/pushDirty/syncTimer flags, so a
// push that failed right before the app closed still gets retried on boot.
function getPendingSync() { return localStorage.getItem(PENDING_SYNC_KEY) === '1'; }
function setPendingSync(v) {
  try { if (v) localStorage.setItem(PENDING_SYNC_KEY, '1'); else localStorage.removeItem(PENDING_SYNC_KEY); } catch(e){}
}
function loadUI() {
  try { const r = localStorage.getItem(UI_KEY); if (r) uiPrefs = { collapsed:{}, ...JSON.parse(r) }; } catch(e){}
}
function saveUI() {
  try { localStorage.setItem(UI_KEY, JSON.stringify(uiPrefs)); } catch(e){}
}

// ── Theme (light / dark / auto) ────────────────────────────────────────────
function themePref() { return uiPrefs.theme || 'auto'; }
function resolveDark(pref) {
  return pref === 'dark' || (pref === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme:dark)').matches);
}
function applyTheme() {
  const dark = resolveDark(themePref());
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0f1216' : '#eef1f4');
}
function cycleTheme() {
  const order = ['auto','light','dark'];
  uiPrefs.theme = order[(order.indexOf(themePref()) + 1) % order.length];
  saveUI(); applyTheme(); renderMenu();
}
function themeLabel() {
  const p = themePref();
  return p === 'auto' ? 'Auto' : p === 'dark' ? 'Dark' : 'Light';
}
// Keep 'auto' in step with the OS if the system theme flips while the app is open.
if (window.matchMedia) {
  try { matchMedia('(prefers-color-scheme:dark)').addEventListener('change', () => { if (themePref()==='auto') applyTheme(); }); } catch(e){}
}

// ── Pure calc helpers ──────────────────────────────────────────────────────
function daysInMonth(mk) {
  const [y,m] = mk.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
function monthLabel(mk) {
  const [y,m] = mk.split('-').map(Number);
  return new Date(y, m-1, 1).toLocaleDateString('en-IN',{ month:'long', year:'numeric' });
}
function monthShort(mk) {
  const [y,m] = mk.split('-').map(Number);
  return new Date(y, m-1, 1).toLocaleDateString('en-IN',{ month:'short', year:'2-digit' });
}
function inr(n) {
  const v = Math.round((n + Number.EPSILON)*100)/100;
  return v.toLocaleString('en-IN',{ maximumFractionDigits:2 });
}
function addMonths(mk, d) {
  const [y,m] = mk.split('-').map(Number);
  const dt = new Date(y, m-1+d, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`;
}
function maidPayout(base, leaves, dim) {
  const perDay = base / dim;
  if (leaves > 2) return base - (leaves-2)*perDay;
  if (leaves < 2) return base + (2-leaves)*perDay;
  return base;
}
function defaultJapaDays(mk) {
  if (mk==='2026-08') return 4;
  if (mk==='2026-09') return 30;
  if (mk==='2026-10') return 31;
  return 0;
}
function japaMaidPayout(mk, daysPresent) {
  const dim = daysInMonth(mk);
  if (!(mk>='2026-08' && mk<='2026-10')) return 0;
  const d = daysPresent==null ? defaultJapaDays(mk) : daysPresent;
  return (28000/dim)*d;
}

// ── Effective base lookup ──────────────────────────────────────────────────
function effectiveBase(mk, key, defaultVal) {
  let m = mk;
  while (m >= MIN_MONTH) {
    const stored = appState.months[m];
    if (stored && stored.bases && stored.bases[key] !== undefined) return stored.bases[key];
    if (m === MIN_MONTH) break;
    m = addMonths(m, -1);
  }
  return defaultVal;
}

// ── Fixed-item lifecycle: add/delete a fixed expense without rewriting history ──
// discontinuedFrom[key] is the LAST ACTIVE month (closed interval), not the first
// excluded one — so the month a delete happens in is itself always left untouched,
// and only strictly-later months change. This keeps collectPaidItems (which shows
// already-paid history and is deliberately never guarded by this check) consistent
// with the section totals for the same month.
function isDiscontinued(key, mk) {
  const cutoff = (appState.discontinuedFrom||{})[key];
  return !!cutoff && mk > cutoff;
}
function fixedLabel(key) {
  return FIXED_LABELS[key] || ((appState.customFixedItems||{})[key]||{}).label || key;
}
// Custom fixed items are user-added recurring expenses (appState.customFixedItems),
// additive alongside the hardcoded ones — not a replacement for them. `type` picks
// which existing calculation pattern to reuse (flat/rent-like, leaveProrated/maid-like,
// attendance/swimming-like, perClassDate/chess-like); startMonth is always the ledger
// month it was created in, never backdatable.
function customItemAmount(mk, key, item) {
  if (mk < item.startMonth) return 0;
  const md = getMDFor(mk), dim = daysInMonth(mk);
  if (item.type === 'flat')         return effectiveBase(mk, key, item.amount);
  if (item.type === 'leaveProrated') return maidPayout(effectiveBase(mk, key, item.amount), md.maidLeaves[key] ?? 0, dim);
  if (item.type === 'attendance')    return (md.customAttended||{})[key] ? effectiveBase(mk, key, item.amount) : 0;
  if (item.type === 'perClassDate')  return ((md.customClassDates||{})[key]||[]).length * effectiveBase(mk, key+'Rate', item.rate);
  return 0;
}
function activeCustomItems(mk, section) {
  const items = appState.customFixedItems || {};
  return Object.keys(items)
    .filter(k => items[k].section === section && mk >= items[k].startMonth && !isDiscontinued(k, mk))
    .map(k => ({ key:k, ...items[k] }));
}
function customSectionTotal(mk, section) {
  return activeCustomItems(mk, section).reduce((s,it) => s + customItemAmount(mk, it.key, it), 0);
}
function customSectionPaid(mk, section) {
  const md = getMDFor(mk);
  return activeCustomItems(mk, section).reduce((s,it) => s + (md.paid[it.key] ? customItemAmount(mk, it.key, it) : 0), 0);
}

// ── Delete/discontinue a fixed item (built-in or custom) ────────────────────
// Reuses the existing trash/restore pattern so this behaves like every other
// delete in the app — "Recently Deleted" gets a Restore button, nothing new
// to learn. See isDiscontinued() above for why the cutoff month itself is left
// untouched (closed interval, not "first excluded month").
function saveDiscontinued(next, logMsg) {
  pushUndo('Fixed item change');
  appState = { ...appState, discontinuedFrom: next };
  saveLocal(); render(); if (IN_GAS) scheduleSync();
  logActivity(logMsg || 'updated fixed items');
}
function discontinueFixedItem(key, label) {
  if (!confirm(`Stop tracking "${label}" from next month onward? ${monthLabel(currentMonth)} itself is unaffected.`)) return;
  moveToTrash({ kind:'fixedItem', key, item:{ label, cutoffMonth: currentMonth } });
  saveDiscontinued({ ...(appState.discontinuedFrom||{}), [key]: currentMonth },
    `stopped tracking ${label} after ${monthLabel(currentMonth)}`);
}
function restoreDiscontinuedItem(key) {
  const next = { ...(appState.discontinuedFrom||{}) };
  delete next[key];
  saveDiscontinued(next, `restored ${fixedLabel(key)} to the ledger`);
}

// ── Add a new custom fixed item ─────────────────────────────────────────────
function saveCustomFixedItems(next, logMsg) {
  pushUndo('Fixed item change');
  appState = { ...appState, customFixedItems: next };
  saveLocal(); render(); if (IN_GAS) scheduleSync();
  logActivity(logMsg || 'added a fixed item');
}
function openAddFixedItem() {
  const overlay = document.getElementById('add-fixed-overlay');
  overlay.classList.remove('hidden');
  document.getElementById('afi-label').value = '';
  document.getElementById('afi-amount').value = '';
  document.getElementById('afi-section').value = 'household';
  document.getElementById('afi-type').value = 'flat';
  afiTypeChanged();
  attachOverlayBackHandler('add-fixed-overlay', closeAddFixedItem);
}
function closeAddFixedItem() { document.getElementById('add-fixed-overlay').classList.add('hidden'); }
function afiTypeChanged() {
  const type = document.getElementById('afi-type').value;
  const hints = {
    flat: 'Same amount every month until deleted.',
    leaveProrated: 'Prorated by leave days taken, like the maids.',
    attendance: 'Only charged in months marked as attended, like Swimming.',
    perClassDate: 'Amount is per-class rate × classes attended, like Chess.',
  };
  document.getElementById('afi-type-hint').textContent = hints[type] || '';
  document.getElementById('afi-amount').placeholder = type === 'perClassDate' ? 'rate per class' : 'amount';
}
function submitAddFixedItem() {
  const label = (document.getElementById('afi-label').value || '').trim();
  const section = document.getElementById('afi-section').value;
  const type = document.getElementById('afi-type').value;
  const amount = Math.round(Number(document.getElementById('afi-amount').value) || 0);
  if (!label || !(amount > 0)) { alert('Label and amount are required'); return; }
  const key = 'custom_' + Date.now().toString(36);
  const item = { label, section, type, startMonth: currentMonth };
  if (type === 'perClassDate') item.rate = amount; else item.amount = amount;
  saveCustomFixedItems({ ...(appState.customFixedItems||{}), [key]: item },
    `added fixed expense: ${label} (${type})`);
  closeAddFixedItem();
}

// ── School fee functions ───────────────────────────────────────────────────
function schoolMonthlyRate(mk) {
  return effectiveBase(mk, 'schoolRate', 10357);
}
function schoolTuition(mk) {
  const mo = parseInt(mk.split('-')[1]);
  if (mo===2||mo===3) return 0;
  const rate = schoolMonthlyRate(mk);
  return mo===1 ? rate * 3 : rate;
}
function schoolTermFee(mk) {
  const mo = parseInt(mk.split('-')[1]);
  return (mo===4||mo===10) ? schoolMonthlyRate(mk) : 0;
}
function schoolBusFee(mk) {
  const mo = parseInt(mk.split('-')[1]);
  return (mo===4||mo===10) ? effectiveBase(mk, 'schoolBus', 25150) : 0;
}
function bizoneFee(mk) {
  const mo = parseInt(mk.split('-')[1]);
  return (mo===4||mo===10) ? effectiveBase(mk, 'bizone', 12285) : 0;
}
function englishFee(mk)  { return (mk==='2026-07'||mk==='2026-11') ? effectiveBase(mk,'english',10000) : 0; }
function carEmiFee(mk)   { return (mk>='2022-08'&&mk<='2027-07') ? effectiveBase(mk,'carEmi',37500) : 0; }
function rentFee(mk) {
  if (mk<'2026-08') return 80000;
  if (mk==='2026-08') return 81548;
  return 83000;
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Tab / navigation ───────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  window.scrollTo(0,0);
  render();
}
// Tab-chrome DOM toggles (active tab button, month-nav visibility, FAB visibility)
// live here — inside render() — rather than switchTab(), so they're correct on
// *every* render including the very first one at boot() (which calls render()
// directly, never switchTab()), not just on manual tab taps.
function applyTabChrome() {
  document.getElementById('tab-home').classList.toggle('active', currentTab==='home');
  document.getElementById('tab-ledger').classList.toggle('active', currentTab==='ledger');
  document.getElementById('tab-outstanding').classList.toggle('active', currentTab==='outstanding');
  document.getElementById('tab-payments').classList.toggle('active', currentTab==='payments');
  document.getElementById('month-nav').classList.toggle('hidden', currentTab==='outstanding');
  document.body.classList.toggle('no-month-nav', currentTab==='outstanding');
  const fab = document.getElementById('fab');
  if (fab) fab.classList.toggle('hidden', currentTab!=='ledger'); // quick-add only on the Ledger tab
}
// Month-nav browsing window: never show months beyond the current one, and only
// go back 3 months from today (independent of MIN_MONTH, which is the app's fixed
// data-history floor used elsewhere for scanning stored base-rate overrides, etc).
function navMinMonth() {
  const floor = addMonths(todayMonthKey(), -3);
  return floor > MIN_MONTH ? floor : MIN_MONTH;
}
function shiftMonth(d) {
  const next = addMonths(currentMonth, d);
  if (next < navMinMonth() || next > todayMonthKey()) return;
  currentMonth = next;
  gDraft = { vendor:'Sagar', category:'veges', amount:'' };
  miscDrafts = {};
  render();
}
function jumpToday() {
  currentMonth = todayMonthKey();
  gDraft = { vendor:'Sagar', category:'veges', amount:'' };
  miscDrafts = {};
  render();
}

// ── Paid toggle ────────────────────────────────────────────────────────────
function togglePaid(key) {
  // Only called to UNMARK an already-paid item; new payments go through startPayment
  const md = getMD();
  const pm = { ...(md.payMethod||{}) };
  delete pm[key];
  updateMonth({ paid:{ ...md.paid, [key]: false }, payMethod: pm }, `unmarked ${fixedLabel(key)} as paid`);
}

// ── Maid leaves ────────────────────────────────────────────────────────────
// Nirmala works two shifts (morning + evening), so she can take half-day
// leaves; everyone else is whole days.
function maidLeafStep(maidKey) { return maidKey === 'nirmala' ? 0.5 : 1; }
function changeLeaves(maidKey, delta) {
  const md = getMD();
  // ?? 0 (not 2) — the 4 built-in maids always have maidLeaves pre-seeded by emptyMonth()
  // so this fallback is never actually hit for them; it only matters for a brand-new
  // custom leave-prorated item, which should start at 0 leaves, matching customItemAmount.
  const cur = md.maidLeaves[maidKey] ?? 0;
  const next = Math.max(0, Math.min(31, Math.round((cur + delta) * 2) / 2)); // snap to 0.5
  updateMonth({ maidLeaves:{ ...md.maidLeaves, [maidKey]: next } }, `set ${fixedLabel(maidKey)} leaves to ${next}`);
}
function changeJapaDays(delta) {
  const md = getMD();
  const dim = daysInMonth(currentMonth);
  const cur = md.japaDaysPresent ?? defaultJapaDays(currentMonth);
  const nextJapaDays = Math.max(0, Math.min(dim, cur+delta));
  updateMonth({ japaDaysPresent: nextJapaDays }, `set japa maid days to ${nextJapaDays}`);
}

// ── Checkboxes ─────────────────────────────────────────────────────────────
function toggleSwimming()     { const md=getMD(); updateMonth({ swimmingAttended: !md.swimmingAttended }, `swimming attended: ${!md.swimmingAttended}`); }
function toggleBharatnatyam() { const md=getMD(); updateMonth({ bharatnatyamAttended: !md.bharatnatyamAttended }, `bharatnatyam attended: ${!md.bharatnatyamAttended}`); }

// ── Date chips ─────────────────────────────────────────────────────────────
function toggleChessDate(day) {
  const md = getMD();
  const dates = md.chessDates || [];
  updateMonth({ chessDates: dates.includes(day) ? dates.filter(d=>d!==day) : [...dates,day].sort((a,b)=>a-b) }, `toggled chess class date ${day}`);
}
function toggleSkatingDate(day) {
  const md = getMD();
  const dates = md.skatingDates || [];
  updateMonth({ skatingDates: dates.includes(day) ? dates.filter(d=>d!==day) : [...dates,day].sort((a,b)=>a-b) }, `toggled skating class date ${day}`);
}
// Generic versions of the toggles above, for user-added custom fixed items (type
// 'attendance' / 'perClassDate') — the built-in swimming/bharatnatyam/chess/skating
// toggles stay as their own one-liners rather than being rewritten to call these,
// to avoid touching working code that isn't part of this change.
function toggleCustomAttended(key) {
  const md = getMD();
  const next = !(md.customAttended||{})[key];
  updateMonth({ customAttended: { ...(md.customAttended||{}), [key]: next } }, `${fixedLabel(key)} attended: ${next}`);
}
function toggleCustomClassDate(key, day) {
  const md = getMD();
  const dates = (md.customClassDates||{})[key] || [];
  const nextDates = dates.includes(day) ? dates.filter(d=>d!==day) : [...dates,day].sort((a,b)=>a-b);
  updateMonth({ customClassDates: { ...(md.customClassDates||{}), [key]: nextDates } }, `toggled ${fixedLabel(key)} class date ${day}`);
}

// ── Grocery ────────────────────────────────────────────────────────────────
function captureGroceryDraft() {
  const v=document.getElementById('g-vendor'); if(v) gDraft.vendor=v.value;
  const c=document.getElementById('g-cat');    if(c) gDraft.category=c.value;
  const a=document.getElementById('g-amt');    if(a) gDraft.amount=a.value;
  const d=document.getElementById('g-date');   if(d) gDraft.date=d.value;
}
function addGrocery() {
  captureGroceryDraft();
  const amt = Number(gDraft.amount);
  if (!amt) return;
  const date = gDraft.date || today();
  const mk = clampMonth(monthKeyOf(date));           // file into the month of the date
  const tmd = getMDFor(mk);
  const entry = { vendor:gDraft.vendor, category:gDraft.category, amount:amt, date, paid:false };
  gDraft.amount=''; gDraft.date='';
  updateMonthFor(mk, { groceries:[...(tmd.groceries||[]),entry] }, `added ₹${amt} groceries (${entry.vendor})`);
}
function toggleGroceryPaid(i) {
  // Only called to UNMARK; marking goes through startPayment
  captureGroceryDraft();
  const md = getMD();
  const item = (md.groceries||[])[i];
  updateMonth({ groceries:(md.groceries||[]).map((x,idx)=>idx===i?{...x,paid:false,payMethod:null}:x) },
    item && `unmarked ₹${item.amount} groceries (${item.vendor}) as paid`);
}
function deleteGrocery(i) {
  captureGroceryDraft();
  const md = getMD();
  const item = (md.groceries||[])[i];
  if (item) moveToTrash({ kind:'month', mk: currentMonth, cat:'groceries', item });
  updateMonth({ groceries:(md.groceries||[]).filter((_,idx)=>idx!==i) }, 'deleted a grocery item');
}

// ── Misc items ─────────────────────────────────────────────────────────────
function captureMiscDraft(cat) {
  const t=document.getElementById(`m-txt-${cat}`); if(t){ miscDrafts[cat]=miscDrafts[cat]||{}; miscDrafts[cat].text=t.value; }
  const a=document.getElementById(`m-amt-${cat}`); if(a){ miscDrafts[cat]=miscDrafts[cat]||{}; miscDrafts[cat].amount=a.value; }
  const d=document.getElementById(`m-date-${cat}`); if(d){ miscDrafts[cat]=miscDrafts[cat]||{}; miscDrafts[cat].date=d.value; }
}
function clampMonth(mk) { return (mk && mk >= MIN_MONTH) ? mk : MIN_MONTH; }
function addMiscItem(cat) {
  captureMiscDraft(cat);
  const d = miscDrafts[cat] || {};
  const text = (d.text||'').trim();
  const amt  = Number(d.amount||0);
  if (!text || !amt) return;
  const date = d.date || today();
  const mk = clampMonth(monthKeyOf(date));           // file into the month of the date
  const tmd = getMDFor(mk);
  miscDrafts[cat] = { text:'', amount:'', date:'' };
  updateMonthFor(mk, { [cat]:[...(tmd[cat]||[]),{ text, amount:amt, paid:false, date }] }, `added ₹${amt} ${cat} (${text})`);
}
function toggleMiscPaid(cat,i) {
  // Only called to UNMARK; marking goes through startPayment
  captureMiscDraft(cat);
  const md = getMD();
  const item = (md[cat]||[])[i];
  updateMonth({ [cat]:(md[cat]||[]).map((x,idx)=>idx===i?{...x,paid:false,payMethod:null}:x) },
    item && `unmarked ₹${item.amount} ${cat} (${item.text}) as paid`);
}
function deleteMiscItem(cat,i) {
  captureMiscDraft(cat);
  const md = getMD();
  const item = (md[cat]||[])[i];
  if (item) moveToTrash({ kind:'month', mk: currentMonth, cat, item });
  updateMonth({ [cat]:(md[cat]||[]).filter((_,idx)=>idx!==i) }, `deleted a ${cat} item`);
}

function today() { return new Date().toISOString().slice(0,10); }

