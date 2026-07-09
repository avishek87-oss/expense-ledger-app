# Builds dist/ from www/ with real config values injected.
# www/ stays clean (placeholders only) so it can live in the public repo.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

$secrets = Get-Content "$root\secrets.json" -Raw | ConvertFrom-Json

if (Test-Path "$root\dist") { Remove-Item "$root\dist" -Recurse -Force }
New-Item -ItemType Directory "$root\dist" | Out-Null
Copy-Item "$root\www\*" "$root\dist\" -Recurse

# Substitute placeholders in every JS/HTML file under dist/ (not just index.html) --
# app-core.js is where these three consts actually live post file-split, but looping
# over all files means this never silently breaks again if they move file again.
$targets = Get-ChildItem "$root\dist" -Recurse -Include *.html, *.js
foreach ($file in $targets) {
  $html = [IO.File]::ReadAllText($file.FullName)
  $replaced = $html.Replace('__GAS_URL__',       [string]$secrets.gasUrl)
  $replaced = $replaced.Replace('__UPDATE_URL__',    [string]$secrets.updateUrl)
  $replaced = $replaced.Replace('__WEB_CLIENT_ID__', [string]$secrets.webClientId)
  if ($replaced -ne $html) {
    [IO.File]::WriteAllText($file.FullName, $replaced, (New-Object Text.UTF8Encoding $false))
  }
}

# Hard-fail if any placeholder survived substitution -- previously this failed silently,
# shipping a build with literal __GAS_URL__ etc. baked in with no build-time error.
$leftover = Get-ChildItem "$root\dist" -Recurse -Include *.html, *.js |
  Select-String -Pattern '__GAS_URL__|__UPDATE_URL__|__WEB_CLIENT_ID__'
if ($leftover) {
  $leftover | ForEach-Object { Write-Host "LEFTOVER PLACEHOLDER: $($_.Path):$($_.LineNumber)" }
  throw "Placeholder substitution incomplete -- see LEFTOVER PLACEHOLDER lines above."
}

Write-Host "dist/ staged (gasUrl: $(if($secrets.gasUrl){'set'}else{'EMPTY - sync disabled'}), updateUrl: $(if($secrets.updateUrl){'set'}else{'EMPTY - self-update disabled'}))"
