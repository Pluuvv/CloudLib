param(
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [Parameter(Mandatory=$true)][string]$XmlPath,
  [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
  [string]$EnvFile,
  [string]$TaskName = 'CloudLib-DailyLocalBackup',
  [switch]$DefinitionOnly
)
$ErrorActionPreference = 'Stop'
if ($TaskName -notmatch '^CloudLib-[a-zA-Z0-9-]+$') { throw 'Task name must use the CloudLib- prefix' }
$ConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$entry = Join-Path $PSScriptRoot 'Invoke-CloudLibBackup.ps1'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$escape = { param($value) [System.Security.SecurityElement]::Escape($value) }
foreach ($path in @($ConfigPath,$NodePath,$entry,$EnvFile)) {
  if ($path -and ($path.Contains('"') -or $path.Contains("`r") -or $path.Contains("`n"))) { throw 'Unsupported path characters' }
}
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$entry`" -ConfigPath `"$ConfigPath`" -NodePath `"$NodePath`""
if ($EnvFile) {
  $EnvFile = (Resolve-Path -LiteralPath $EnvFile).Path
  $arguments += " -EnvFile `"$EnvFile`""
}
$command = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>CloudLib verified local backup ticket05</Description><Source>CloudLib.Backup.Task05</Source></RegistrationInfo>
  <Triggers><CalendarTrigger><StartBoundary>2026-01-01T13:00:00Z</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>
  <Principals><Principal id="Operator"><UserId>$user</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><Enabled>true</Enabled><Hidden>false</Hidden><WakeToRun>true</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
  <Actions Context="Operator"><Exec><Command>$(& $escape $command)</Command><Arguments>$(& $escape $arguments)</Arguments><WorkingDirectory>$(& $escape (Split-Path $PSScriptRoot -Parent))</WorkingDirectory></Exec></Actions>
</Task>
"@
Set-Content -LiteralPath $XmlPath -Value $xml -Encoding Unicode
if (!$DefinitionOnly) {
  $service = New-Object -ComObject Schedule.Service
  $service.Connect()
  $folder = $service.GetFolder('\')
  $existing = @($folder.GetTasks(1) | Where-Object Name -eq $TaskName)
  if ($existing.Count) { throw 'Task already exists; inspect and explicitly unregister the owned task before reinstalling' }
  $registered = $folder.RegisterTask($TaskName,$xml,2,$user,$null,3,$null)
  [PSCustomObject]@{TaskName=$registered.Name;State=$registered.State;Installed=$true;Definition=$XmlPath}
}
