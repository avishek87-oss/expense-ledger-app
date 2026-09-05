// Household Ledger — Google Apps Script JSON API
// The Android app (APK) talks to this script over HTTPS.
// The Google Sheet is the single shared source of truth for the household.
//
// SETUP:
//  1. In your Google Sheet → Extensions → Apps Script
//  2. Replace Code.gs with this file (the "ledger" HTML file is no longer needed — you may delete it)
//  3. Run setupSheets() once (approve permissions)
//  4. Deploy → New Deployment → Web App
//       Execute as: Me
//       Who has access: Anyone
//  5. Copy the Web App /exec URL — it goes into the Android app's config

const APPDATA_SHEET  = 'AppData';
const MONTHLY_SHEET  = 'Monthly View';
const ACTIVITY_SHEET = 'ActivityLog';

// ── Google Sign-In auth ────────────────────────────────────────────────────
// The app sends a Google ID token with every request. We verify it with
// Google and only accept allowlisted family accounts.
const WEB_CLIENT_ID   = '518704250288-kj3drap396frff8q1hc65tnq4sntbt1v.apps.googleusercontent.com';
const ALLOWED_EMAILS  = [
  'avishek87@gmail.com',
  'nagrawal0988@gmail.com',
];

function verifyAuth(idToken) {
  if (!idToken) return { ok:false, error:'unauthorized' };
  try {
    const resp = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions:true });
    if (resp.getResponseCode() !== 200) return { ok:false, error:'expired' };
    const t = JSON.parse(resp.getContentText());
    if (t.aud !== WEB_CLIENT_ID) return { ok:false, error:'unauthorized' };
    if (String(t.email_verified) !== 'true') return { ok:false, error:'unauthorized' };
    if (ALLOWED_EMAILS.indexOf(String(t.email).toLowerCase()) === -1) return { ok:false, error:'unauthorized' };
    return { ok:true, email:t.email };
  } catch (err) {
    return { ok:false, error:'unauthorized' };
  }
}

// ── JSON API endpoints ─────────────────────────────────────────────────────
function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// GET  ?id_token=...                    → { ok:true, data:"<json blob string>" }
// GET  ?id_token=...&op=getLog&since=... → { ok:true, entries:[{ts,email,entry}, ...] }
function doGet(e) {
  const auth = verifyAuth(e && e.parameter && e.parameter.id_token);
  if (!auth.ok) return jsonOut(auth);
  if (e && e.parameter && e.parameter.op === 'getLog') {
    return jsonOut({ ok:true, entries: getActivityLog(e.parameter.since, e.parameter.limit) });
  }
  return jsonOut({ ok:true, data:getData() });
}

// POST body: {"idToken":"...","data":"<json blob string>"}       → { ok:true }
// POST body: {"idToken":"...","op":"log","entry":"<one line>"}   → { ok:true }
function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return jsonOut({ ok:false, error:'bad request' }); }

  const auth = verifyAuth(body.idToken);
  if (!auth.ok) return jsonOut(auth);

  if (body.op === 'log') {
    if (typeof body.entry !== 'string' || !body.entry) return jsonOut({ ok:false, error:'missing entry' });
    appendActivityLog(auth.email, body.entry);
    return jsonOut({ ok:true });
  }

  if (typeof body.data !== 'string') return jsonOut({ ok:false, error:'missing data' });

  // Reject obviously invalid payloads before overwriting the sheet
  try {
    const parsed = JSON.parse(body.data);
    if (!parsed || typeof parsed.months !== 'object') throw new Error('bad shape');
  } catch (err) { return jsonOut({ ok:false, error:'invalid data json' }); }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // serialize concurrent saves from multiple phones
  let result;
  try {
    result = saveData(body.data);
  } finally {
    lock.releaseLock();
  }
  return result.stale
    ? jsonOut({ ok:true, accepted:false, data: JSON.stringify(result.state) })
    : jsonOut({ ok:true, accepted:true });
}

// ── Activity log (separate Sheet tab — never touches the AppData JSON blob) ─
function appendActivityLog(email, entry) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(ACTIVITY_SHEET);
  if (!sheet) { sheet = ss.insertSheet(ACTIVITY_SHEET); sheet.appendRow(['Timestamp','Email','Action']); sheet.hideSheet(); }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { sheet.appendRow([new Date().toISOString(), email, entry]); }
  finally { lock.releaseLock(); }
}

// Returns the most recent log entries, newest first. `since` (ISO string) and
// `limit` are optional; defaults to the last 7 days, capped at 200 rows.
function getActivityLog(since, limit) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ACTIVITY_SHEET);
  if (!sheet) return [];
  const cap = Math.min(Number(limit) || 200, 500);
  const cutoff = since ? new Date(since) : new Date(Date.now() - 7*24*60*60*1000);
  const rows = sheet.getDataRange().getValues().slice(1); // drop header row
  return rows
    .filter(r => r[0] && new Date(r[0]) >= cutoff)
    .sort((a,b) => new Date(b[0]) - new Date(a[0]))
    .slice(0, cap)
    .map(r => ({ ts: r[0] instanceof Date ? r[0].toISOString() : String(r[0]), email: r[1], entry: r[2] }));
}

// ── One-time setup ─────────────────────────────────────────────────────────
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  if (!ss.getSheetByName(APPDATA_SHEET)) {
    ss.insertSheet(APPDATA_SHEET).hideSheet();
  } else {
    ss.getSheetByName(APPDATA_SHEET).hideSheet();
  }

  if (!ss.getSheetByName(MONTHLY_SHEET)) {
    ss.insertSheet(MONTHLY_SHEET, 0);
  }

  if (!ss.getSheetByName(ACTIVITY_SHEET)) {
    const sheet = ss.insertSheet(ACTIVITY_SHEET);
    sheet.appendRow(['Timestamp','Email','Action']);
    sheet.hideSheet();
  }

  Logger.log('Done. Now deploy as Web App (Execute as: Me, Access: Anyone) and copy the /exec URL.');
}

// ── Called from the browser via google.script.run ─────────────────────────
function getData() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(APPDATA_SHEET);
  if (!sheet) { sheet = ss.insertSheet(APPDATA_SHEET); sheet.hideSheet(); }
  return sheet.getRange('A1').getValue() || '{"months":{}}';
}

// Every phone pushes its ENTIRE in-memory state on every save. If phone A
// adds a custom fixed item and pushes, then phone B — still holding a copy
// from before that add — saves anything else, phone B's push blindly
// overwrites the whole sheet and silently erases A's addition (this is
// exactly how a fixed item added on one phone stopped showing up on the
// other: nothing failed, it just got clobbered by an unrelated later save).
// customFixedItems and discontinuedFrom are both write-once, keyed-by-id
// maps — items are only ever added or flagged discontinued, never mutated
// in place — so it's safe to union them with the existing sheet contents
// instead of overwriting, closing this race for this feature. The caller
// already holds the script lock for the duration of this call, so there's
// no separate race on the merge read+write itself. (Other fields, like the
// misc-expense arrays, don't have stable ids and aren't merged here — that
// would need a broader change if it becomes a problem in practice.)
//
// updatedAt staleness guard: a push whose updatedAt predates the currently
// stored state must not clobber months/budgets/trash/etc with old data —
// this is exactly the boot-time race where a days-stale cached appState
// gets retried fire-and-forget before that phone's own fresh pull lands
// (see boot.js's pending-sync retry). Missing updatedAt (data saved before
// this field existed, or a not-yet-updated client mid-rollout) is treated
// as timestamp 0 — it never beats real data, but also never blocks the
// very first push after this ships (existing.updatedAt is also 0 then, and
// 0 < 0 is false, so incoming is accepted — matching prior behavior).
function saveData(jsonStr) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(APPDATA_SHEET);
  if (!sheet) { sheet = ss.insertSheet(APPDATA_SHEET); sheet.hideSheet(); }

  const incoming = JSON.parse(jsonStr);
  const existingRaw = sheet.getRange('A1').getValue();
  let finalState = incoming;
  let stale = false;

  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw);
      const mergedCustomFixedItems = { ...(existing.customFixedItems || {}), ...(incoming.customFixedItems || {}) };
      const mergedDiscontinuedFrom = { ...(existing.discontinuedFrom || {}), ...(incoming.discontinuedFrom || {}) };
      const mergedCcPayments = mergeCcPayments(existing.ccPayments, incoming.ccPayments);

      const incomingTs = Number(incoming.updatedAt) || 0;
      const existingTs = Number(existing.updatedAt) || 0;
      stale = incomingTs < existingTs;

      finalState = stale ? existing : incoming;
      finalState.customFixedItems = mergedCustomFixedItems;
      finalState.discontinuedFrom = mergedDiscontinuedFrom;
      finalState.ccPayments = mergedCcPayments;
      if (stale) Logger.log('saveData: rejected stale push (incoming=' + incomingTs + ' < existing=' + existingTs + '); kept existing state');

      // Defense in depth: the client's per-transaction reconciliation
      // (auth-sync.js reconcileWithSheet) already merges additively against
      // the Sheet before pushing, but dedupe by id here too in case two
      // devices race to recover/push the same item.
      dedupeTransactionIds(finalState);
    } catch (e) { Logger.log('merge error: ' + e); }
  }

  sheet.getRange('A1').setValue(JSON.stringify(finalState));

  try { writeMonthlyView(finalState); } catch(e) { Logger.log('view error: '+e); }
  return { stale: stale, state: finalState };
}

// CC payments are a top-level, cross-month array-per-card (not part of
// `months`), so the whole-blob stale/overwrite logic above used to drop
// whichever side lost outright — a payment recorded on a device whose push
// got flagged stale (or that simply lost a same-second race) was discarded
// for good the moment the client adopted the response as authoritative.
// Union both sides by id (like customFixedItems/discontinuedFrom above);
// legacy payments predating id-stamping are deduped by content instead.
function mergeCcPayments(existing, incoming) {
  const out = {};
  const cardKeys = new Set([...Object.keys(existing || {}), ...Object.keys(incoming || {})]);
  cardKeys.forEach(function (cardKey) {
    const merged = [];
    const seenIds = {};
    const seenLegacy = {};
    [].concat((existing || {})[cardKey] || [], (incoming || {})[cardKey] || []).forEach(function (p) {
      if (!p) return;
      if (p.id) {
        if (seenIds[p.id]) return;
        seenIds[p.id] = true;
      } else {
        const legacyKey = p.amount + '|' + p.date + '|' + (p.cycleKey || '');
        if (seenLegacy[legacyKey]) return;
        seenLegacy[legacyKey] = true;
      }
      merged.push(p);
    });
    out[cardKey] = merged;
  });
  return out;
}

// ── Additive merge (per-key, replaces the old whole-blob stale/reject guard) ─
// Every field merges additively: array-valued data is unioned by id (or by
// exact value/content when no id exists, e.g. legacy entries or plain date
// lists); every other key takes whichever side is currently being pushed,
// falling back to the existing side only if the incoming side omitted it.
// This means no save can ever discard another save's data, and a new field
// added later needs no special-case merge code — it falls out of this
// uniform rule automatically.
function unionArray(a, b) {
  var out = [];
  var seenIds = {};
  var seenOther = {};
  [].concat(a || [], b || []).forEach(function (it) {
    if (it && typeof it === 'object') {
      if (it.id) {
        if (seenIds[it.id]) return;
        seenIds[it.id] = true;
      } else {
        var k = JSON.stringify(it);
        if (seenOther[k]) return;
        seenOther[k] = true;
      }
    } else {
      if (seenOther[it]) return;
      seenOther[it] = true;
    }
    out.push(it);
  });
  return out;
}

function mergeObjectAdditive(existing, incoming) {
  var out = Object.assign({}, existing || {}, incoming || {});
  var keys = {};
  Object.keys(existing || {}).forEach(function (k) { keys[k] = true; });
  Object.keys(incoming || {}).forEach(function (k) { keys[k] = true; });
  Object.keys(keys).forEach(function (k) {
    var ev = (existing || {})[k], iv = (incoming || {})[k];
    if (Array.isArray(ev) || Array.isArray(iv)) out[k] = unionArray(ev, iv);
  });
  return out;
}

function mergeKey(key, existing, incoming) {
  if (key === 'trash') return unionArray(existing, incoming);
  return mergeObjectAdditive(existing, incoming);
}

// Removes duplicate transaction ids within each month/bucket array
// (first occurrence wins). Mutates state in place.
function dedupeTransactionIds(state) {
  const months = state.months || {};
  for (const mk in months) {
    const month = months[mk];
    for (const bucket in month) {
      const arr = month[bucket];
      if (!Array.isArray(arr)) continue;
      const seen = {};
      month[bucket] = arr.filter(function (it) {
        if (!it || !it.id) return true; // no id (e.g. plain-string date lists) — keep as-is
        if (seen[it.id]) return false;
        seen[it.id] = true;
        return true;
      });
    }
  }
}

// ── One-time backfill: run manually from the Apps Script editor after this
// file ships, so every existing transaction gets a stable id (new
// transactions get one from the client automatically). Idempotent — safe
// to re-run; only items missing an id are touched.
function backfillTransactionIds() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(APPDATA_SHEET);
  if (!sheet) { Logger.log('backfillTransactionIds: no AppData sheet found'); return; }

  const raw = sheet.getRange('A1').getValue();
  if (!raw) { Logger.log('backfillTransactionIds: AppData!A1 is empty'); return; }

  const state = JSON.parse(raw);
  let stamped = 0;
  const months = state.months || {};
  for (const mk in months) {
    const month = months[mk];
    for (const bucket in month) {
      const arr = month[bucket];
      if (!Array.isArray(arr)) continue;
      month[bucket] = arr.map(function (it) {
        if (it && typeof it === 'object' && !it.id) {
          stamped++;
          return Object.assign({ id: Utilities.getUuid() }, it);
        }
        return it;
      });
    }
  }

  sheet.getRange('A1').setValue(JSON.stringify(state));
  Logger.log('backfillTransactionIds: stamped ' + stamped + ' transactions');
}

// ── Human-readable Monthly View ────────────────────────────────────────────
function writeMonthlyView(state) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(MONTHLY_SHEET);
  if (!sheet) sheet = ss.insertSheet(MONTHLY_SHEET, 0);

  sheet.clearContents();
  sheet.clearFormats();

  const months = state.months || {};
  const keys   = Object.keys(months).sort();
  if (!keys.length) return;

  const discontinuedFrom = state.discontinuedFrom || {};
  const customFixedItems = state.customFixedItems || {};

  // Effective bases cascade forward as we process months in order
  const curBases = { nirmala:10000, varsha:7500, meenal:4000, sujata:2800, swimming:4000, bharatnatyam:1500, rent:null, schoolBus:25150, bizone:12285, schoolRate:10357, chessRate:500, skatingRate:375 };

  let r = 1;

  // Title
  const titleRange = sheet.getRange(r, 1, 1, 5);
  titleRange.merge().setValue('Household Ledger')
    .setFontSize(14).setFontWeight('bold')
    .setBackground('#1f2a24').setFontColor('#f7f4ec');
  r += 2;

  keys.forEach(mk => {
    const md  = months[mk];
    const dim = daysInMonth(mk);

    // Apply any base overrides stored in this month
    Object.assign(curBases, md.bases || {});

    // Month header
    sheet.getRange(r, 1, 1, 5).merge()
      .setValue(fmtMonthLabel(mk))
      .setFontSize(12).setFontWeight('bold')
      .setBackground('#d9d2c0').setFontColor('#1f2a24');
    r++;

    // Column headers
    ['Category','Detail','Amount (₹)','Paid?','Cumul. Paid (₹)'].forEach((h,i)=>
      sheet.getRange(r, i+1).setValue(h));
    sheet.getRange(r, 1, 1, 5).setFontWeight('bold').setBackground('#f7f4ec');
    r++;

    const PAY_LABELS = { axisCC:'Axis CC', scapiaCC:'Scapia CC', avishekBank:'Avishek Bank', nehaCash:'Neha Cash', nehaBank:'Neha Bank' };
    const payMethod = md.payMethod || {};
    let cumPaid = 0;
    const wr = (cat, detail, amount, paid, method) => {
      if (paid) cumPaid += amount;
      sheet.getRange(r, 1).setValue(cat);
      sheet.getRange(r, 2).setValue(detail || '');
      sheet.getRange(r, 3).setValue(amount).setNumberFormat('#,##0.00');
      const pc = sheet.getRange(r, 4);
      const paidLabel = paid ? ('✓ ' + (PAY_LABELS[method] || 'Paid')) : 'Due';
      pc.setValue(paidLabel)
        .setFontColor(paid ? '#3f5344' : '#8b3a3a')
        .setFontWeight(paid ? 'bold' : 'normal');
      sheet.getRange(r, 5).setValue(cumPaid).setNumberFormat('#,##0.00').setFontColor('#3f5344');
      r++;
    };

    // Custom fixed items for a section, appended after that section's built-in rows.
    const wrCustom = (section) => {
      activeCustomItems(customFixedItems, mk, section, discontinuedFrom).forEach(it => {
        const amt = customItemAmount(mk, it.key, it, curBases, md);
        if (amt > 0) wr(it.label, 'custom', amt, !!(md.paid||{})[it.key], payMethod[it.key]);
      });
    };

    // Maids
    sectionLbl(sheet, r, 'Maids'); r++;
    [
      {key:'nirmala',label:'Nirmala'},
      {key:'varsha', label:'Varsha'},
      {key:'meenal', label:'Meenal'},
      {key:'sujata', label:'Sujata'},
    ].forEach(m => {
      if (isDiscontinued(discontinuedFrom, m.key, mk)) return;
      const lv  = ((md.maidLeaves)||{})[m.key] ?? 2;
      const amt = maidPayout(curBases[m.key], lv, dim);
      wr(m.label, lv+' leave'+(lv===1?'':'s'), amt, !!((md.paid||{})[m.key]), payMethod[m.key]);
    });

    const japaActive = mk >= '2026-08' && mk <= '2026-10';
    if (japaActive && !isDiscontinued(discontinuedFrom, 'japaMaid', mk)) {
      const days = md.japaDaysPresent ?? defaultJapaDays(mk);
      wr('Japa Maid', days+'/'+dim+' days', (28000/dim)*days, !!(md.paid||{}).japaMaid, payMethod.japaMaid);
    }
    wrCustom('maids');

    // Aavia — School
    sectionLbl(sheet, r, 'Aavia — School'); r++;
    const tu = schoolTuition(mk, curBases), tf = schoolTermFee(mk, curBases), bf = schoolBusFee(mk, curBases);
    const st = tu + tf + bf;
    if (st > 0 && !isDiscontinued(discontinuedFrom, 'schoolFees', mk)) {
      const schoolMo = parseInt(mk.split('-')[1]);
      const parts = [tu?`tuition ₹${tu}${schoolMo===1?' (Jan+Feb+Mar)':''}`:null]; if(tf) parts.push('term ₹'+tf); if(bf) parts.push('bus ₹'+bf);
      wr('PG Garodia School', parts.filter(Boolean).join(' + '), st, !!(md.paid||{}).schoolFees, payMethod.schoolFees);
    }
    const bz = bizoneFee(mk, curBases);
    if (bz > 0 && !isDiscontinued(discontinuedFrom, 'bizone', mk)) wr('Bizone (snacks)', 'Term fee', bz, !!(md.paid||{}).bizone, payMethod.bizone);

    // Aavia — Classes
    sectionLbl(sheet, r, 'Aavia — Classes'); r++;
    const en = englishFee(mk);
    if (en > 0 && !isDiscontinued(discontinuedFrom, 'english', mk)) wr('English (Sheetal)', 'Installment', en, !!(md.paid||{}).english, payMethod.english);
    if (md.swimmingAttended && !isDiscontinued(discontinuedFrom, 'swimming', mk))         wr('Swimming',     'Attended', curBases.swimming,     !!(md.paid||{}).swimming,     payMethod.swimming);
    if (md.bharatnatyamAttended && !isDiscontinued(discontinuedFrom, 'bharatnatyam', mk)) wr('Bharatnatyam', 'Attended', curBases.bharatnatyam, !!(md.paid||{}).bharatnatyam, payMethod.bharatnatyam);
    const cd = md.chessDates||[], chessR = curBases.chessRate||500;
    if (cd.length && !isDiscontinued(discontinuedFrom, 'chess', mk))  wr('Chess',   cd.length+' classes ('+cd.join(',')+')',   cd.length*chessR,  !!(md.paid||{}).chess,   payMethod.chess);
    const sd = md.skatingDates||[], skateR = curBases.skatingRate||375;
    if (sd.length && !isDiscontinued(discontinuedFrom, 'skating', mk)) wr('Skating', sd.length+' classes ('+sd.join(',')+')', sd.length*skateR, !!(md.paid||{}).skating, payMethod.skating);

    const am = md.aaviaMisc||[];
    if (am.length) { sectionLbl(sheet, r, 'Aavia — Misc'); r++; am.forEach(it=>wr('  '+it.text, it.date||'', it.amount, !!it.paid, it.payMethod)); }
    wrCustom('aavia');

    // Fixed
    sectionLbl(sheet, r, 'Fixed'); r++;
    if (!isDiscontinued(discontinuedFrom, 'sukanya', mk)) wr('Sukanya Samriddhi', 'Flat', 12500, !!(md.paid||{}).sukanya, payMethod.sukanya);
    const ce = carEmiFee(mk);
    if (ce > 0 && !isDiscontinued(discontinuedFrom, 'carEmi', mk)) wr('Car EMI', 'Aug 2022–Jul 2027', ce, !!(md.paid||{}).carEmi, payMethod.carEmi);
    const effectiveRent = curBases.rent !== null ? curBases.rent : rentFee(mk);
    if (!isDiscontinued(discontinuedFrom, 'rent', mk)) wr('Rent', rentLabel(mk), effectiveRent, !!(md.paid||{}).rent, payMethod.rent);
    wrCustom('fixed');

    // Household
    sectionLbl(sheet, r, 'Household — Groceries'); r++;
    (md.groceries||[]).forEach(g=>wr(g.vendor+' ('+g.category+')', g.date||'', g.amount, !!g.paid, g.payMethod));

    const hg = md.householdGroceries||[];
    if (hg.length) { sectionLbl(sheet, r, 'Household — Household Groceries'); r++; hg.forEach(it=>wr('  '+it.text, it.date||'', it.amount, !!it.paid, it.payMethod)); }
    const hm = md.householdMisc||[];
    if (hm.length) { sectionLbl(sheet, r, 'Household — Miscellaneous'); r++; hm.forEach(it=>wr('  '+it.text, it.date||'', it.amount, !!it.paid, it.payMethod)); }
    wrCustom('household');

    const nm = md.nehaMisc||[];
    if (nm.length) { sectionLbl(sheet, r, 'Neha — Miscellaneous'); r++; nm.forEach(it=>wr('  '+it.text, it.date||'', it.amount, !!it.paid, it.payMethod)); }
    wrCustom('neha');
    const av = md.avishekMisc||[];
    if (av.length) { sectionLbl(sheet, r, 'Avishek — Miscellaneous'); r++; av.forEach(it=>wr('  '+it.text, it.date||'', it.amount, !!it.paid, it.payMethod)); }
    wrCustom('avishek');

    // Month footer
    const monthTotal = calcMonthTotal(md, mk, dim, curBases, discontinuedFrom, customFixedItems);
    const monthPaid  = calcMonthPaid(md, mk, dim, curBases, discontinuedFrom, customFixedItems);
    sheet.getRange(r, 1, 1, 5).setBackground('#f7f4ec');
    sheet.getRange(r, 1).setValue('TOTAL').setFontWeight('bold');
    sheet.getRange(r, 3).setValue(monthTotal).setNumberFormat('#,##0.00').setFontWeight('bold');
    sheet.getRange(r, 4)
      .setValue('Paid ₹'+monthPaid.toLocaleString('en-IN')+'  /  Pending ₹'+(monthTotal-monthPaid).toLocaleString('en-IN'))
      .setFontColor(monthTotal===monthPaid ? '#3f5344' : '#8b3a3a').setFontWeight('bold');
    r += 2;
  });

  sheet.setColumnWidth(1, 225);
  sheet.setColumnWidth(2, 205);
  sheet.setColumnWidth(3, 115);
  sheet.setColumnWidth(4, 165);
  sheet.setColumnWidth(5, 135);
  sheet.setFrozenRows(1);
  SpreadsheetApp.flush();
}

function sectionLbl(sheet, r, text) {
  sheet.getRange(r, 1, 1, 5).merge()
    .setValue(text).setBackground('#eae6db').setFontColor('#7a7161')
    .setFontSize(9).setFontStyle('italic');
}

// ── Calc helpers (mirrors ledger.html exactly) ─────────────────────────────
function daysInMonth(mk) { const [y,m]=mk.split('-').map(Number); return new Date(y,m,0).getDate(); }
function fmtMonthLabel(mk) { const [y,m]=mk.split('-').map(Number); return new Date(y,m-1,1).toLocaleDateString('en-IN',{month:'long',year:'numeric'}); }
function defaultJapaDays(mk) { if(mk==='2026-08')return 4; if(mk==='2026-09')return 30; if(mk==='2026-10')return 31; return 0; }
function maidPayout(base,leaves,dim) { const p=base/dim; if(leaves>2)return base-(leaves-2)*p; if(leaves<2)return base+(2-leaves)*p; return base; }
function schoolMonthlyRate(mk, bases) { return (bases&&bases.schoolRate!=null)?bases.schoolRate:10357; }
function schoolTuition(mk, bases) { const mo=parseInt(mk.split('-')[1]); if(mo===2||mo===3)return 0; const r=schoolMonthlyRate(mk,bases); return mo===1?r*3:r; }
function schoolTermFee(mk, bases) { const mo=parseInt(mk.split('-')[1]); return (mo===4||mo===10)?schoolMonthlyRate(mk,bases):0; }
function schoolBusFee(mk, bases)  { const mo=parseInt(mk.split('-')[1]); return (mo===4||mo===10)?(bases&&bases.schoolBus!=null?bases.schoolBus:25150):0; }
function bizoneFee(mk, bases)     { const mo=parseInt(mk.split('-')[1]); return (mo===4||mo===10)?(bases&&bases.bizone!=null?bases.bizone:12285):0; }
function englishFee(mk)    { return (mk==='2026-07'||mk==='2026-11')?10000:0; }
function carEmiFee(mk)     { return (mk>='2022-08'&&mk<='2027-07')?37500:0; }
function rentFee(mk)       { if(mk<'2026-08')return 80000; if(mk==='2026-08')return 81548; return 83000; }
function rentLabel(mk)     { if(mk==='2026-08')return 'Blended ₹80k→₹83k (16th)'; return mk<'2026-08'?'₹80,000/mo':'₹83,000/mo'; }

// ── Fixed-item lifecycle (mirrors index.html's isDiscontinued/customItemAmount) ──
// discontinuedFrom[key] is the LAST ACTIVE month (closed interval) — mk===cutoff
// still counts, only mk>cutoff is excluded. Keep this in sync with the client if
// that logic ever changes; it's duplicated here because writeMonthlyView() builds
// the human-readable Sheet tab independently of the client's own rendering.
function isDiscontinued(discontinuedFrom, key, mk) {
  const cutoff = (discontinuedFrom||{})[key];
  return !!cutoff && mk > cutoff;
}
function customItemAmount(mk, key, item, curBases, md) {
  if (mk < item.startMonth) return 0;
  const dim = daysInMonth(mk);
  const base = curBases[key] !== undefined ? curBases[key] : item.amount;
  if (item.type === 'flat') return base;
  if (item.type === 'leaveProrated') return maidPayout(base, ((md.maidLeaves||{})[key]) != null ? (md.maidLeaves||{})[key] : 0, dim);
  if (item.type === 'attendance') return (md.customAttended||{})[key] ? base : 0;
  if (item.type === 'perClassDate') {
    const rate = curBases[key+'Rate'] !== undefined ? curBases[key+'Rate'] : item.rate;
    return ((md.customClassDates||{})[key]||[]).length * rate;
  }
  return 0;
}
function activeCustomItems(customFixedItems, mk, section, discontinuedFrom) {
  const items = customFixedItems || {};
  return Object.keys(items)
    .filter(k => items[k].section === section && mk >= items[k].startMonth && !isDiscontinued(discontinuedFrom, k, mk))
    .map(k => Object.assign({key:k}, items[k]));
}
function customSectionTotal(customFixedItems, mk, section, discontinuedFrom, curBases, md) {
  return activeCustomItems(customFixedItems, mk, section, discontinuedFrom)
    .reduce((s,it) => s + customItemAmount(mk, it.key, it, curBases, md), 0);
}
function customSectionPaid(customFixedItems, mk, section, discontinuedFrom, curBases, md) {
  return activeCustomItems(customFixedItems, mk, section, discontinuedFrom)
    .reduce((s,it) => s + ((md.paid||{})[it.key] ? customItemAmount(mk, it.key, it, curBases, md) : 0), 0);
}

function calcMonthTotal(md, mk, dim, bases, discontinuedFrom, customFixedItems) {
  bases = bases || { nirmala:10000, varsha:7500, meenal:4000, sujata:2800, swimming:4000, bharatnatyam:1500, rent:null, schoolBus:25150, bizone:12285, schoolRate:10357, chessRate:500, skatingRate:375 };
  discontinuedFrom = discontinuedFrom || {};
  customFixedItems = customFixedItems || {};
  const disc = k => isDiscontinued(discontinuedFrom, k, mk);
  const maidKeys = ['nirmala','varsha','meenal','sujata'];
  const maidT = maidKeys.reduce((s,k)=>s+(disc(k)?0:maidPayout(bases[k],(md.maidLeaves||{})[k]??2,dim)),0)
    + customSectionTotal(customFixedItems, mk, 'maids', discontinuedFrom, bases, md);
  const japaActive = mk>='2026-08'&&mk<='2026-10';
  const japaT = (japaActive && !disc('japaMaid'))?(28000/dim)*(md.japaDaysPresent??defaultJapaDays(mk)):0;
  const tu=schoolTuition(mk,bases),tf=schoolTermFee(mk,bases),bf=schoolBusFee(mk,bases);
  const schoolT = disc('schoolFees') ? 0 : tu+tf+bf;
  const swimT=(!disc('swimming') && md.swimmingAttended)?bases.swimming:0;
  const bharatT=(!disc('bharatnatyam') && md.bharatnatyamAttended)?bases.bharatnatyam:0;
  const chessT=disc('chess')?0:(md.chessDates||[]).length*(bases.chessRate||500);
  const skateT=disc('skating')?0:(md.skatingDates||[]).length*(bases.skatingRate||375);
  const en=disc('english')?0:englishFee(mk);
  const bz=disc('bizone')?0:bizoneFee(mk,bases);
  const ce=disc('carEmi')?0:carEmiFee(mk);
  const sukanyaT = disc('sukanya')?0:12500;
  const effectiveRent = disc('rent')?0:(bases.rent !== null ? bases.rent : rentFee(mk));
  const aaviaT = schoolT+bz+swimT+bharatT+chessT+skateT+en
    + customSectionTotal(customFixedItems, mk, 'aavia', discontinuedFrom, bases, md);
  const fixedT = sukanyaT+ce+effectiveRent
    + customSectionTotal(customFixedItems, mk, 'fixed', discontinuedFrom, bases, md);
  const miscSum = cat=>(md[cat]||[]).reduce((s,it)=>s+Number(it.amount||0),0);
  return maidT+japaT+aaviaT+fixedT
    +(md.groceries||[]).reduce((s,g)=>s+Number(g.amount||0),0)
    +miscSum('householdGroceries')+miscSum('householdMisc')
    + customSectionTotal(customFixedItems, mk, 'household', discontinuedFrom, bases, md)
    +miscSum('aaviaMisc')
    +miscSum('nehaMisc')+customSectionTotal(customFixedItems, mk, 'neha', discontinuedFrom, bases, md)
    +miscSum('avishekMisc')+customSectionTotal(customFixedItems, mk, 'avishek', discontinuedFrom, bases, md);
}

function calcMonthPaid(md, mk, dim, bases, discontinuedFrom, customFixedItems) {
  bases = bases || { nirmala:10000, varsha:7500, meenal:4000, sujata:2800, swimming:4000, bharatnatyam:1500, rent:null, schoolBus:25150, bizone:12285, schoolRate:10357, chessRate:500, skatingRate:375 };
  discontinuedFrom = discontinuedFrom || {};
  customFixedItems = customFixedItems || {};
  const disc = k => isDiscontinued(discontinuedFrom, k, mk);
  const maidKeys = ['nirmala','varsha','meenal','sujata'];
  const maidP = maidKeys.reduce((s,k)=>(!disc(k) && (md.paid||{})[k])?s+maidPayout(bases[k],(md.maidLeaves||{})[k]??2,dim):s,0)
    + customSectionPaid(customFixedItems, mk, 'maids', discontinuedFrom, bases, md);
  const japaActive=mk>='2026-08'&&mk<='2026-10';
  const japaP=(japaActive && !disc('japaMaid') && (md.paid||{}).japaMaid)?(28000/dim)*(md.japaDaysPresent??defaultJapaDays(mk)):0;
  const tu=schoolTuition(mk,bases),tf=schoolTermFee(mk,bases),bf=schoolBusFee(mk,bases);
  const p=(md.paid||{});
  const effectiveRent = bases.rent !== null ? bases.rent : rentFee(mk);
  const aaviaP = (!disc('schoolFees') && p.schoolFees?tu+tf+bf:0)+(!disc('bizone') && p.bizone?bizoneFee(mk,bases):0)
    +(!disc('swimming') && p.swimming?bases.swimming:0)+(!disc('bharatnatyam') && p.bharatnatyam?bases.bharatnatyam:0)
    +(!disc('chess') && p.chess?(md.chessDates||[]).length*(bases.chessRate||500):0)+(!disc('skating') && p.skating?(md.skatingDates||[]).length*(bases.skatingRate||375):0)
    +(!disc('english') && p.english?englishFee(mk):0)
    + customSectionPaid(customFixedItems, mk, 'aavia', discontinuedFrom, bases, md);
  const fixedP = (!disc('sukanya') && p.sukanya?12500:0)+(!disc('carEmi') && p.carEmi?carEmiFee(mk):0)+(!disc('rent') && p.rent?effectiveRent:0)
    + customSectionPaid(customFixedItems, mk, 'fixed', discontinuedFrom, bases, md);
  return maidP+japaP+aaviaP+fixedP
    +(md.groceries||[]).reduce((s,g)=>g.paid?s+Number(g.amount||0):s,0)
    +['householdGroceries','householdMisc']
      .reduce((s,cat)=>(md[cat]||[]).reduce((ss,it)=>it.paid?ss+Number(it.amount||0):ss,s),0)
    + customSectionPaid(customFixedItems, mk, 'household', discontinuedFrom, bases, md)
    +(md.aaviaMisc||[]).reduce((s,it)=>it.paid?s+Number(it.amount||0):s,0)
    +(md.nehaMisc||[]).reduce((s,it)=>it.paid?s+Number(it.amount||0):s,0)
    + customSectionPaid(customFixedItems, mk, 'neha', discontinuedFrom, bases, md)
    +(md.avishekMisc||[]).reduce((s,it)=>it.paid?s+Number(it.amount||0):s,0)
    + customSectionPaid(customFixedItems, mk, 'avishek', discontinuedFrom, bases, md);
}
