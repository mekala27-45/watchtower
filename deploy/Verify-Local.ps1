param([string]$BaseUrl = 'http://127.0.0.1:4318')
$ErrorActionPreference = 'Stop'
$uri = [uri]$BaseUrl
if ($uri.Host -notin @('127.0.0.1','localhost') -or $uri.Scheme -ne 'http') { throw 'This script checks only the local candidate.' }
$health = Invoke-RestMethod -Uri "$BaseUrl/health"
if (-not $health.ready -or $health.productionReady) { throw 'Unexpected local readiness contract.' }
$session = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/demo/sessions" -ContentType 'application/json' -Body '{}'
$headers = @{ Authorization = "Bearer $($session.capability)" }
$sessionUrl = "$BaseUrl/api/demo/sessions/$($session.id)"
$briefing = Invoke-RestMethod -Method Post -Uri "$sessionUrl/prepare" -Headers $headers -ContentType 'application/json' -Body '{}'
$approvalBody = @{digest=$briefing.digest} | ConvertTo-Json
$null = Invoke-RestMethod -Method Post -Uri "$sessionUrl/approve" -Headers $headers -ContentType 'application/json' -Body $approvalBody
$publicationBody = @{digest=$briefing.digest;operationKey='local-verification'} | ConvertTo-Json
$first = Invoke-RestMethod -Method Post -Uri "$sessionUrl/publish" -Headers $headers -ContentType 'application/json' -Body $publicationBody
$retry = Invoke-RestMethod -Method Post -Uri "$sessionUrl/publish" -Headers $headers -ContentType 'application/json' -Body $publicationBody
if ($first.receiptId -ne $retry.receiptId -or -not $retry.recovered) { throw 'Receipt recovery failed.' }
[pscustomobject]@{mode='local_candidate';revision=$health.revision;receipt=$retry.receiptId;recovered=$retry.recovered}
