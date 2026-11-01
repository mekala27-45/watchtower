$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$probe = Get-Content -LiteralPath (Join-Path $projectRoot 'docs/sources/host-probes.json') -Raw | ConvertFrom-Json
if ($probe.vercel.hobby_eligibility -ne 'verified' -or $probe.vercel.container_probe -ne 'passed') {
  throw 'Vercel free container eligibility and actual route probe remain incomplete.'
}
if ($probe.neon.direct_tls -ne 'passed') { throw 'Direct Neon TLS probe remains incomplete.' }
$lock = Get-Content -LiteralPath (Join-Path $projectRoot 'docs/sources/dependency-lock.json') -Raw | ConvertFrom-Json
if ($lock.container_digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'An immutable verified Node image digest is required.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'packages/workflow/postgres.mjs'))) {
  throw 'Implement and independently test the Postgres runtime adapter before deployment.'
}
Write-Output 'Preflight passed. Verify the exact target and source revision before authorized deployment.'
