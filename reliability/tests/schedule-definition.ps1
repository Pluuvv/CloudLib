param([Parameter(Mandatory=$true)][string]$ConfigPath,[string]$EnvFile)
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$installer = Join-Path $root 'scripts/Install-CloudLibBackupTask.ps1'
$xmlPath = Join-Path (Split-Path $ConfigPath) 'task-definition.xml'
& $installer -ConfigPath $ConfigPath -XmlPath $xmlPath -EnvFile $EnvFile -DefinitionOnly
[xml]$xml = Get-Content -LiteralPath $xmlPath
$ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
$ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
function Check([string]$xpath,[string]$expected) {
  $node = $xml.SelectSingleNode($xpath,$ns)
  if (!$node -or $node.InnerText -ne $expected) { throw "Unexpected task setting: $xpath" }
}
Check '//t:CalendarTrigger/t:StartBoundary' '2026-01-01T13:00:00Z'
Check '//t:ScheduleByDay/t:DaysInterval' '1'
Check '//t:StartWhenAvailable' 'true'
Check '//t:MultipleInstancesPolicy' 'IgnoreNew'
Check '//t:LogonType' 'InteractiveToken'
Check '//t:RunLevel' 'LeastPrivilege'
Check '//t:DisallowStartIfOnBatteries' 'false'
'PASS native task XML timezone, catchup, identity and concurrency settings'
