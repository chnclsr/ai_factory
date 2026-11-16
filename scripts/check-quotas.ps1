$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'quota_tracker.mjs') @args
exit $LASTEXITCODE

