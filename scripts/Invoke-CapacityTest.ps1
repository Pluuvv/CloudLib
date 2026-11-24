<#
.SYNOPSIS
    Menjalankan Uji Kapasitas & Beban CloudLib (Milestone 9 - Capacity & FinOps)
.DESCRIPTION
    Script wrapper PowerShell untuk mengeksekusi uji beban berbasis skenario multi-tenant CloudLib.
.EXAMPLE
    .\scripts\Invoke-CapacityTest.ps1
    .\scripts\Invoke-CapacityTest.ps1 -TargetUrl "http://localhost:8080" -VUs 50 -Duration 30
#>

param(
    [string]$TargetUrl = "http://localhost:8080",
    [int]$VUs = 25,
    [int]$Duration = 30,
    [string]$Tenant = "upnvj",
    [string]$Token = "",
    [string]$OutFile = "docs/evidence/M9/capacity-metrics.json"
)

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "  CloudLib Milestone 9: Capacity & FinOps Benchmark Runner" -ForegroundColor Yellow
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host " Target URL    : $TargetUrl"
Write-Host " Virtual Users : $VUs"
Write-Host " Duration      : $Duration detik"
Write-Host " Tenant        : $Tenant"
Write-Host " Output File   : $OutFile"
Write-Host "-----------------------------------------------------------------"

$nodeArgs = @(
    "scripts/capacity-test.mjs",
    "--target", $TargetUrl,
    "--vus", $VUs,
    "--duration", $Duration,
    "--tenant", $Tenant,
    "--out", $OutFile
)

if ($Token -ne "") {
    $nodeArgs += @("--token", $Token)
}

node $nodeArgs
