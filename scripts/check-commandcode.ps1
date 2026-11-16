# Command Code usage and quota report.
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'check-commandcode-usage.mjs') @args
exit $LASTEXITCODE
