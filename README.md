# Household Ledger — Android App

Family expense ledger. One APK on every phone; everyone shares the same data,
stored in the household Google Sheet. The app self-updates from GitHub Releases.

## Architecture
- `www/` — the entire app (vanilla JS, no bundler/build step). Split into a small
  HTML shell plus feature files, loaded via classic `<script src>` tags (not
  `type="module"` -- the HTML has hundreds of inline `onclick="..."` handlers that
  depend on every function being a plain global):
  - `index.html` — markup + a couple of tiny inline scripts (theme pre-paint, crash
    catcher) + the `<link>`/`<script src>` tags loading everything below, in order.
  - `style.css` — all CSS.
  - `app-core.js` — constants, state, calc helpers, fixed-item lifecycle, basic
    ledger CRUD. Also where `APP_VERSION`/`GAS_URL`/`UPDATE_URL`/`WEB_CLIENT_ID`
    live -- placeholders `__GAS_URL__`/`__UPDATE_URL__`/`__WEB_CLIENT_ID__` are
    injected at build time from `secrets.json` (not committed).
  - `auth-sync.js` — Google Sign-In, Google Sheets sync.
  - `cc-payments.js` — outstanding calc, payment picker, CC cycles/statements.
  - `menu-views.js` — hamburger drawer, quick-add, search, budgets/trends menus.
  - `render.js` — all tab rendering (Ledger/Home/Payments/Outstanding).
  - `boot.js` — self-update, launch screen, biometric lock, `boot()`.
- **Data**: Google Sheet, via a Google Apps Script JSON API (`Code.gs` in the
  sheet's Apps Script project). Phones GET on open/resume, POST (debounced) on change.
- **Launch**: native splash (`@capacitor/splash-screen`) shows instantly, then an
  in-app animated loading screen with live status (Loading / Checking for updates /
  Syncing) fades into the ledger. See `boot()` in `www/boot.js`.
- **Self-update — two channels** driven by `version.json` (repo main branch):
  - *Web bundle* (`version`/`url`): hot-swapped via @capgo/capacitor-updater. **No reinstall.**
  - *Native APK* (`apkVersion`/`apkUrl`/`minApk`): the app reads its installed native
    version (`@capacitor/app`); if `installedNative < minApk` it **hard-blocks** with an
    "Update required → Download" screen until the new APK is installed.

## Scripts
| Script | What it does |
|---|---|
| `stage.ps1` | Build `dist/` from `www/` with secrets injected |
| `build-apk.ps1` | Stage → `cap sync` → gradle → `Household-Ledger.apk` |
| `release.ps1 -Version x.y.z` | **Web-only**: zip bundle, publish release, push `version.json` (apk fields carried forward). Seamless, no reinstall. |
| `release.ps1 -Version x.y.z -Native` | **Native**: also bump `build.gradle`, build+attach the APK, and set `apkVersion`/`apkUrl`/`minApk` so phones hard-block until reinstalled. |
| `assets/gen-sources.mjs` | Rasterize brand logo → `assets/*.png`; then `npx @capacitor/assets generate --android`. |

## Releasing an update
- Pure JS/HTML/CSS change → `\.release.ps1 -Version x.y.z` (phones auto-update on next open).
- Anything touching native (new Capacitor plugin, app icon, splash, native config) →
  `\.release.ps1 -Version x.y.z -Native`, then install the new APK once on each phone
  (the gate will prompt each phone to do so).
