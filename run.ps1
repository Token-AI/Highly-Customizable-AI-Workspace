<#
@brief Start the Electron application or its offline preview.
@param preview Use the isolated offline demonstration mode.
@returns Throws if Electron exits unsuccessfully.
#>
[CmdletBinding()]
param([switch]$preview)

$ErrorActionPreference = 'Stop'
$npm_command = Get-Command npm -ErrorAction Stop
Push-Location -LiteralPath $PSScriptRoot
try {
    if ($preview) { & $npm_command.Source run preview }
    else { & $npm_command.Source start }
    if ($LASTEXITCODE -ne 0) { throw "Electron exited with code $LASTEXITCODE." }
}
finally { Pop-Location }
