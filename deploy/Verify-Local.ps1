param(
  [string]$BaseUrl = 'http://127.0.0.1:4318',
  [ValidateSet('sqlite', 'postgres')][string]$Backend = 'sqlite'
)
$ErrorActionPreference = 'Stop'
$uri = [uri]$BaseUrl
if ($uri.Host -notin @('127.0.0.1', 'localhost') -or $uri.Scheme -ne 'http' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') {
  throw 'This script checks only an HTTP loopback origin.'
}
$BaseUrl = $uri.GetLeftPart([System.UriPartial]::Authority)
$health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 20
$expectedBackend = if ($Backend -eq 'postgres') { 'postgres' } else { 'sqlite_local_candidate' }
if (-not $health.ready -or $health.database.backend -ne $expectedBackend -or [bool]$health.productionReady -ne ($Backend -eq 'postgres')) {
  throw 'Unexpected backend readiness contract.'
}
$session = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/demo/sessions" -ContentType 'application/json' -Body '{}' -TimeoutSec 20
$headers = @{ Authorization = "Bearer $($session.capability)" }
$sessionUrl = "$BaseUrl/api/demo/sessions/$($session.id)"
$briefing = Invoke-RestMethod -Method Post -Uri "$sessionUrl/prepare" -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 20
$approvalBody = @{digest = $briefing.digest} | ConvertTo-Json
$null = Invoke-RestMethod -Method Post -Uri "$sessionUrl/approve" -Headers $headers -ContentType 'application/json' -Body $approvalBody -TimeoutSec 20
$publicationBody = @{digest = $briefing.digest; operationKey = 'loopback-verification'} | ConvertTo-Json
$first = Invoke-RestMethod -Method Post -Uri "$sessionUrl/publish" -Headers $headers -ContentType 'application/json' -Body $publicationBody -TimeoutSec 20
$retry = Invoke-RestMethod -Method Post -Uri "$sessionUrl/publish" -Headers $headers -ContentType 'application/json' -Body $publicationBody -TimeoutSec 20
if ($first.receiptId -ne $retry.receiptId -or -not $retry.recovered) { throw 'Receipt recovery failed.' }
[pscustomobject]@{
  mode = 'loopback_api_verification'
  backend = $health.database.backend
  revision = $health.revision
  receipt = $retry.receiptId
  recovered = $retry.recovered
  public_deployment_verified = $false
  workflow_dispatch_verified = $false
}
