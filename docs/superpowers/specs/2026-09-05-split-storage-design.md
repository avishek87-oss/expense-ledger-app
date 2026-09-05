# Split-Storage Sync Design (per-blob AppData)

Date: 2026-09-05

## Problem

`AppData!A1` currently holds the entire app state — every month's ledger,
CC payment history, budgets, custom fixed items, discontinued-item flags,
trash, and Neha's bank transfers — as one JSON blob in a single cell.

This has caused two related classes of bug already:

1. **Unbounded growth / hard cell-size ceiling.** Google Sheets caps a
   cell at 50,000 characters. Every month of ledger history and every CC
   payment ever recorded lives in that one string forever; nothing is
   ever archived.
2. **Whole-blob overwrite races.** Two phones saving around the same time
   forces the server to pick one save as authoritative and discard (or
   awkwardly patch, field-by-field) the other. This has already silently
   dropped data twice: once for ledger transactions (fixed via
   per-transaction-id reconciliation, 2026-08-02) and once for CC payments
   (fixed via per-payment-id union merge, 2026-09-05, same session as this
   design). Every other field in the blob (`budgets`, `nehaBank`, `trash`,
   etc.) is structurally exposed to the same bug; it just hasn't been hit
   yet.

Patching this field-by-field every time a new bug surfaces doesn't scale.
This design removes the shared blob so each piece of state can never
step on another.

## Goals

- No single save can ever discard data belonging to a different field or
  a different month.
- No per-field patch-as-we-go maintenance burden going forward — the
  merge behavior is uniform and structural, not special-cased per field
  as new bugs appear.
- No UI/rendering code changes — `appState` keeps its current in-memory
  shape.
- Safe to roll out without requiring the Sheet script and the phone
  update to land in a specific order.

## Non-goals

- Changing what data is tracked or how the UI works.
- Reducing the *read* payload size (pull still returns the full
  reassembled state in one response — see "Reading" below). Growth of
  the read payload over years is not currently a problem; only the
  50,000-character single-cell ceiling and the write-race behavior are
  being fixed.

## Storage layout

The hidden `AppData` sheet tab changes from a single cell to a table,
one row per key:

| Column A (key) | Column B (JSON data) | Column C (updatedAt) |
|---|---|---|
| `month:2026-08` | that month's ledger object | ms timestamp |
| `month:2026-09` | that month's ledger object | ms timestamp |
| `ccPayments` | `{ axisCC: [...], scapiaCC: [...] }` | ms timestamp |
| `budgets` | `{ maids: 5000, ... }` | ms timestamp |
| `customFixedItems` | map | ms timestamp |
| `discontinuedFrom` | map | ms timestamp |
| `trash` | array | ms timestamp |
| `nehaBank` | `{ initialBalance, transfers: [] }` | ms timestamp |

Each row's `updatedAt` replaces the single top-level `appState.updatedAt`
used by today's staleness guard — the guard now applies per row.

## Sync protocol

### Reading (GET, app open/resume)

Unchanged from the client's perspective. The server reads every row in
the `AppData` table, reassembles the full `{ months, ccPayments,
budgets, ... }` shape, and returns it exactly as it does today. All
existing client code that consumes the pulled state (`reconcileWithSheet`,
rendering, etc.) needs no changes.

### Writing (POST, app save)

Changes from "always send the entire state" to "send only the pieces
that changed since the last successful save." The client tracks a set of
dirty keys (e.g. `month:2026-09`, `ccPayments`) as edits happen, debounces
the same 1.5s as today, then sends all currently-dirty keys in one
request:

```
POST { idToken, blobs: { "<key>": { data: <json-string>, updatedAt }, ... } }
```

The server processes each key in `blobs` independently under the
existing script lock: staleness check and merge happen per-key, so a
push touching `ccPayments` and `month:2026-09` can never be blocked or
clobbered by unrelated concurrent activity on `budgets` or `trash`.

Response shape mirrors today's per-key: for each key, whether it was
accepted as-is, or (if a race was lost) merged, with the merged data
returned so the client can adopt it for that key only — never a
whole-state replace.

## Merge rules (uniform, not field-by-field special-casing)

Every field merges additively at the most granular level available:

- **List-of-entries fields** — `month:<mk>` (per bucket), `ccPayments`
  (per card), `trash`, `nehaBank.transfers` — merge by union on each
  entry's `id`. Nothing either side has is ever discarded. (`trash`
  entries already carry an `id`; `nehaBank.transfers` gets one stamped
  client-side the same way `ccPayments` entries just did.)
- **Key-union maps** — `customFixedItems`, `discontinuedFrom`, `budgets`
  — merge by union on the map key (existing ∪ incoming, incoming wins on
  conflicting keys). `budgets` moves from whole-row newer-wins to this
  per-category-key union, matching `customFixedItems`.
- **Genuinely scalar fields** — `nehaBank.initialBalance` — no
  meaningful union exists for a single number; newer `updatedAt` wins for
  just that field.

This is the same principle already applied to `customFixedItems` /
`discontinuedFrom` today, generalized to every field so no future field
needs its own bespoke fix when the next race is discovered.

## Migration

A one-time Apps Script function (same pattern as the existing
`backfillTransactionIds`) reads today's single-cell blob and writes it
out as the new row-per-key table. Run manually once from the Apps Script
editor, idempotent, safe to re-run.

## Rollout ordering

`Code.gs` accepts **both** wire formats during the transition:

- Legacy: `{ idToken, data: <full-json-string> }` (today's format).
- New: `{ idToken, blobs: { ... } }`.

This means the Sheet script and the phone app update can land in either
order without a window of breakage — whichever arrives first, the other
side's format is still understood. The legacy path can be removed later
once all phones are confirmed on the new client, but there's no urgency
to do so (low cost to leave it).

## Client-side changes

- `appState`'s in-memory shape is unchanged — no rendering/UI code
  touched.
- Each `save*` function (`saveCcPayments`, `saveBudgets`, `updateMonth`,
  `saveNehaBank`, trash helpers, etc.) marks its own key dirty instead of
  relying on a single global "push everything" trigger.
- `auth-sync.js`'s `scheduleSync`/`pushToSheets` batch all currently-dirty
  keys into one request per the debounce window described above.
- `reconcileWithSheet` (client-side recovery merge on pull) is unaffected
  since pull still returns the full reassembled state.

## Testing

- Use the `run-expense-ledger-app` skill to smoke-test: add a ledger
  entry, record a CC payment, edit a budget category — confirm each
  syncs independently and the corresponding Sheet row updates.
- Dry-run the migration script against a copy of the live data before
  running it against the real Sheet.
- Simulate a two-phone race: stage a stale `ccPayments` push arriving
  after a `budgets` edit from another "phone," confirm neither field's
  data is lost and only the genuinely conflicting entries go through
  merge logic.
- Confirm legacy-format POST bodies (simulating a not-yet-updated phone)
  are still accepted correctly after the new `Code.gs` ships.

## Out of scope (tracked separately)

- Displaying all dates in the "Monthly View" Sheet tab as DD-MMM-YYYY —
  a small, unrelated formatting fix to do after this ships.
