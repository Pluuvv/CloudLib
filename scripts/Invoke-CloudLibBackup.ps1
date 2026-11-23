param(
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
  [string]$EnvFile
)
$ErrorActionPreference = 'Stop'
try {
  $root = Split-Path $PSScriptRoot -Parent
  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $arguments = @()
  if ($EnvFile) { $arguments += "--env-file=$EnvFile" }
  $arguments += @((Join-Path $root 'reliability/backup.mjs'), 'daily', '--config', $ConfigPath)
  $output = & $NodePath @arguments
  $resultCode = $LASTEXITCODE
  $result = $output | ConvertFrom-Json
  if ($resultCode -eq 0 -and $result.status -ne 'ok') { $resultCode = 1 }
  # Persist only the CLI's sanitized result, never subprocess stderr or environment values.
  $record = @{at=[DateTime]::UtcNow.ToString('o');exitCode=$resultCode;result=$result} | ConvertTo-Json -Depth 8 -Compress
  Add-Content -LiteralPath (Join-Path $config.backupDir 'backup-runs.jsonl') -Value $record
  Write-Output $record
  exit $resultCode
} catch {
  Write-Output '{"formatVersion":1,"status":"error","code":"HOST_ENTRY_FAILED"}'
  exit 1
}
