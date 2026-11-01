param(
  [ValidateRange(1024, 65535)][int]$Port = 4318,
  [ValidateSet('sqlite', 'postgres')][string]$Backend = 'sqlite',
  [switch]$Migrate
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$environmentNames = @('PORT', 'HOST', 'WATCHTOWER_DEPLOYMENT', 'BUILD_REVISION', 'DATABASE_URL', 'WATCHTOWER_MIGRATE')
$savedEnvironment = @{}
foreach ($name in $environmentNames) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
Push-Location -LiteralPath $projectRoot
try {
  if ($Backend -eq 'postgres' -and -not $env:DATABASE_URL) { throw 'Set the approved direct Postgres DATABASE_URL in this process before starting.' }
  if ($Backend -eq 'sqlite' -and $Migrate) { throw 'Migrate applies only to the Postgres backend.' }
  if ($Backend -eq 'sqlite') { Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue }
  $env:PORT = $Port.ToString()
  $env:HOST = '127.0.0.1'
  $env:WATCHTOWER_DEPLOYMENT = if ($Backend -eq 'postgres') { 'production' } else { 'local' }
  $env:WATCHTOWER_MIGRATE = if ($Migrate) { '1' } else { '0' }
  $revision = git rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { throw 'Cannot determine the source revision.' }
  $env:BUILD_REVISION = $revision.Trim()
  Write-Output "Starting $Backend at http://127.0.0.1:$Port. Credentials are not printed."
  node apps/api/server.mjs
  if ($LASTEXITCODE -ne 0) { throw "API process exited with code $LASTEXITCODE." }
} finally {
  Pop-Location
  foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
}
