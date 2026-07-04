# Publishes an app update that installed phones pick up automatically.
# Usage: .\release.ps1 -Version 1.1.0
# Steps: bump APP_VERSION in www/index.html → stage dist → zip → GitHub
# release with bundle.zip → bump version.json → commit & push.
param([Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must be like 1.2.3" }

# 1. Bump APP_VERSION in the source
$idx  = "$root\www\index.html"
$html = [IO.File]::ReadAllText($idx)
$html = $html -replace "const APP_VERSION = '[^']+';", "const APP_VERSION = '$Version';"
[IO.File]::WriteAllText($idx, $html, (New-Object Text.UTF8Encoding $false))

# 2. Stage with real config values
& "$root\stage.ps1"

# 3. Zip the bundle
$zip = "$root\bundle.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$root\dist\*" -DestinationPath $zip

# 4. Publish GitHub release with the bundle
Set-Location $root
gh release create "v$Version" $zip --title "v$Version" --notes "Household Ledger v$Version"
if ($LASTEXITCODE -ne 0) { throw "gh release failed" }

# 5. Bump version.json and push (phones check this file)
$repo = gh repo view --json nameWithOwner -q .nameWithOwner
$vjson = @{ version = $Version; url = "https://github.com/$repo/releases/download/v$Version/bundle.zip" } | ConvertTo-Json
[IO.File]::WriteAllText("$root\version.json", $vjson, (New-Object Text.UTF8Encoding $false))

git add www/index.html version.json
git commit -m "Release v$Version"
git push
Write-Host "`nReleased v$Version - installed apps will update on next open."
