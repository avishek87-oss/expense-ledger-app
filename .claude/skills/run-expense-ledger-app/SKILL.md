---
name: run-expense-ledger-app
description: Build, run, and drive the Household Ledger web app (www/index.html) headlessly. Use when asked to start/serve the app, take a screenshot of its UI, click through a tab or flow, or otherwise interact with the running app without a real browser.
---

This is a single-file vanilla-JS web app (`www/index.html`) that also
ships as an Android app via Capacitor, but the JS/HTML/CSS itself needs
no build step to run — serve `www/` with any static file server. Drive
it with `.claude/skills/run-expense-ledger-app/driver.mjs`, a small
chromium-cli-style REPL built for this because `chromium-cli` isn't
installed in this container (see Gotchas).

All paths below are relative to the repo root.

## Prerequisites

Already present in this container — nothing to install:
- `python3` (for the static file server)
- Node.js + the `playwright` package (globally available at
  `/opt/node22/lib/node_modules/playwright` even with no local
  `node_modules/`)
- A pre-installed headless Chromium at `/opt/pw-browsers/chromium`

If you're on a fresh machine instead: `python3` needs no install, and
Playwright needs `npm install playwright && npx playwright install
chromium` (or `chromium-only`) once.

## Setup / Build

None. `www/index.html` runs as-is. There's a separate `stage.ps1` /
`release.ps1` pipeline (PowerShell, real Google credentials via
`secrets.json`) for producing a signed release bundle — that's not
needed to run and drive the app locally. With no `secrets.json`,
`GAS_URL`/`UPDATE_URL` stay as their unfilled `__GAS_URL__` /
`__UPDATE_URL__` placeholders, which makes the app run in **local-only
mode** (`IN_GAS` evaluates false): it reads/writes `localStorage` and
never attempts a Google Sheets sync or self-update check. This is
exactly the mode you want for driving/screenshotting the UI.

## Run (agent path)

1. Serve `www/` on any free port:

```bash
cd www && nohup python3 -m http.server 8963 >/tmp/http.log 2>&1 & disown
sleep 1.5
curl -sf http://localhost:8963/index.html -o /dev/null && echo "server is up"
```

(Prefer `nohup ... & disown` over a bare backgrounded `&` — a bare
background job in this container sometimes reports a nonzero exit
code from the *launch* command itself even though the server started
fine, which is confusing. `nohup`+`disown` avoids that.)

2. Pipe commands to the driver, one per line:

```bash
node .claude/skills/run-expense-ledger-app/driver.mjs <<'EOF'
nav http://localhost:8963/index.html
wait-for text=Household Ledger
sleep 500
screenshot home
click #tab-ledger
wait-for text=Groceries
screenshot ledger-tab
console --errors
quit
EOF
```

Screenshots land in `/tmp/expense-ledger-shots/<name>.png` (override
with `SHOTS_DIR=...`). The `sleep 500` after the first `wait-for` is
deliberate — see Gotchas (splash overlay).

| command | what it does |
|---|---|
| `nav <url>` | go to a URL |
| `wait-for text=<text>` | wait for an element containing text (case-insensitive substring) |
| `wait-for <selector>` | wait for a CSS selector |
| `click <selector>` | click an element (`page.click`) |
| `fill <selector> <value...>` | set an input's value, firing input/change events |
| `press <key>` | `keyboard.press`, e.g. `Enter` |
| `eval <js-expression>` | `page.evaluate(expr)`, prints the JSON result |
| `screenshot [name]` | full-page PNG → `SHOTS_DIR/<name>.png` |
| `console` / `console --errors` | dump captured console messages / just errors + uncaught exceptions |
| `sleep <ms>` | pause (only when polling genuinely isn't possible — see Gotchas) |
| `quit` / `exit` | close the browser, end the process |

For iterative debugging, run the same script under tmux and
`send-keys` one command at a time instead of piping a whole heredoc —
same driver, same commands.

## Run (human path)

`cd www && python3 -m http.server 8080`, then open
`http://localhost:8080/index.html` in a real browser. Ctrl-C to stop.
Useless in this headless container — use the agent path above instead.

## Test

No automated test suite exists (`package.json`'s `"test"` script is a
placeholder that always fails: `echo "Error: no test specified" &&
exit 1`). This driver is the closest thing to one — use it to smoke-test
a change end-to-end.

## Gotchas

- **`chromium-cli` isn't installed in this container.** `driver.mjs` is
  a from-scratch REPL that mimics its interface (same verb-first
  command style: `nav` / `wait-for` / `click` / `screenshot` /
  `console --errors`) using Playwright directly, loaded via
  `createRequire()` against `/opt/node22/lib/node_modules/playwright`
  since there's no local `node_modules/` in this repo. If a future
  environment does have `chromium-cli`, prefer that instead — the
  command vocabulary here was deliberately kept compatible.
- **Piping a heredoc into a `readline` `'line'`-event handler races.**
  The first version of this driver used `rl.on('line', async cb =>
  {...})` with manual `pause()`/`resume()`; with a fast piped heredoc,
  Node emits several `'line'` events before an async handler's first
  `await` has a chance to call `pause()`, so multiple commands ran
  concurrently against one `page`/`browser` and later ones failed with
  "Target page, context or browser has been closed." Fixed by using
  `for await (const line of rl)`, which only pulls the next line once
  the previous command's promise has resolved.
- **The launch/splash overlay contains its own "Household Ledger" text**
  (`#launch-overlay`, `www/index.html:456`) — the *same* text as the
  real header (`<h1>Household Ledger`, ~line 496). `wait-for
  text=Household Ledger` matches the splash overlay's copy almost
  immediately (it's in the DOM before `boot()` even runs), not proof
  the app has finished loading and hidden the overlay. Add a short
  `sleep 500` (or `wait-for` something that only exists in the real UI,
  like a tab id) before your first screenshot/click, or the overlay may
  still be mid-fade and intercept the click.
- **`text=` selectors are ambiguous in this app more than you'd expect** —
  "Ledger" alone matches the splash overlay's brand text, the header
  `<h1>`, *and* the `Ledger` tab button. `click text=Ledger` reliably
  timed out (not a clean "multiple matches" error — it silently
  resolved to the splash overlay's now-non-interactive text and
  retried until timeout). Use the tab bar's real ids instead:
  `#tab-home`, `#tab-ledger`, `#tab-outstanding`, `#tab-payments`.
- **`pdfjsLib is not defined` in the console is expected, not a bug.**
  `www/index.html:438` loads PDF.js from `cdnjs.cloudflare.com` for the
  CC-statement-upload feature; this sandbox's network policy blocks it
  (`net::ERR_TUNNEL_CONNECTION_FAILED`), so `pdfjsLib` never gets
  defined and the inline script that configures its worker throws.
  Everything else in the app is unaffected — only the PDF statement
  upload flow would be broken in this environment. A stray
  `favicon.ico` 404 is also normal (Chromium's own auto-request, not
  the app).
- **No native/Capacitor plugins exist in this browser context**, so
  `boot()`'s biometric-lock, self-update, and Google Sheets sync code
  paths all take their no-op branches immediately (`getNativePlugin(...)`
  returns `null`; `IN_GAS` is `false` because `GAS_URL` is still the
  unfilled `__GAS_URL__` placeholder). This is the right mode for UI
  work; it does **not** exercise sync/update/lock behavior.
