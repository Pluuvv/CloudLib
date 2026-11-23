param(
 [Parameter(Mandatory=$true)][string]$ConfigPath,
 [switch]$DryRun,
 [string]$NodePath,
 [string]$EnvFile
)
$ErrorActionPreference = 'Stop'
try {
 if (!$NodePath) { $NodePath=(Get-Command node.exe -ErrorAction Stop).Source }
 if ($EnvFile -and !(Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw 'MISSING_ENV_FILE' }
 $arguments = @()
 if ($EnvFile) { $arguments += "--env-file=$EnvFile" }
 $arguments += @((Join-Path (Split-Path $PSScriptRoot -Parent) 'reliability/recovery-test.mjs'), '--config', $ConfigPath)
 if ($DryRun) { $arguments += '--dry-run' }
 $output = & $NodePath @arguments 2>$null
 $code = $LASTEXITCODE
 $result = $output | ConvertFrom-Json
 if ($result.formatVersion -ne 1 -or $result.status -notin @('LULUS','GAGAL','PREFLIGHT_OK')) { throw 'INVALID_RESULT' }
 if ($result.status -eq 'GAGAL' -and $code -eq 0) { $code=1 }
 Write-Output ($result | ConvertTo-Json -Depth 30 -Compress)
 exit $code
} catch {
 Write-Output '{"formatVersion":1,"status":"GAGAL","code":"HOST_ENTRY_FAILED"}'
 exit 1
}
