param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$original = Get-Content -LiteralPath $ConfigPath -Raw
$config = $original | ConvertFrom-Json
if ($config.logicalSource -ne 'synthetic-business-fixture' -or $config.source.port -ne 19439) { throw 'Native scheduler test accepts only its owned fixture' }
$name = 'CloudLib-Fixture-' + [guid]::NewGuid().ToString('N')
$xmlPath = Join-Path (Split-Path $ConfigPath) 'native-task.xml'
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$folder = $service.GetFolder('\')
$installed = $false
function Run-And-Check([int]$expected) {
  $task = $folder.GetTask($name)
  $before = $task.LastRunTime
  $null = $task.Run($null)
  $deadline = [DateTime]::UtcNow.AddSeconds(25)
  do {
    Start-Sleep -Milliseconds 200
    $task = $folder.GetTask($name)
    if ($task.LastRunTime -gt $before -and $task.State -ne 4 -and $task.State -ne 2) { break }
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($task.LastRunTime -le $before -or $task.State -eq 4 -or $task.LastTaskResult -ne $expected) { throw "Scheduler did not complete with expected result $expected; state=$($task.State), result=$($task.LastTaskResult)" }
  [PSCustomObject]@{Task=$name;LastRun=$task.LastRunTime.ToUniversalTime().ToString('o');LastResult=$task.LastTaskResult;State=$task.State} | ConvertTo-Json -Compress
}
try {
  & (Join-Path $root 'scripts/Install-CloudLibBackupTask.ps1') -ConfigPath $ConfigPath -XmlPath $xmlPath -TaskName $name | Out-Null
  $installed = $true
  $refused = $false
  try { & (Join-Path $root 'scripts/Install-CloudLibBackupTask.ps1') -ConfigPath $ConfigPath -XmlPath $xmlPath -TaskName $name | Out-Null }
  catch { $refused = $_.Exception.Message -like '*Task already exists*' }
  if (!$refused) { throw 'Installer must refuse to overwrite an existing task' }
  Run-And-Check 0
  $status = Get-Content -LiteralPath (Join-Path $config.backupDir 'backup-status.json') -Raw | ConvertFrom-Json
  if ($status.lastAttempt.status -ne 'ok' -or !$status.rpoMet) { throw 'Scheduler launch did not produce a verified fresh backup' }
  $config.source.port = 1
  $config | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $ConfigPath
  Run-And-Check 1
  $status = Get-Content -LiteralPath (Join-Path $config.backupDir 'backup-status.json') -Raw | ConvertFrom-Json
  if ($status.lastAttempt.status -ne 'error' -or !$status.lastValid.backupId) { throw 'Scheduler failure was not durable or lost the prior backup' }
  'PASS scheduler success=0 failure=1 with durable verified snapshot and failure state'
} finally {
  Set-Content -LiteralPath $ConfigPath -Value $original
  if ($installed) { $folder.DeleteTask($name,0) }
}
