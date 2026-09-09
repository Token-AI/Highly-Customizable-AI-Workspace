<#
@brief Build, test, or package the Electron application.
@param run_tests Run the build and automated tests; also accepts -Test.
@param create_package Build a Windows package; also accepts -Package.
@returns Throws when the requested npm task fails.
#>
[CmdletBinding()]
param([Alias('Test')][switch]$run_tests, [Alias('Package')][switch]$create_package)

$ErrorActionPreference = 'Stop'
$npm_command = Get-Command npm -ErrorAction Stop
Push-Location -LiteralPath $PSScriptRoot
try {
    if ($run_tests) { & $npm_command.Source test }
    elseif ($create_package) { & $npm_command.Source run package }
    else { & $npm_command.Source run build }
    if ($LASTEXITCODE -ne 0) { throw "Electron build task failed ($LASTEXITCODE)." }
}
finally { Pop-Location }
