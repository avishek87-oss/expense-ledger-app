# Split-Storage Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-cell `AppData` JSON blob with one row per field (per month, `ccPayments`, `budgets`, etc.), each merged additively so no save can ever discard another save's data — plus make CC payment history visible in the "Monthly View" sheet and format all its dates as DD-MMM-YYYY.

**Architecture:** `Code.gs`'s `AppData` sheet becomes a `key | data | updatedAt` table. Reads (`doGet`) reassemble the full state from every row, unchanged from the client's point of view. Writes (`doPost`) accept a `blobs` map of only the keys that changed, merge each key independently and additively (array fields unioned by id, object-map fields unioned by key), and always return the merged result per key so the client can adopt it. A legacy whole-blob `data` field is still accepted so an old, not-yet-updated phone keeps working during rollout. `www/app-core.js`/`cc-payments.js` track which key each edit touched; `www/auth-sync.js` batches the dirty keys into one push per debounce window instead of sending the whole `appState`.

**Tech Stack:** Google Apps Script (`Code.gs`, no test runner — verified via a Node harness that evaluates the pure merge functions, plus manual smoke test through the Apps Script editor), vanilla JS in `www/` (no bundler — verified via the `run-expense-ledger-app` skill).

**Spec:** `docs/superpowers/specs/2026-09-05-split-storage-design.md`

## Global Constraints

- No changes to `appState`'s in-memory shape or to any rendering code — only save/sync plumbing changes.
- Every function in `www/*.js` stays a plain global (per `CLAUDE.md` — no modules/IIFEs).
- `Code.gs` changes are pasted into the Sheet's Apps Script editor manually — this repo does not auto-deploy it.
- The new `Code.gs` must accept pushes from both an updated and a not-yet-updated phone without either breaking (rollout-order independence).
- Simplification adopted during implementation (flagged for the user): merge is now **unconditional and additive** for every key — the old "reject as stale, client adopts server's copy" concept is removed entirely, since union merge means neither side's data is ever discarded. The one place the spec called for a timestamp tie-break (`nehaBank.initialBalance`) instead uses "the side currently being pushed wins," matching how every other scalar field in the system already behaves (e.g. `discontinuedFrom` values, month booleans) — this keeps the merge rule uniform instead of adding one field-specific special case.

---

### Task 1: Generic additive-merge helpers in `Code.gs`

**Files:**
- Modify: `Code.gs` (near existing `dedupeTransactionIds`, ~line 219)
- Test: `scratchpad/test-merge.js` (throwaway Node harness, not committed)

**Interfaces:**
- Produces: `unionArray(a, b)` → merged array; `mergeObjectAdditive(existing, incoming)` → merged object with array-valued keys unioned via `unionArray` and all other keys taking `incoming`'s value when present, else `existing`'s; `mergeKey(key, existing, incoming)` → dispatches `trash` (bare array) to `unionArray`, everything else to `mergeObjectAdditive`.

- [ ] **Step 1: Write the three functions in `Code.gs`**

```javascript
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
```

- [ ] **Step 2: Write the Node test harness**

```javascript
// scratchpad/test-merge.js — throwaway, not committed. Loads the pure merge
// functions out of Code.gs (no GAS APIs involved in these three) and runs
// them under plain Node so they can be checked without an Apps Script deploy.
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const start = src.indexOf('function unionArray');
const end = src.indexOf('// Removes duplicate transaction ids');
const vm = require('vm');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src.slice(start, end), sandbox);

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error('FAIL ' + label + '\n  got:      ' + a + '\n  expected: ' + e); process.exitCode = 1; }
  else console.log('PASS ' + label);
}

// unionArray: id-based dedup, union of both sides
assertEqual(
  sandbox.unionArray([{id:'a',v:1}], [{id:'a',v:1},{id:'b',v:2}]),
  [{id:'a',v:1},{id:'b',v:2}],
  'unionArray dedups by id and keeps both sides'
);
// unionArray: no-id objects dedup by content
assertEqual(
  sandbox.unionArray([{amount:5,date:'2026-01-01'}], [{amount:5,date:'2026-01-01'}]),
  [{amount:5,date:'2026-01-01'}],
  'unionArray dedups legacy no-id entries by content'
);
// unionArray: plain value lists (chess/skating date strings) dedup by value
assertEqual(sandbox.unionArray(['2026-01-01'], ['2026-01-01','2026-01-02']), ['2026-01-01','2026-01-02'], 'unionArray dedups primitive values');

// mergeObjectAdditive: array field unioned, scalar field incoming-wins
assertEqual(
  sandbox.mergeObjectAdditive({axisCC:[{id:'p1',amount:100}], scapiaCC:[]}, {axisCC:[{id:'p2',amount:200}], scapiaCC:[]}),
  {axisCC:[{id:'p1',amount:100},{id:'p2',amount:200}], scapiaCC:[]},
  'mergeObjectAdditive unions ccPayments per card'
);
assertEqual(
  sandbox.mergeObjectAdditive({maids:5000}, {household:3000}),
  {maids:5000, household:3000},
  'mergeObjectAdditive unions budgets by key, keeping keys only one side touched'
);
assertEqual(
  sandbox.mergeObjectAdditive({initialBalance:100, transfers:[{id:'t1',amount:50}]}, {initialBalance:150, transfers:[{id:'t2',amount:20}]}),
  {initialBalance:150, transfers:[{id:'t1',amount:50},{id:'t2',amount:20}]},
  'mergeObjectAdditive unions nehaBank transfers, incoming wins on initialBalance'
);

// mergeKey: trash routes to unionArray directly (it's a bare array, not an object)
assertEqual(
  sandbox.mergeKey('trash', [{id:'x'}], [{id:'x'},{id:'y'}]),
  [{id:'x'},{id:'y'}],
  'mergeKey(trash) unions the bare array'
);
```

- [ ] **Step 3: Run it and confirm every assertion passes**

Run: `node scratchpad/test-merge.js Code.gs`
Expected: eight `PASS` lines, no `FAIL`, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add Code.gs
git commit -m "Add generic additive-merge helpers for per-key AppData sync"
```

---

### Task 2: Row-per-key storage + auto-migration in `Code.gs`

**Files:**
- Modify: `Code.gs` (`setupSheets`, `getData`, `saveData` region — the `saveData`/`getData` functions from Task 1's predecessor are replaced by the functions below)

**Interfaces:**
- Consumes: `mergeKey(key, existing, incoming)` from Task 1.
- Produces: `ensureAppDataTable(sheet)`, `readAllRows(sheet)` → `{ key: { data: <parsed>, updatedAt: number, rowIndex: number } }`, `writeRows(sheet, updates)` where `updates` is `[{ key, data: <json string>, updatedAt }]`, `getFullState(sheet)` → the reassembled legacy `{ months, ccPayments, budgets, customFixedItems, discontinuedFrom, trash, nehaBank }` shape.

- [ ] **Step 1: Add the table helpers, replacing `getData()`/`saveData()`**

```javascript
// ── AppData storage: one row per key (key | data | updatedAt) ──────────────
// Auto-migrates the old single-cell whole-blob format the first time this
// runs against a sheet that hasn't been converted yet, so it doesn't matter
// whether the Sheet script or the phone app updates first during rollout.
function getAppDataSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(APPDATA_SHEET);
  if (!sheet) { sheet = ss.insertSheet(APPDATA_SHEET); sheet.hideSheet(); }
  ensureAppDataTable(sheet);
  return sheet;
}

function ensureAppDataTable(sheet) {
  const a1 = sheet.getRange('A1').getValue();
  const b1 = sheet.getRange('B1').getValue();
  if (a1 === 'key' && b1 === 'data') return; // already migrated

  let legacy = {};
  if (a1 && typeof a1 === 'string') {
    try { legacy = JSON.parse(a1) || {}; } catch (e) { legacy = {}; }
  }
  sheet.clear();
  sheet.getRange(1, 1, 1, 3).setValues([['key', 'data', 'updatedAt']]);

  const ts = Number(legacy.updatedAt) || Date.now();
  const rows = [];
  const months = legacy.months || {};
  Object.keys(months).forEach(function (mk) { rows.push(['month:' + mk, JSON.stringify(months[mk]), ts]); });
  rows.push(['ccPayments', JSON.stringify(legacy.ccPayments || {}), ts]);
  rows.push(['budgets', JSON.stringify(legacy.budgets || {}), ts]);
  rows.push(['customFixedItems', JSON.stringify(legacy.customFixedItems || {}), ts]);
  rows.push(['discontinuedFrom', JSON.stringify(legacy.discontinuedFrom || {}), ts]);
  rows.push(['trash', JSON.stringify(legacy.trash || []), ts]);
  rows.push(['nehaBank', JSON.stringify(legacy.nehaBank || { initialBalance: 0, transfers: [] }), ts]);
  if (rows.length) sheet.getRange(2, 1, rows.length, 3).setValues(rows);
}

function readAllRows(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return {};
  const vals = sheet.getRange(2, 1, last - 1, 3).getValues();
  const out = {};
  vals.forEach(function (row, i) {
    const key = row[0];
    if (!key) return;
    let data;
    try { data = JSON.parse(row[1]); } catch (e) { data = null; }
    out[key] = { data: data, updatedAt: Number(row[2]) || 0, rowIndex: i + 2 };
  });
  return out;
}

function writeRows(sheet, updates) {
  const rows = readAllRows(sheet);
  let nextRow = sheet.getLastRow() + 1;
  updates.forEach(function (u) {
    const existing = rows[u.key];
    const targetRow = existing ? existing.rowIndex : nextRow++;
    sheet.getRange(targetRow, 1, 1, 3).setValues([[u.key, u.data, u.updatedAt]]);
  });
}

function keyDefault(key) { return key === 'trash' ? [] : {}; }

function getFullState(sheet) {
  const rows = readAllRows(sheet);
  const state = { months: {}, ccPayments: {}, budgets: {}, customFixedItems: {}, discontinuedFrom: {}, trash: [], nehaBank: { initialBalance: 0, transfers: [] } };
  Object.keys(rows).forEach(function (key) {
    const val = rows[key].data === null ? keyDefault(key) : rows[key].data;
    if (key.indexOf('month:') === 0) state.months[key.slice(6)] = val;
    else if (key in state) state[key] = val;
  });
  return state;
}

// Merges every key in `blobs` ({ key: { data: <json string>, updatedAt } })
// against the sheet's current value for that key, writes the merged result
// back, and returns { merged: { key: <merged-json-string> } } for every key
// so the caller can adopt the merge outcome — never a whole-state replace.
function saveBlobs(sheet, blobs) {
  const rows = readAllRows(sheet);
  const merged = {};
  const updates = [];
  Object.keys(blobs).forEach(function (key) {
    let incoming;
    try { incoming = JSON.parse(blobs[key].data); } catch (e) { return; }
    const incomingTs = Number(blobs[key].updatedAt) || Date.now();
    const existingRow = rows[key];
    const existingVal = existingRow && existingRow.data !== null ? existingRow.data : keyDefault(key);
    const mergedVal = mergeKey(key, existingVal, incoming);
    const ts = Math.max(incomingTs, existingRow ? existingRow.updatedAt : 0);
    updates.push({ key: key, data: JSON.stringify(mergedVal), updatedAt: ts });
    merged[key] = JSON.stringify(mergedVal);
  });
  writeRows(sheet, updates);
  return { merged: merged };
}

// A not-yet-updated phone still POSTs the old whole-blob `{data: "<json>"}`
// shape. Split it into the same per-key pieces and route it through the
// identical merge path so old and new clients behave consistently.
function saveLegacyBlob(sheet, jsonStr) {
  const incoming = JSON.parse(jsonStr);
  const ts = Number(incoming.updatedAt) || Date.now();
  const blobs = {};
  Object.keys(incoming.months || {}).forEach(function (mk) { blobs['month:' + mk] = { data: JSON.stringify(incoming.months[mk]), updatedAt: ts }; });
  ['ccPayments', 'budgets', 'customFixedItems', 'discontinuedFrom', 'trash', 'nehaBank'].forEach(function (key) {
    if (key in incoming) blobs[key] = { data: JSON.stringify(incoming[key]), updatedAt: ts };
  });
  return saveBlobs(sheet, blobs);
}
```

- [ ] **Step 2: Update `setupSheets()` to no longer pre-hide an empty blob cell**

Replace the `AppData` block in `setupSheets()`:

```javascript
  if (!ss.getSheetByName(APPDATA_SHEET)) {
    ss.insertSheet(APPDATA_SHEET).hideSheet();
  } else {
    ss.getSheetByName(APPDATA_SHEET).hideSheet();
  }
```

with:

```javascript
  const appDataSheet = ss.getSheetByName(APPDATA_SHEET) || ss.insertSheet(APPDATA_SHEET);
  appDataSheet.hideSheet();
  ensureAppDataTable(appDataSheet);
```

- [ ] **Step 3: Delete the old `getData()` and `saveData()` functions** (now superseded by `getAppDataSheet()`/`getFullState()`/`saveBlobs()`/`saveLegacyBlob()` above).

- [ ] **Step 4: Manual verification (no local GAS runtime — verify by paste + run in the Apps Script editor against a duplicate/test copy of the Sheet, not the live one)**

1. Duplicate the household Sheet (File → Make a copy) so this is tested against a throwaway copy first.
2. Paste the updated `Code.gs` into the copy's Apps Script editor.
3. Run `setupSheets()` once from the editor (Run button), approve permissions if prompted.
4. In the editor, run a temporary test snippet via `Logger.log`: `Logger.log(JSON.stringify(getFullState(getAppDataSheet())))` — confirm it logs the reassembled state matching what was in the old blob (or an empty-but-well-shaped state on a brand new sheet).
5. Confirm the `AppData` tab now shows a `key | data | updatedAt` header row and one row per field.

- [ ] **Step 5: Commit**

```bash
git add Code.gs
git commit -m "Store AppData as one row per key instead of a single blob cell"
```

---

### Task 3: Wire `doGet`/`doPost` to the new storage

**Files:**
- Modify: `Code.gs` (`doGet`, `doPost`, ~lines 52-96)

**Interfaces:**
- Consumes: `getAppDataSheet()`, `getFullState(sheet)`, `saveBlobs(sheet, blobs)`, `saveLegacyBlob(sheet, jsonStr)` from Task 2.

- [ ] **Step 1: Update `doGet`**

```javascript
function doGet(e) {
  const auth = verifyAuth(e && e.parameter && e.parameter.id_token);
  if (!auth.ok) return jsonOut(auth);
  if (e && e.parameter && e.parameter.op === 'getLog') {
    return jsonOut({ ok:true, entries: getActivityLog(e.parameter.since, e.parameter.limit) });
  }
  return jsonOut({ ok:true, data: JSON.stringify(getFullState(getAppDataSheet())) });
}
```

- [ ] **Step 2: Update `doPost`**

```javascript
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

  const hasBlobs = body.blobs && typeof body.blobs === 'object';
  const hasLegacyData = typeof body.data === 'string';
  if (!hasBlobs && !hasLegacyData) return jsonOut({ ok:false, error:'missing data' });

  if (hasLegacyData) {
    try {
      const parsed = JSON.parse(body.data);
      if (!parsed || typeof parsed.months !== 'object') throw new Error('bad shape');
    } catch (err) { return jsonOut({ ok:false, error:'invalid data json' }); }
  }

  const sheet = getAppDataSheet();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let result;
  try {
    result = hasBlobs ? saveBlobs(sheet, body.blobs) : saveLegacyBlob(sheet, body.data);
    try { writeMonthlyView(getFullState(sheet)); } catch (e) { Logger.log('view error: ' + e); }
  } finally {
    lock.releaseLock();
  }
  return jsonOut({ ok:true, merged: result.merged });
}
```

- [ ] **Step 3: Manual verification (against the same test-copy Sheet from Task 2)**

1. In the Apps Script editor's execution log or via `curl`, POST a new-format body: `{"idToken":"<a real token>","blobs":{"budgets":{"data":"{\"maids\":5000}","updatedAt":1234}}}` and confirm the response is `{"ok":true,"merged":{"budgets":"{\"maids\":5000}"}}` and the `AppData` tab's `budgets` row updated.
2. POST a legacy-format body: `{"idToken":"...","data":"{\"months\":{},\"ccPayments\":{},\"budgets\":{\"household\":3000}}"}` and confirm it also lands correctly (merged into the same `budgets` row, both `maids` and `household` present).
3. GET the endpoint and confirm the returned `data` JSON contains both.

- [ ] **Step 4: Commit**

```bash
git add Code.gs
git commit -m "Route doGet/doPost through the per-key AppData table"
```

---

### Task 4: Visible CC Payments section + DD-MMM-YYYY dates in "Monthly View"

**Files:**
- Modify: `Code.gs` (`writeMonthlyView`, ~lines 307-472)

**Interfaces:**
- Produces: `fmtDMYSheet(iso)` → `'DD-MMM-YYYY'` string (or `''` for falsy input).

- [ ] **Step 1: Add the date formatter near the other calc helpers (~line 481)**

```javascript
function fmtDMYSheet(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return String(d.getDate()).padStart(2, '0') + '-' + MONTHS[d.getMonth()] + '-' + d.getFullYear();
}
```

- [ ] **Step 2: Apply it everywhere a raw date string is currently printed in `writeMonthlyView`**

Replace each of these five spots (all inside the `keys.forEach(mk => { ... })` loop):

```javascript
(md.groceries||[]).forEach(g=>wr(g.vendor+' ('+g.category+')', g.date||'', g.amount, !!g.paid, g.payMethod));
```
→
```javascript
(md.groceries||[]).forEach(g=>wr(g.vendor+' ('+g.category+')', fmtDMYSheet(g.date), g.amount, !!g.paid, g.payMethod));
```

```javascript
if (hg.length) { sectionLbl(sheet, r, 'Household — Household Groceries'); r++; hg.forEach(it=>wr('  '+it.text, it.date||'', it.amount, !!it.paid, it.payMethod)); }
```
→ same pattern: `wr('  '+it.text, fmtDMYSheet(it.date), it.amount, !!it.paid, it.payMethod)` — apply identically to the `hm`, `nm`, `av`, and `am` (Aavia — Misc) blocks, which all share this exact shape.

```javascript
const cd = md.chessDates||[], chessR = curBases.chessRate||500;
if (cd.length && !isDiscontinued(discontinuedFrom, 'chess', mk))  wr('Chess',   cd.length+' classes ('+cd.join(',')+')',   cd.length*chessR,  !!(md.paid||{}).chess,   payMethod.chess);
const sd = md.skatingDates||[], skateR = curBases.skatingRate||375;
if (sd.length && !isDiscontinued(discontinuedFrom, 'skating', mk)) wr('Skating', sd.length+' classes ('+sd.join(',')+')', sd.length*skateR, !!(md.paid||{}).skating, payMethod.skating);
```
→
```javascript
const cd = md.chessDates||[], chessR = curBases.chessRate||500;
if (cd.length && !isDiscontinued(discontinuedFrom, 'chess', mk))  wr('Chess',   cd.length+' classes ('+cd.map(fmtDMYSheet).join(', ')+')',   cd.length*chessR,  !!(md.paid||{}).chess,   payMethod.chess);
const sd = md.skatingDates||[], skateR = curBases.skatingRate||375;
if (sd.length && !isDiscontinued(discontinuedFrom, 'skating', mk)) wr('Skating', sd.length+' classes ('+sd.map(fmtDMYSheet).join(', ')+')', sd.length*skateR, !!(md.paid||{}).skating, payMethod.skating);
```

- [ ] **Step 3: Add a CC Payments section after the months loop**

Insert this function above `writeMonthlyView` (or directly below `sectionLbl`, ~line 478):

```javascript
function writeCcPaymentsSection(sheet, state, r) {
  const cc = state.ccPayments || {};
  const CARD_LABELS = { axisCC: 'Axis CC', scapiaCC: 'Scapia CC' };
  const keys = Object.keys(cc).filter(function (k) { return (cc[k] || []).length; });
  if (!keys.length) return r;

  sheet.getRange(r, 1, 1, 4).merge().setValue('Credit Card Payments')
    .setFontSize(12).setFontWeight('bold').setBackground('#d9d2c0').setFontColor('#1f2a24');
  r++;
  ['Card', 'Date', 'Amount (₹)', 'Cycle'].forEach(function (h, i) { sheet.getRange(r, i + 1).setValue(h); });
  sheet.getRange(r, 1, 1, 4).setFontWeight('bold').setBackground('#f7f4ec');
  r++;

  keys.forEach(function (cardKey) {
    const pays = (cc[cardKey] || []).slice().sort(function (a, b) { return new Date(a.date) - new Date(b.date); });
    pays.forEach(function (p) {
      sheet.getRange(r, 1).setValue(CARD_LABELS[cardKey] || cardKey);
      sheet.getRange(r, 2).setValue(fmtDMYSheet(p.date));
      sheet.getRange(r, 3).setValue(Number(p.amount) || 0).setNumberFormat('#,##0.00');
      sheet.getRange(r, 4).setValue(p.cycleKey || '');
      r++;
    });
  });
  return r + 1;
}
```

Then, in `writeMonthlyView`, right after the `keys.forEach(mk => { ... });` loop closes (~line 463, before `sheet.setColumnWidth(1, 225);`), add:

```javascript
  r = writeCcPaymentsSection(sheet, state, r);
```

- [ ] **Step 4: Manual verification (same test-copy Sheet)**

1. Trigger a save from the app (or re-run `writeMonthlyView(getFullState(getAppDataSheet()))` from the Apps Script editor) against the test copy.
2. Confirm the "Monthly View" tab now shows a "Credit Card Payments" section listing every payment with a `DD-MMM-YYYY` date.
3. Confirm grocery/misc rows and chess/skating class lists in the month sections above it also show `DD-MMM-YYYY` dates instead of raw `YYYY-MM-DD`.

- [ ] **Step 5: Commit**

```bash
git add Code.gs
git commit -m "Show CC payment history and DD-MMM-YYYY dates in Monthly View"
```

---

### Task 5: Client-side dirty-key tracking and per-key push

**Files:**
- Modify: `www/auth-sync.js` (`scheduleSync`, `pushToSheets`, ~lines 114-196)
- Modify: `www/app-core.js` (`moveToTrash`, `saveNehaBank`, `addNehaTransfer`, `saveBudgets`, `updateMonth`, `updateMonthFor`, `saveDiscontinued`, `saveCustomFixedItems` — every `scheduleSync()` call site)
- Modify: `www/cc-payments.js` (`saveCcPayments`, `deleteCcPayment`)

**Interfaces:**
- Produces: `scheduleSync(key)` (key required now — every existing call site passes one), `dirtyKeys` (module-level `Set`), `pushToSheets()` (now batches `dirtyKeys` into `{ idToken, blobs }`), `applyMergedBlobs(merged)` (adopts the server's per-key merge result into `appState`).

- [ ] **Step 1: Stamp an id on `nehaBank` transfers, matching the CC-payment fix from earlier this session**

In `www/app-core.js`, `addNehaTransfer` (~line 250):

```javascript
function addNehaTransfer(direction, amount, date) {
  const amt = Math.round(Number(amount));
  if (!(amt > 0)) return;
  const nb = getNehaBank();
  const id = Date.now() + '-' + Math.random().toString(36).slice(2);
  saveNehaBank({ ...nb, transfers: [...nb.transfers, { id, amount:amt, date: date||today(), direction }] },
    `transferred ₹${amt} (${direction==='in'?'Avishek → Neha':'Neha → Avishek'})`);
}
```

- [ ] **Step 2: Replace `scheduleSync()` in `www/auth-sync.js` with a dirty-key-aware version (~line 114)**

```javascript
let dirtyKeys = new Set();
function scheduleSync(key) {
  if (key) dirtyKeys.add(key);
  setPendingSync(true);
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; pushToSheets(); }, 1500);
}

// Reads the current value for one dirty key out of appState, in the shape
// the server expects to receive it.
function keyData(key) {
  if (key.indexOf('month:') === 0) return appState.months[key.slice(6)] || null;
  if (key === 'ccPayments')       return appState.ccPayments || { axisCC: [], scapiaCC: [] };
  if (key === 'budgets')          return appState.budgets || {};
  if (key === 'customFixedItems') return appState.customFixedItems || {};
  if (key === 'discontinuedFrom') return appState.discontinuedFrom || {};
  if (key === 'trash')            return appState.trash || [];
  if (key === 'nehaBank')         return appState.nehaBank || { initialBalance: 0, transfers: [] };
  return null;
}

// Adopts the server's per-key merge result into appState. Always safe to
// apply — the merge is additive, so this can only add data this device
// didn't have yet, never remove anything.
function applyMergedBlobs(merged) {
  for (const key in merged) {
    let data;
    try { data = JSON.parse(merged[key]); } catch (e) { continue; }
    if (key.indexOf('month:') === 0) appState = { ...appState, months: { ...appState.months, [key.slice(6)]: data } };
    else appState = { ...appState, [key]: data };
  }
  saveLocal();
  render();
  renderMenu();
}
```

- [ ] **Step 3: Replace `pushToSheets()` in `www/auth-sync.js` (~line 150)**

```javascript
async function pushToSheets() {
  if (pushBusy) { pushDirty = true; return; }
  if (!navigator.onLine) { setSyncState('offline'); return; }
  if (dirtyKeys.size === 0) return;
  const keysToPush = Array.from(dirtyKeys);
  dirtyKeys = new Set();
  const ts = Date.now();
  const blobs = {};
  keysToPush.forEach(k => { const d = keyData(k); if (d !== null) blobs[k] = { data: JSON.stringify(d), updatedAt: ts }; });

  pushBusy = true;
  setSyncState('busy');
  try {
    const j = await withAuthRetry(async () => {
      const res = await fetchWithTimeout(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ idToken: auth.idToken, blobs }),
      }, 8000);
      return res.json();
    });
    setSyncState(j && j.ok ? 'ok' : 'err');
    if (j && j.ok) {
      setPendingSync(false);
      consecutivePushFailures = 0;
      syncFailBannerDismissed = false;
      // A newer local edit may have landed on one of these same keys while
      // this request was in flight (pushDirty) — that edit is already
      // queued for the next push and must not be reverted by adopting an
      // older merge result now.
      if (j.merged && !pushDirty) {
        try { applyMergedBlobs(j.merged); } catch (e) {}
      }
    } else {
      keysToPush.forEach(k => dirtyKeys.add(k)); // retry on next schedule
      consecutivePushFailures++;
    }
    updateSyncFailBanner();
  } catch (e) {
    keysToPush.forEach(k => dirtyKeys.add(k));
    setSyncState('err');
    consecutivePushFailures++;
    updateSyncFailBanner();
  }
  pushBusy = false;
  if (pushDirty || dirtyKeys.size > 0) { pushDirty = false; scheduleSync(); }
}
```

- [ ] **Step 4: Update every `scheduleSync()` call site to pass its key**

In `www/app-core.js`:
- `moveToTrash` (~line 159-162): after the existing body, add `if (IN_GAS) scheduleSync('trash');` — this is new (today, trash changes only synced piggybacked on whichever field's save ran next; under per-key sync they need their own explicit dirty mark).
- `saveNehaBank` (~line 244): `if (IN_GAS) scheduleSync();` → `if (IN_GAS) scheduleSync('nehaBank');`
- `saveBudgets` (~line 285): → `scheduleSync('budgets')`
- `updateMonth` (~line 318): → `scheduleSync('month:' + currentMonth)`
- `updateMonthFor` (~line 328): → `scheduleSync('month:' + mk)`
- `saveDiscontinued` (~line 565): → `scheduleSync('discontinuedFrom')`
- `saveCustomFixedItems` (~line 584): → `scheduleSync('customFixedItems')`

In `www/cc-payments.js`:
- `saveCcPayments` (~line 796): `if (IN_GAS) scheduleSync();` → `if (IN_GAS) scheduleSync('ccPayments');`

- [ ] **Step 5: Manual verification via the `run-expense-ledger-app` skill**

1. Serve the app locally (`cd www && python3 -m http.server 8080`), open it — confirm it boots normally in local-only mode (no `GAS_URL` configured, so `IN_GAS` is false and none of this sync code runs — this just confirms nothing broke the non-sync path).
2. Use the `run-expense-ledger-app` skill to click through: add a ledger entry, record a CC payment, edit a budget, delete something (to exercise `moveToTrash`). Confirm no console errors from `auth-sync.js` or `app-core.js`.
3. With a real `secrets.json` staged (`.\stage.ps1`) against the test-copy Sheet from Task 2, repeat the same actions and confirm the corresponding `AppData` rows update (`month:<mk>`, `ccPayments`, `budgets`, `trash`) without any other row's `updatedAt` changing.

- [ ] **Step 6: Commit**

```bash
git add www/auth-sync.js www/app-core.js www/cc-payments.js
git commit -m "Sync only the changed field per save instead of the whole appState"
```

---

### Task 6: Release

**Files:**
- Modify: `www/app-core.js` (`APP_VERSION`, line 67)

- [ ] **Step 1: Paste the finished `Code.gs` into the **live** Sheet's Apps Script editor and redeploy** (not the test copy — do this only after Tasks 1-4's manual verification passed on the test copy).

- [ ] **Step 2: Bump `APP_VERSION` to `2.13.10`**

- [ ] **Step 3: Run the web-only release**

```powershell
.\release.ps1 -Version 2.13.10
```

- [ ] **Step 4: Confirm on a phone** — open the app, let it self-update, record a CC payment and a ledger edit, confirm the sync dot goes to "Synced" and the live Sheet's `AppData`/`Monthly View` tabs reflect it.
