# Household Ledger — Android App

Family expense ledger. One APK on every phone; everyone shares the same data,
stored in the household Google Sheet. The app self-updates from GitHub Releases.

## Architecture
- `www/index.html` — the entire app (vanilla JS). Placeholders `__GAS_URL__` /
  `__UPDATE_URL__` are injected at build time from `secrets.json` (not committed).
- **Data**: Google Sheet, via a Google Apps Script JSON API (`Code.gs` in the
  sheet's Apps Script project). Phones GET on open/resume, POST (debounced) on change.
- **Self-update**: on launch the app compares `version.json` (this repo, main branch)
  against its own version; if newer, downloads `bundle.zip` from the matching GitHub
  Release and hot-swaps via @capgo/capacitor-updater. No reinstall needed.

## Scripts
| Script | What it does |
|---|---|
| `stage.ps1` | Build `dist/` from `www/` with secrets injected |
| `build-apk.ps1` | Stage → `cap sync` → gradle → `Household-Ledger.apk` |
| `release.ps1 -Version 1.2.0` | Bump version, zip bundle, publish GitHub release, push `version.json` |

## Releasing an update
```powershell
.\release.ps1 -Version 1.2.0
```
Phones pick it up on next app open. Only native-shell changes (new Capacitor
plugins, icon, app name) require rebuilding and reinstalling the APK.
