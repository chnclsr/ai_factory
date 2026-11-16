# Live quota status for the providers that report one (Muse, Codex, Antigravity).
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot '..\quota_tracker.mjs') @args
exit $LASTEXITCODE
