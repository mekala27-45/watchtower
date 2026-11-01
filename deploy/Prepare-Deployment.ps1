param([string]$PublicApiOrigin = '')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
  $nodeVersion = node --version
  if ($LASTEXITCODE -ne 0 -or $nodeVersion.Trim() -ne 'v24.19.0') { throw 'Use the pinned Node 24.19.0 runtime.' }
  foreach ($relative in @('package-lock.json', 'packages/workflow/postgres.mjs', 'db/migrations/001_watchtower.sql', 'db/migrations/002_runtime_adapter.sql', 'Dockerfile.vercel')) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $relative))) { throw "Required deployment input missing: $relative" }
  }
  $image = Get-Content -LiteralPath 'reports/probes/container-image.json' -Raw | ConvertFrom-Json
  if ($image.status -ne 200 -or $image.digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'A verified immutable container image is required.' }
  $dockerfile = Get-Content -LiteralPath 'Dockerfile.vercel' -Raw
  if (-not $dockerfile.Contains("FROM $($image.image)@$($image.digest)")) { throw 'Dockerfile does not match the verified image manifest.' }
  node --input-type=module -e "import pg from 'pg'; import {postgresConfig} from './packages/workflow/postgres.mjs'; if(typeof pg.Pool!=='function'||typeof postgresConfig!=='function')process.exit(1)"
  if ($LASTEXITCODE -ne 0) { throw 'Install the pinned dependencies before deployment preparation.' }
  node scripts/verify-report-evidence.mjs --archived
  if ($LASTEXITCODE -ne 0) { throw 'Archived actual-model evidence is not ready for publication.' }
  if ($PublicApiOrigin) {
    $apiUri = [uri]$PublicApiOrigin
    if ($apiUri.Scheme -ne 'https' -or $apiUri.UserInfo -or $apiUri.Query -or $apiUri.Fragment -or $apiUri.AbsolutePath -ne '/') { throw 'PublicApiOrigin must be a plain HTTPS origin.' }
  }
  $revision = git rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { throw 'Cannot determine the source revision.' }
  [pscustomobject]@{
    stage = 'deployment_inputs_prepared'
    source_revision = $revision.Trim()
    image = "$($image.image)@$($image.digest)"
    node = $nodeVersion.Trim()
    backend = 'direct_tls_postgres'
    public_api_origin = $PublicApiOrigin
    credentials_transferred = $false
    deployment_executed = $false
    public_readiness_verified = $false
  }
} finally { Pop-Location }
