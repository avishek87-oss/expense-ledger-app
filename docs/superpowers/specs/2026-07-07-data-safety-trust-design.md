# Data Safety & Trust — Design (Group 2 of 4)

## Roadmap context

This is Group 2 of the four-part improvement roadmap for the household ledger app:

1. **Group 1 — CC Statement Upload & Reconciliation** (shipped, v2.6.0)
2. **Group 2 — Data Safety & Trust** (this document)
3. **Group 4 — Home Dashboard Summary**: single at-a-glance screen (month spend, CC dues, Neha balance, budget status)
4. **Group 3 — Expense Entry Friction** (deferred): vendor→category autocomplete, receipt photo attachment

This continues the cross-group design conventions established in Group 1's spec (`2026-07-07-cc-statement-upload-reconciliation-design.md`): new state is additive-only, navigation returns to the most specific relevant view, new UI reuses existing visual primitives (`.add-btn`, `.cc-card`).

## Problem

Two people (Avishek and Neha) share one ledger with no safety net today:

- **Deletions are permanent.** All 8 deletion call sites in `www/index.html` (grocery items, misc items, CC payments, Neha transfers, cycle transactions, etc.) filter/splice state directly with no recovery path. One of them, `moveDatedItem`, doesn't even go through the existing `pushUndo` session-only undo stack.
- **No record of who changed what.** `auth.email` is available client-side at edit time but nothing stamps it onto a mutation — if a number looks wrong later, there's no way to tell who touched it or when.
- **No lock on the app itself**, despite it holding full household financial data and being a real installed Android app on two shared phones.

## Design

### Part A — Soft-delete / Recently Deleted trash

All 8 existing deletion sites route through a new `moveToTrash(mk, cat, item)`-style helper instead of filtering the array directly:

- `deleteNehaTransfer`, `deleteGrocery`, `deleteMiscItem`, `deleteCcPayment`, `deleteCycleTransaction` — replace their direct filter/splice with: capture the removed item, append it to `appState.trash` (a new top-level array: `{ id, deletedAt, restoreTarget: {mk, cat, idx-context}, item }`), then filter as before.
- `moveDatedItem` — fix the existing gap: route through the same trash-aware path instead of bypassing `pushUndo`/trash entirely.
- New hamburger menu view **"Recently Deleted"** (`menuView === 'trash'`, same pattern as `cc`/`neha`/`budgets`): lists `appState.trash` entries newest-first, each with a **Restore** button that re-inserts the item at its original location (best-effort — append to the target array if the original index no longer makes sense) and removes it from `appState.trash`.
- On every render/boot, prune `appState.trash` entries older than **7 days**.
- Lives in the existing `appState` blob (same full-blob sync as everything else) — no backend change needed, since entries are few and self-pruning.

### Part B — Activity log

**Prerequisite**: stamp `auth.email` onto every mutation. The app already funnels all writes through a handful of central functions — `updateMonth`, `updateMonthFor`, `saveNehaBank`, `saveCcPayments`, `saveBudgets` — so each gets a call to a new `logActivity(action)` helper alongside its existing `saveLocal()`/`scheduleSync()` calls, describing the action in one line (e.g. `"${auth.email} added ₹500 groceries"`), not a field-level diff.

**Storage — new Apps Script endpoint, not the JSON blob:**
- `Code.gs`: add an `ActivityLog` sheet (created in `setupSheets()`, alongside the existing `AppData`/`Monthly View` sheets). New endpoint (e.g. `doPost` with `action:'log'`) appends a row `[timestamp, email, action]` via `sheet.appendRow(...)`. A separate read endpoint (`action:'getLog'`) returns the most recent N rows (or rows within a date range) without needing to touch the main `AppData` blob at all — this keeps activity logging fully decoupled from the sync payload.
- Client: `logActivity(action)` fires a lightweight POST to the log endpoint; failures are non-fatal (best-effort, doesn't block the actual save).

**In-app view**: new hamburger menu view **"Activity"** (`menuView === 'activity'`), fetches and shows the **last 7 days** by default (newest first), with a **"Load older"** action that requests the next batch further back. Full history is retained forever in the sheet — no cap, no pruning — the in-app view is just a recent-window lens on it.

### Part C — Biometric / PIN app-lock

- Add a Capacitor biometric plugin (e.g. `@aparajita/capacitor-biometric-auth` or equivalent) — same install path already used for haptics/local-notifications: `npm install` → `npx cap sync android` → native rebuild → **new native release** (this group requires `release.ps1 -Native`, unlike Group 1 which was web-only).
- On `boot()` and on `resume` (Capacitor `App` plugin's `resume` event), show a lock screen that calls the biometric prompt before rendering the rest of the app.
- **First-use setup**: if no biometric hardware is available/enrolled, prompt to set a 4-6 digit app PIN instead, stored locally on-device (not synced — this guards local access to an already-authenticated session, it isn't a account-level credential).
- Unlock via either biometric or PIN unblocks rendering; failure re-prompts (no silent bypass).

## Error handling

- Trash restore is best-effort on location (append rather than exact-index reinsertion) since the original array may have changed shape since deletion.
- Activity log POSTs are fire-and-forget from the client's perspective — a failed log write never blocks or rolls back the actual data save.
- Biometric/PIN lock: if the plugin errors (e.g. no hardware and PIN not yet set on first run), fall through to the PIN-setup flow rather than locking the user out entirely.

## Testing / verification

- Delete an item from each of the 8 call sites → confirm it appears in "Recently Deleted" with a working Restore button, and disappears automatically after the 7-day window (simulate via a backdated `deletedAt` for testing).
- Confirm `moveDatedItem` (cross-month date edit) now also produces a trash entry instead of a silent, unrecoverable removal.
- Perform an edit as each test account → confirm the Activity view shows the correct email and a readable one-line description, newest-first, and "Load older" fetches further back.
- Confirm activity log writes don't block or slow down the main save/sync path (log call is fire-and-forget).
- Force-close and relaunch the app → confirm the lock screen appears before any ledger data renders; background and resume the app → confirm it re-locks; test both the biometric path and the PIN fallback path.
