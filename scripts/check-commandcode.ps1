$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'scripts\check-commandcode-usage.mjs') @args
exit $LASTEXITCODE
