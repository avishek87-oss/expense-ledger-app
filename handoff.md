# Handoff

## 1. Goal

Household expense ledger Android app (Capacitor, vanilla JS/HTML/CSS in
`www/`, no build step; Google Apps Script backend in `Code.gs` behind a
shared Google Sheet). This session replaced the v2.13.7 sync-fix attempt,
which turned out to be insufficient: Neha reopening the app after 4-5 days
away was still replacing fresher household data on the Sheet with her stale
local cache. Root cause: the v2.13.7 fix compared a single top-level
`appState.updatedAt` scalar — but an offline phone keeps stamping
`Date.now()` on every local edit it makes, so its `updatedAt` can be
genuinely *newer* in wall-clock terms than the Sheet's, even though its
underlying data is missing days of other people's edits. A scalar timestamp
can never resolve that; per the user's explicit request, the fix now gives
every transaction a stable id and merges additively instead of ever letting
one whole blob replace another.

## 2. Current State

**Released: v2.13.8** (commits `3e0ca71` fix, `34ec34b` release, both pushed
to `main`). GitHub release at
`https://github.com/avishek87-oss/expense-ledger-app/releases/tag/v2.13.8`.
Web-only release (no `-Native` flag) — `version.json`'s `apkVersion`/
`apkUrl`/`minApk` unchanged at `2.8.0` (carried forward). `APP_VERSION` in
`www/app-core.js` confirmed at `2.13.8`. Working tree clean except the
pre-existing, deliberately-untracked `CLAUDE.md`, `TODOS.md`, `handoff.md`
(`Code.gs` is now tracked as of this session — see below).

**Server side already deployed and backfilled by the user before this
session's client release.** User pasted the updated `Code.gs` into the
Sheet's Apps Script editor, redeployed it (new `/exec` URL:
`https://script.google.com/macros/s/AKfycbxXU6RCtjI_8Ang55_oCTnCuCLrcDN6SYzWItjj1rs-0clMYYnR37AS0joMPpdPMcyH3A/exec`),
and ran `backfillTransactionIds()` once from the Apps Script editor to stamp
ids onto every existing Sheet transaction. Confirmed this URL matches
`dist/app-core.js`'s baked-in `GAS_URL` exactly (i.e. `secrets.json`'s
`gasUrl` is already correct — no `stage.ps1`/`secrets.json` edit was needed).

**Not yet verified end-to-end on real devices.** Headless testing can only
confirm `stampIds()` stamps new transactions correctly (done — see §4); the
actual Sheet-authoritative merge (`reconcileWithSheet`) needs a real
authenticated phone since `IN_GAS` is false in the headless test
environment (`GAS_URL` placeholder unfilled there) and a valid Google ID
token is required to exercise `doGet`/`doPost`.

## 3. Active Files

- [`www/app-core.js`](www/app-core.js) — new `stampIds(patch)` helper
  (~line 298, right before `updateMonth`), reusing the trash-id pattern
  (`Date.now() + '-' + Math.random().toString(36).slice(2)`) already used
  for soft-deletes (~line 160). Called from both `updateMonth()` and
  `updateMonthFor()` (~lines 299/308) before merging `patch` into
  `appState.months` — this is the single choke point all ~10 transaction
  add-sites (menu-views.js, cc-payments.js) already funnel through, so no
  per-call-site changes were needed. `APP_VERSION` now `2.13.8`.
- [`www/auth-sync.js`](www/auth-sync.js) — new `reconcileWithSheet(remote)`
  and `monthKeyForDate(d)` helpers (~line 198, right before
  `pullFromSheets`). `remote` (the Sheet's data) is always the merge base;
  for the current + previous month key (covers a 10-day window crossing a
  month boundary), any local transaction whose `id` isn't already in the
  Sheet's copy of that bucket, and whose `date` is within the last 10 days,
  gets appended onto the Sheet's array — never the reverse. If anything got
  appended, `scheduleSync()` pushes the merged (Sheet-based) state back up.
  `pullFromSheets()` (~line 255) now calls `reconcileWithSheet(remote)`
  instead of the old `appState = remote` wholesale overwrite.
- [`www/boot.js`](www/boot.js) — removed the raw fire-and-forget
  `pushToSheets()` retry that used to fire at boot (~old line 267) whenever
  `getPendingSync()` was set. That was the actual vector for the residual
  clobber: it sent a possibly days-stale cached `appState` up as an
  unconditional overwrite candidate, ahead of the boot-time pull. The
  pending-sync retry now goes through the same
  pull-then-`reconcileWithSheet`-then-push path as every other sync point
  (boot's own `pullFromSheets()` call further down, `visibilitychange`, the
  45s interval) — no separate raw-push code path exists anymore.
- [`Code.gs`](Code.gs) — **now tracked in git** (was previously
  deliberately untracked/manual-paste-only; committed this session since it
  now carries real logic changes worth diffing). New
  `dedupeTransactionIds(state)` (~line 213), called from `saveData()`
  (~line 208) as defense-in-depth against two devices racing to push the
  same recovered item — first-occurrence-wins per `months[mk][bucket]`
  array. New one-time `backfillTransactionIds()` (~line 232) — manual-run
  only, not wired to `doGet`/`doPost`, idempotent (skips items that already
  have an `id`). Already run once by the user against the live Sheet (see
  Current State). The pre-existing `updatedAt` staleness guard in
  `saveData()` is unchanged and still protects `customFixedItems`/
  `discontinuedFrom`/other non-transaction fields — it's no longer the
  primary defense for ledger transactions, which now go through the
  client-side additive merge instead.

## 4. Changes Made

Went through full plan-mode review (`Explore` agent → direct plan write,
confirmed with the user via `ExitPlanMode`) before implementing, since this
is a correctness/data-loss bug fix, not a small feature.

1. **Central id-stamping** (`stampIds`) — retrofits every transaction
   (past *and* future) with a stable id without touching each add-site
   individually, by hooking the two functions (`updateMonth`/
   `updateMonthFor`) that all mutations already funnel through.
2. **Sheet-authoritative additive merge** (`reconcileWithSheet`) — replaces
   the old whole-blob-wins-by-timestamp model with per-transaction
   reconciliation: Sheet data is always the base, local can only ever
   contribute recent (last-10-day) transactions the Sheet doesn't have yet.
3. **Removed the raw stale-push-at-boot path** in `boot.js` — this was the
   actual mechanism (not the merge logic itself) that let a stale cache
   reach the server as a same-priority overwrite candidate.
4. **Server-side dedupe + one-time backfill** in `Code.gs`, deployed and
   run by the user directly (this repo does not auto-deploy `Code.gs` —
   per existing project convention, it's pasted into the Sheet's Apps
   Script editor manually).

**Verification performed (headless, via `run-expense-ledger-app` skill):**
booted the app, added a transaction via `updateMonthFor()` in the console,
confirmed the resulting item had a stamped `id` (e.g.
`"1785648842661-ysc3ehlna8"`) and no console errors. The Sheet-merge path
itself (`reconcileWithSheet`) could not be exercised headlessly — `IN_GAS`
is false there by design (no `GAS_URL`, no valid Google ID token) — so it's
untested beyond code review. See §6 for the real-device test still needed.

**Release**: single commit `3e0ca71` for the fix (`www/app-core.js`,
`www/auth-sync.js`, `www/boot.js`, `Code.gs`), then
`.\release.ps1 -Version 2.13.8` (web-only) → commit `34ec34b`, both pushed.

## 5. Failed Attempts

None this session — the design (per-transaction id + additive merge,
Sheet always as base) was specified directly by the user as the required
fix after the previous timestamp-scalar approach proved insufficient in
production, so there was no alternative-approach exploration needed; the
plan matched what got built with no revisions.

## 6. Next Steps

1. **Real two-phone test of the merge**, the one thing that can't be
   verified headlessly: have one phone go offline, add a transaction, stay
   offline 10+ days (or simulate by backdating `getPendingSync`/cached
   `appState.updatedAt`), while another phone adds different transactions
   to the Sheet in the meantime. Reopen the offline phone and confirm: (a)
   the Sheet ends up with the union of both phones' transactions, (b) nothing
   the Sheet already had gets overwritten, (c) both phones converge to the
   same local state as the Sheet afterward.
2. Watch for any `pdfjsLib`-style false positives or unrelated regressions
   on next real-device use — this session's changes touch every sync path
   (boot, resume, 45s interval), not just the failure case.
3. Carried over, still untouched: dead code in `www/render.js`
   (`homeCcCardHtml()`, `homeNehaCardHtml()`, `homeBudgetCardHtml()` — still
   zero call sites), and the low-priority `TODOS.md` "Home/Ledger hero-card
   duplication" item.
4. Update this handoff again after the real-device test confirms (or
   surfaces problems with) the fix.
