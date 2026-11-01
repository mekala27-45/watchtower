param([int]$Port = 4318)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
  $env:PORT = $Port.ToString()
  $env:HOST = '127.0.0.1'
  $env:WATCHTOWER_DEPLOYMENT = 'local'
  $env:BUILD_REVISION = (git rev-parse HEAD).Trim()
  node apps/api/server.mjs
} finally { Pop-Location }
