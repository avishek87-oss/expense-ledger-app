# Household Ledger — Android App

Family expense ledger. One APK on every phone; everyone shares the same data,
stored in the household Google Sheet. The app self-updates from GitHub Releases.

## Architecture
- `www/index.html` — the entire app (vanilla JS). Placeholders `__GAS_URL__` /
  `__UPDATE_URL__` are injected at build time from `secrets.json` (not committed).
- **Data**: Google Sheet, via a Google Apps Script JSON API (`Code.gs` in the
  sheet's Apps Script project). Phones GET on open/resume, POST (debounced) on change.
- **Launch**: native splash (`@capacitor/splash-screen`) shows instantly, then an
  in-app animated loading screen with live status (Loading / Checking for updates /
  Syncing) fades into the ledger. See `boot()` in `www/index.html`.
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
