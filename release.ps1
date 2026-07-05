# Publishes an app update that installed phones pick up automatically.
# Usage: .\release.ps1 -Version 1.1.0
# Steps: bump APP_VERSION in www/index.html → stage dist → zip → GitHub
# release with bundle.zip → bump version.json → commit & push.
param([Parameter(Mandatory=$true)][string]$Version)
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

Invoke-Git add www/index.html version.json
Invoke-Git commit -m "Release v$Version"
Invoke-Git push
Write-Host "`nReleased v$Version - installed apps will update on next open."
