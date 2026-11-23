param([Parameter(Mandatory=$true)][string]$ResultPath,[string]$GrafanaOrigin='http://localhost:3000')
$ErrorActionPreference='Stop'
try {
 if ($GrafanaOrigin -ne 'http://localhost:3000') { throw 'UNSAFE_ORIGIN' }
 if (!$env:CLOUDLIB_GRAFANA_USER -or !$env:CLOUDLIB_GRAFANA_PASSWORD) { throw 'MISSING_CREDENTIAL' }
 $pair = $env:CLOUDLIB_GRAFANA_USER + ':' + $env:CLOUDLIB_GRAFANA_PASSWORD
 $headers = @{Authorization='Basic '+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))}
 $dashboard = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../reliability/grafana/recovery-test.json') -Raw | ConvertFrom-Json
 $result = Get-Content -LiteralPath $ResultPath -Raw | ConvertFrom-Json
 if ($result.formatVersion -ne 1 -or $result.status -notin @('GAGAL','LULUS') -or !$result.testRunId -or !$result.injectedAt) { throw 'NO_INJECTED_RESULT' }
 $overwrite=$false
 try {
  $existing=Invoke-RestMethod -Uri ($GrafanaOrigin+'/api/dashboards/uid/m7-recovery-test') -Headers $headers
  if ($existing.dashboard.title -ne 'M7 - Recovery Test' -or 'cloudlib-task06' -notin $existing.dashboard.tags) { throw 'DASHBOARD_COLLISION' }
  $dashboard | Add-Member -NotePropertyName id -NotePropertyValue $existing.dashboard.id -Force
  $dashboard.version=$existing.dashboard.version
  $overwrite=$true
 } catch {
  if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
 }
 $body=@{dashboard=$dashboard;overwrite=$overwrite;message='M7 source-backed drill dashboard'}|ConvertTo-Json -Depth 30 -Compress
 $import=Invoke-RestMethod -Uri ($GrafanaOrigin+'/api/dashboards/db') -Method Post -Headers $headers -ContentType application/json -Body $body
 if ($import.status -ne 'success') { throw 'IMPORT_FAILED' }
 foreach($event in @('injectedAt','completedAt')) {
  $time=[DateTimeOffset]::Parse($result.$event).ToUnixTimeMilliseconds()
  $text='runId='+$result.testRunId+'; incidentId='+$result.workerIncidentId+'; target='+$result.target+'; method='+$result.method+'; environment='+$result.environment+'; status='+$result.status+'; event='+$event
  $annotation=@{dashboardUID='m7-recovery-test';time=$time;tags=@('m7-recovery-drill',$result.environment);text=$text}|ConvertTo-Json -Compress
  $null=Invoke-RestMethod -Uri ($GrafanaOrigin+'/api/annotations') -Method Post -Headers $headers -ContentType application/json -Body $annotation
 }
 Write-Output '{"formatVersion":1,"status":"ok","dashboardUid":"m7-recovery-test"}'
} catch { Write-Output '{"formatVersion":1,"status":"error","code":"GRAFANA_PUBLICATION_FAILED"}';exit 1 }
