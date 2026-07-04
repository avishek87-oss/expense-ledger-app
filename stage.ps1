# Builds dist/ from www/ with real config values injected.
# www/ stays clean (placeholders only) so it can live in the public repo.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

$secrets = Get-Content "$root\secrets.json" -Raw | ConvertFrom-Json

if (Test-Path "$root\dist") { Remove-Item "$root\dist" -Recurse -Force }
New-Item -ItemType Directory "$root\dist" | Out-Null
Copy-Item "$root\www\*" "$root\dist\" -Recurse

$idx = "$root\dist\index.html"
$html = [IO.File]::ReadAllText($idx)
$html = $html.Replace('__GAS_URL__',    [string]$secrets.gasUrl)
$html = $html.Replace('__UPDATE_URL__', [string]$secrets.updateUrl)
$html = $html.Replace('__API_TOKEN__',  [string]$secrets.apiToken)
[IO.File]::WriteAllText($idx, $html, (New-Object Text.UTF8Encoding $false))

Write-Host "dist/ staged (gasUrl: $(if($secrets.gasUrl){'set'}else{'EMPTY - sync disabled'}), updateUrl: $(if($secrets.updateUrl){'set'}else{'EMPTY - self-update disabled'}))"
