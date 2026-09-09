<#
@brief Install locked project dependencies and keep download caches inside the project.
@returns Throws when dependency installation fails.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$project_root = Split-Path -Parent $PSScriptRoot
$npm_command = Get-Command npm -ErrorAction Stop
$npm_cache_path = Join-Path $project_root 'build\npm-cache'
$electron_cache_path = Join-Path $project_root 'build\electron-cache'
$saved_electron_cache = $env:electron_config_cache
$saved_upper_electron_cache = $env:ELECTRON_CACHE
Push-Location -LiteralPath $project_root
try {
    $env:electron_config_cache = $electron_cache_path
    $env:ELECTRON_CACHE = $electron_cache_path
    if (Test-Path -LiteralPath (Join-Path $project_root 'package-lock.json')) {
        & $npm_command.Source ci --cache $npm_cache_path --no-audit --no-fund
    }
    else { & $npm_command.Source install --cache $npm_cache_path --no-audit --no-fund }
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed ($LASTEXITCODE)." }
}
finally {
    $env:electron_config_cache = $saved_electron_cache
    $env:ELECTRON_CACHE = $saved_upper_electron_cache
    Pop-Location
}
