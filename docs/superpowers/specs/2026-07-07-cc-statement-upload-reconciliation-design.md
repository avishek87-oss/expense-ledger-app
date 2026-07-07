# CC Statement Upload & Reconciliation — Design (Group 1 of 4)

## Roadmap context

This spec is Group 1 of a four-part improvement roadmap for the household ledger app, sequenced as:

1. **Group 1 — CC Statement Upload & Reconciliation** (this document)
2. **Group 2 — Data Safety & Trust**: soft-delete/undo trash, activity log (who changed what/when), biometric/PIN app-lock
3. **Group 4 — Home Dashboard Summary**: single at-a-glance screen (month spend, CC dues, Neha balance, budget status)
4. **Group 3 — Expense Entry Friction** (deferred until 1/2/4 ship): vendor→category autocomplete, receipt photo attachment

Each group gets its own design → spec → implementation-plan cycle. This document covers Group 1 only.

### Cross-group design conventions

These conventions apply across all four groups, to keep the eventual release feeling coherent rather than four bolted-on features:

- **New state fields are additive-only, never repurposed.** This spec introduces `reconciled: true` as a wholly new field rather than overloading the existing `paid` field, because `paid` + `payMethod` already drives CC outstanding-balance math (`ccChargesFor` / `ccBuildCycles`). Later groups should follow the same rule — e.g. Group 2's soft-delete should use a new `deletedAt`/`trashedAt` field, not repurpose `paid` or silently remove array entries.
- **Navigation always returns to the most specific relevant view**, never a global "home" reset. This spec's statement-upload back button returns to Credit Card Payments, not the hamburger home menu. Group 2's trash view and Group 4's dashboard should follow the same rule.
- **New UI entry points reuse existing visual primitives** (`.add-btn`, `.cc-card`, `.cc-empty`) rather than introducing new one-off button/card styles.
- **Warning/mismatch banners** (first introduced here for the statement-total cross-check) establish the visual pattern for any future "something looks off, please review" surface. Later groups should reuse this treatment rather than inventing a new one.

## Problem

Two issues, bundled into one release:

1. **Outstanding tab toolbar gap**: the sticky expand/collapse toolbar's position (`--toolbar-top`) is a static CSS constant that always reserves space for the month-nav bar (`--month-nav-height: 68px`). The Outstanding tab hides the shared `#month-nav` element (`switchTab()`, index.html:994) but the CSS variable doesn't know that, leaving a fixed empty gap above the toolbar only on that tab.
2. **Statement Upload placement and depth**: "Upload Statement" (PDF parsing + reconciliation) currently lives as a top-level hamburger menu item, hardcoded end-to-end for Axis CC (header text, `payMethod: 'axisCC'`). It also doesn't persist any reconciliation outcome — matches are only displayed, never recorded. The feature needs to live inside Credit Card Payments, work for both cards, and actually mark matched transactions as reconciled.

## Design

### Part A — Outstanding tab toolbar fix

**File:** `www/index.html`

- In `switchTab()` (line 989), alongside the existing `#month-nav` hide toggle (line 994):
  ```js
  document.body.classList.toggle('no-month-nav', tab==='outstanding');
  ```
- CSS override near the `:root` custom properties (lines 33-34):
  ```css
  body.no-month-nav{--toolbar-top:calc(var(--header-sticky-height) + var(--tabbar-height));}
  ```

### Part B — Statement Upload: relocate + generalize to both cards

1. Remove the top-level menu link (line ~2102).
2. Add an "Upload Statement" button to every CC card in `ccSectionHtml()` (lines 2117-2159), right after `cc-head`, reusing `.add-btn`:
   ```html
   <button class="add-btn" style="width:100%;margin:8px 0" onclick="openStatementUpload('${cardKey}')">Upload Statement</button>
   ```
3. New module-level `stmtCardKey` next to `stmtParsed` (line 2325), plus entry function:
   ```js
   let stmtCardKey = null;
   function openStatementUpload(cardKey) { stmtCardKey = cardKey; stmtParsed = null; setMenuView('statement'); }
   ```
4. `renderMenu()`'s `statement` branch (lines 2093-2097): dynamic title, back button returns to `cc`:
   ```js
   if (menuView === 'statement') {
     if (titleEl) titleEl.textContent = (CC_CYCLES[stmtCardKey]?.label || '') + ' Statement';
     el.innerHTML = `<button class="menu-home-btn" onclick="setMenuView('cc')">← Back</button>` + statementUploadHtml();
     return;
   }
   ```
5. `statementUploadHtml()` (lines 2378-2412): dynamic header via `CC_CYCLES[stmtCardKey]?.label`; matched rows prefixed with `✓`.
6. `resetStatement()` (line 2423): clear `stmtCardKey`, return to `cc`.
7. `parseStatement(file, password, cardKey)`: add `cardKey` param; same generic date+amount regex reused for both cards for now. **Accepted risk**: Scapia's real statement layout is unverified — will tune the regex after testing with a real file.
8. `submitStatementUpload()`: pass `stmtCardKey` through to `parseStatement` and `matchTransactions`.

### Part C — Reconciliation semantics

- `matchTransactions(stmtTxns, cardKey)` (lines 2362-2377): include `payMethod: it.payMethod` in mapped `appTxns`, filter to `payMethod === cardKey` before matching — avoids cross-card false positives (same amount/date coincidentally on both cards).
- `submitStatementUpload()`: after computing `matched`, persist `reconciled: true` onto each matched ledger item, reusing the existing single-item-update pattern (index.html:1495):
  ```js
  matched.forEach(({app}) => {
    const md = getMDFor(app.mk);
    updateMonthFor(app.mk, { [app.cat]: (md[app.cat]||[]).map((it,idx)=>idx===app.i?{...it, reconciled:true}:it) });
  });
  ```
- `openFileUnmatched`: set `payMethod: stmtCardKey` (was hardcoded `'axisCC'`) and `reconciled: true` on newly-filed entries.
- Reconciled state is internal bookkeeping only for now — no visible badge in Ledger/CC cycle review (explicitly deferred).

### Part D — Unmatched-transaction filing UX

Replace the `prompt()` text-entry dialog in `openFileUnmatched` with tappable category buttons (Household / Neha / Avishek / Aavia) rendered inline per unmatched row, styled with `.add-btn`, instead of asking the user to type a section name.

### Part E — Statement-total cross-check

After parsing, attempt to extract the statement's own stated total (a labeled "Total Due"/"Total Amount" line, if present in the extracted PDF text) and compare it against the app's calculated total for that card/cycle (`ccBuildCycles`). If they differ by more than ₹5 (to allow for rounding), render a warning banner at the top of the reconciliation view (the shared banner pattern from the cross-group conventions) reading e.g. "Statement total ₹X doesn't match calculated total ₹Y — review for missing or duplicate entries." If no total line can be reliably extracted, skip the check silently rather than false-flagging.

### Part F — Auto-detected statement period

Attempt to extract the statement's billing-period header (e.g. "Statement Period: DD/MM/YYYY to DD/MM/YYYY") from the parsed PDF text. If found, use that date range to bound which ledger transactions are eligible for matching in `matchTransactions`, reducing false matches near cycle boundaries. If not found, fall back to matching against all of that card's logged transactions (current behavior).

## Error handling

- PDF parse failures (bad password, corrupt file, missing `pdfjsLib`) already `alert()` and abort — unchanged.
- Total-mismatch and period-detection are both best-effort: absence of a parseable total/period line degrades gracefully to current behavior (no check / full-history matching) rather than blocking the upload flow.

## Testing / verification

- Outstanding tab: confirm the sticky toolbar sits directly below the tab bar with no gap; Ledger/Payments unaffected.
- Credit Card Payments: confirm "Upload Statement" appears under both Axis CC and Scapia CC; hamburger menu no longer has the standalone link.
- Tap under each card: confirm dynamic header text, and back-navigation returns to Credit Card Payments (not home).
- Upload a sample statement with known matching transactions: confirm matched rows show `✓`, underlying ledger items get `reconciled: true`, and the CC outstanding total is unaffected (only `ccPayments` should move that number).
- Deliberately mismatch a statement total: confirm the warning banner appears; confirm it's silent when no total line is extractable.
- File an unmatched transaction via the new buttons: confirm correct `payMethod`, `reconciled: true`, and no `prompt()` dialog.
