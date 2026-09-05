# Payee Directory + Pay-via-GPay Design

Date: 2026-09-05

## Problem

Paying a recurring vendor/person (a maid, a grocery vendor, a landlord)
today means manually finding their UPI ID, phone number, or QR code
outside the app, then coming back to mark the ledger item paid. There's
nowhere in the app to keep that contact/payment info, and no shortcut from
"I'm marking this paid via Avishek Bank / Scapia CC" (the household's two
UPI-capable payment sources) to actually opening Google Pay ready to send
that payment.

## Goals

- A place to store a recurring payee's UPI ID, phone number, and/or a
  photo of their QR code — any combination, since not everyone has all
  three.
- When marking a ledger item paid via **Avishek Bank** or **Scapia CC**
  specifically (the only two payment methods in `PAY_METHODS` that are
  UPI-capable), offer a shortcut that opens Google Pay pre-filled with a
  chosen payee's UPI ID and the item's amount — or, if no UPI ID is on
  file, shows their QR photo full-screen to scan manually.
- No automatic "payment succeeded" detection — the user still taps "Mark
  Paid" themselves after returning from Google Pay, same one-tap action
  that already exists for every payment method today. (Automatic success
  detection would require writing a custom native Android plugin to
  capture Google Pay's activity result — a much larger, riskier
  undertaking with no existing plugin to build on; explicitly out of scope
  for this design.)
- Ship as a web-only update — no native dependency. The photo picker is a
  plain `<input type="file" accept="image/*">` (the OS's own picker, which
  still allows taking a live photo through the system camera app if the
  user chooses one — this is not a Capacitor camera plugin, no native
  code, no APK reinstall).

## Non-goals

- Matching a ledger item's payee automatically by name — the user
  explicitly chose "manually pick a payee each time" over automatic
  name-matching, since it's simpler and avoids mismatches.
- Automatic payment-success detection (see Goals).
- Supporting a raw phone number as a Google-Pay-deep-link target — UPI
  deep links need an actual UPI ID (VPA); there's no reliable
  cross-bank/cross-app standard for "pay this phone number" via intent. A
  stored phone number is a **reference only** (shown for the user to
  type into Google Pay manually), never used to construct the deep link.

## Data model

New synced field, `payees` — a flat list, each entry:

```json
{
  "id": "<stable id, stamped client-side like every other list entry>",
  "name": "Sagar Fruits",
  "upiId": "sagarfruits@okhdfcbank",
  "phone": "9876543210",
  "qrDriveFileId": "<Google Drive file id, or absent if no QR photo>",
  "addedDate": "2026-09-05"
}
```

All three of `upiId`, `phone`, `qrDriveFileId` are optional — a payee can
have any subset. `payees` is a plain array (like `trash`), not
keyed-by-subfield, so it merges via the existing generic
`unionArray`/tombstone machinery in `Code.gs` with zero new merge code:
adding a payee on one phone and deleting one on another both behave
exactly like every other list in the app already does.

## Backend (`Code.gs`) — two new ops

Both follow the existing `verifyAuth(idToken)` pattern used by every
current endpoint — nothing here is reachable without a valid allowlisted
login, matching the "Approach A" decision (private Drive storage, proxied
through the backend, nothing publicly exposed).

- **`op: 'uploadQr'`** (POST): `{ idToken, op:'uploadQr', name, imageBase64 }`
  → decodes the base64 payload, creates a file in a dedicated private
  Drive folder (created once, its id cached the same way `APPDATA_SHEET`
  etc. are named constants), and returns `{ ok:true, driveFileId }`. The
  client is responsible for downscaling the image before sending it (see
  Client section) — the backend does not re-compress.
- **`op: 'getQrImage'`** (GET, alongside the existing `getLog` op pattern):
  `?id_token=...&op=getQrImage&fileId=<driveFileId>` → verifies auth, reads
  the file's bytes from Drive, returns `{ ok:true, imageBase64, mimeType }`.
- Deleting a payee that has a `qrDriveFileId` also trashes that Drive file
  (`DriveApp.getFileById(id).setTrashed(true)`), so removed payees don't
  leave orphaned files behind. This happens as part of a new
  **`op: 'deletePayeeQr'`** call the client makes right before/alongside
  removing the payee entry — kept as its own small op rather than folded
  into the generic sync path, since Drive file deletion is a real
  side-effecting action or `saveBlobs`'s per-key merge doesn't need to
  know about.

**One-time manual step**: the first deployment that uses `DriveApp` will
prompt Google's standard "this script wants access to Drive" consent
screen when redeploying — normal, same kind of one-time approval as the
original `Code.gs` setup, not something recurring.

## Client (`www/`)

### New "Payees" section (hamburger drawer, alongside CC Payments / Trash)

- List view: each payee's name, a small icon row showing which of
  UPI-id/phone/QR are on file, tap to view/edit.
- Add/edit form: name (required), UPI ID (optional text), phone (optional
  text), QR photo (optional file input).
- On selecting a QR photo file: read it via `FileReader`, draw it to an
  off-screen `<canvas>` capped at (e.g.) 800px on the longest side, and
  re-encode as JPEG at moderate quality before base64-encoding and
  POSTing via `uploadQr` — QR codes stay perfectly scannable at this
  resolution, and this keeps the upload small and fast on a mobile
  connection. This mirrors nothing else in the codebase today (this is
  the first binary upload) but is a small, self-contained helper
  (`resizeImageFile(file) → Promise<base64 JPEG>`).
- Rename/delete supported, matching every other list in the app
  (`moveToTrash` + the entry's own array + `scheduleSync('payees')`, the
  same dirty-key pattern every other field already uses).

### Payment-method picker integration (`www/cc-payments.js`)

Today, `confirmPay(method)` marks the item paid immediately when a method
button is tapped — no intermediate step (`payMethodButtonsHtml` renders
one button per method, `onclick="confirmPay('${m.key}')"`).

This changes **only** for `avishekBank` and `scapiaCC`: tapping either of
those two buttons no longer calls `confirmPay` immediately. Instead it:

1. Opens a small "Pay via GPay" sub-sheet (new overlay, same pattern as
   `cc-pay-overlay`) showing:
   - A payee picker (a simple list drawn from `getPayees()`, no
     auto-matching per the Non-goals above).
   - Once a payee is picked: if `upiId` is set, a "Open Google Pay"
     button/link with `href="upi://pay?pa=<upiId>&pn=<name>&am=<amount>&cu=INR"`
     (amount comes from the item being paid, already known at this
     point in `startPayment`/`confirmPay`'s existing call chain). Else if
     `qrDriveFileId` is set, fetch and show that photo full-screen
     (`getQrImage`) for the user to scan themselves. Either way, `phone`
     (if set) is shown as plain text underneath for manual reference.
   - A **"Mark Paid"** button that calls the *existing* `confirmPay(method)`
     exactly as today — this is the only thing that actually records the
     payment; everything above it is just a convenience shortcut to
     opening Google Pay correctly, not a new source of truth.
2. Every other method (`axisCC`, `nehaCash`, `nehaBank`) is completely
   unaffected — same immediate `confirmPay(method)` behavior as today.

The "no payee has a UPI ID or QR yet" case (empty `payees` list, or a
payee with neither) just skips straight to a plain "Mark Paid" button —
this feature never blocks the existing paid-toggle flow, it only adds an
optional shortcut in front of it.

## Testing

- Node-harness-verify the two new `Code.gs` ops (`uploadQr`, `getQrImage`,
  `deletePayeeQr`) against faked `DriveApp`/`Utilities` objects, following
  the same `vm`-based pattern used throughout the sync rework earlier this
  session.
- Use the `run-expense-ledger-app` skill to smoke-test: add a payee with a
  UPI ID, add another with a QR photo (verify the client-side resize
  actually shrinks a large test image), mark a ledger item paid via
  Avishek Bank and confirm the GPay sub-sheet appears with the right
  payee list and amount, confirm the `upi://` link is well-formed, confirm
  "Mark Paid" still correctly records the payment exactly as it does for
  every other method today.
- Confirm deleting a payee with a QR photo actually removes the
  corresponding Drive file (inspect the Drive folder, or check
  `DriveApp.getFileById(id).isTrashed()` in the Apps Script editor).

## Out of scope (explicitly, per the conversation that produced this design)

- Automatic name-matching of a ledger item to a payee.
- Automatic payment-success detection after returning from Google Pay.
- Using a phone number to construct a UPI deep link.
- Any native Capacitor plugin/dependency.
