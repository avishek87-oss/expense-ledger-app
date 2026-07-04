# Builds the debug APK: stage → cap sync → gradle assembleDebug.
# Output: ledger-app\Household-Ledger.apk
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

& "$root\stage.ps1"

Set-Location $root
npx cap sync android
if ($LASTEXITCODE -ne 0) { throw "cap sync failed" }

Set-Location "$root\android"
.\gradlew.bat assembleDebug
if ($LASTEXITCODE -ne 0) { throw "gradle build failed" }

Copy-Item "$root\android\app\build\outputs\apk\debug\app-debug.apk" "$root\Household-Ledger.apk" -Force
Write-Host "`nAPK ready: $root\Household-Ledger.apk"
