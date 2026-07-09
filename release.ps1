# Publishes an app update that installed phones pick up automatically.
#
#   Web-only (seamless, no reinstall):   .\release.ps1 -Version 1.2.0
#   Native   (requires APK reinstall):   .\release.ps1 -Version 1.2.0 -Native
#
# Web-only: bump APP_VERSION -> stage -> zip -> GitHub release with bundle.zip
#           -> version.json (apk fields carried forward) -> commit & push.
# Native  : also bump android versionName/versionCode, build the APK, attach it
#           to the release, and set apkVersion/apkUrl + minApk to this version so
#           installed apps hard-block until the new APK is installed.
param(
  [Parameter(Mandatory=$true)][string]$Version,
  [switch]$Native
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must be like 1.2.3" }

# Run git without letting its harmless stderr warnings (e.g. LF/CRLF) abort the
# script under ErrorActionPreference=Stop. Only a non-zero exit code is a failure.
function Invoke-Git {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & git -c user.name='Avishek' -c user.email='avishek87@gmail.com' @args 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -ne 0) { throw "git $($args -join ' ') failed (exit $code)" }
}

$repo = gh repo view --json nameWithOwner -q .nameWithOwner
$apkAsset = $null

# Carry forward the existing native fields; a -Native release overwrites them.
$apkVersion = $Version
$apkUrl     = ""
$minApk     = "1.1.0"
if (Test-Path "$root\version.json") {
  try {
    $prev = Get-Content "$root\version.json" -Raw | ConvertFrom-Json
    if ($prev.apkVersion) { $apkVersion = $prev.apkVersion }
    if ($prev.apkUrl)     { $apkUrl     = $prev.apkUrl }
    if ($prev.minApk)     { $minApk     = $prev.minApk }
  } catch {}
}

# 1. Bump APP_VERSION in the web source (lives in app-core.js since the file split)
$idx  = "$root\www\app-core.js"
$html = [IO.File]::ReadAllText($idx)
$html = $html -replace "const APP_VERSION = '[^']+';", "const APP_VERSION = '$Version';"
[IO.File]::WriteAllText($idx, $html, (New-Object Text.UTF8Encoding $false))

if ($Native) {
  # Bump android versionName to match + increment versionCode.
  $gradle = "$root\android\app\build.gradle"
  $g = [IO.File]::ReadAllText($gradle)
  $curCode = [int]([regex]::Match($g, 'versionCode\s+(\d+)').Groups[1].Value)
  $g = $g -replace 'versionCode\s+\d+',      "versionCode $($curCode + 1)"
  $g = $g -replace 'versionName\s+"[^"]*"',  "versionName `"$Version`""
  [IO.File]::WriteAllText($gradle, $g, (New-Object Text.UTF8Encoding $false))

  # Build the APK (build-apk.ps1 stages + syncs + gradle assembleDebug).
  & "$root\build-apk.ps1"
  $apkAsset = "$root\Household-Ledger.apk"

  # This build becomes the new native floor.
  $apkVersion = $Version
  $apkUrl     = "https://github.com/$repo/releases/download/v$Version/Household-Ledger.apk"
  $minApk     = $Version
} else {
  # Web-only: just stage + zip (no gradle).
  & "$root\stage.ps1"
}

# 2. Zip the web bundle
$zip = "$root\bundle.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$root\dist\*" -DestinationPath $zip

# 3. Publish the GitHub release (bundle always; APK when native)
Set-Location $root
$assets = @($zip)
if ($apkAsset) { $assets += $apkAsset }
gh release create "v$Version" @assets --title "v$Version" --notes "Household Ledger v$Version"
if ($LASTEXITCODE -ne 0) { throw "gh release failed" }

# 4. Write version.json (phones check this) and push
$vjson = [ordered]@{
  version    = $Version
  url        = "https://github.com/$repo/releases/download/v$Version/bundle.zip"
  apkVersion = $apkVersion
  apkUrl     = $apkUrl
  minApk     = $minApk
} | ConvertTo-Json
[IO.File]::WriteAllText("$root\version.json", $vjson, (New-Object Text.UTF8Encoding $false))

Invoke-Git add www version.json
if ($Native) { Invoke-Git add android/app/build.gradle android/app/src/main/res }
Invoke-Git commit -m "Release v$Version"
Invoke-Git push
Write-Host "`nReleased v$Version$(if($Native){' (native — reinstall required)'}) - installed apps update on next open."
