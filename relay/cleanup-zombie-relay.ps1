#!/usr/bin/env node
/**
 * cleanup-zombie-relay.ps1 — Remove leftover node relay (PID 5852)
 * and delete the locked v1 scheduled task.
 *
 * REQUIRES: Run as Administrator (right-click PowerShell -> "Run as administrator")
 *
 * Without admin, you cannot:
 *   - Kill PID 5852 (owned by SYSTEM)
 *   - Delete the v1 task (locked security descriptor)
 *   - Take ownership of the task
 *
 * Symptoms this fixes:
 *   - Brief cmd.exe console flash from SYSTEM-owned zombie node.exe
 *   - v1 XMRT-DAO-HourlyTaskFetch may re-fire unexpectedly
 *
 * What it does (in order):
 *   1. Take ownership of the v1 scheduled task file
 *   2. Grant Administrators full control
 *   3. Delete the task via schtasks
 *   4. Kill PID 5852 (the zombie node relay)
 *   5. Verify cleanup
 *
 * USAGE: Run as Administrator, then:
 *   powershell -ExecutionPolicy Bypass -File cleanup-zombie-relay.ps1
 */

$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '=== XMRT Relay Cleanup (requires Administrator) ===' -ForegroundColor Cyan
Write-Host ''

# Check if running as admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host 'ERROR: This script must be run as Administrator.' -ForegroundColor Red
  Write-Host 'Right-click PowerShell and select "Run as administrator", then try again.' -ForegroundColor Yellow
  exit 1
}

Write-Host '[1/4] Taking ownership of v1 task file...' -ForegroundColor Yellow
$taskFile = 'C:\Windows\System32\Tasks\XMRT-DAO-HourlyTaskFetch'
if (Test-Path $taskFile) {
  & takeown.exe "/F" $taskFile "/A" 2>&1 | Out-Null
  & icacls.exe $taskFile "/grant" "Administrators:F" "/C" 2>&1 | Out-Null
  Write-Host "  OK: Ownership transferred to Administrators" -ForegroundColor Green
} else {
  Write-Host "  Task file not found (may already be deleted): $taskFile" -ForegroundColor Gray
}

Write-Host ''
Write-Host '[2/4] Deleting v1 scheduled task...' -ForegroundColor Yellow
$result = & schtasks.exe "/Delete" "/TN" "XMRT-DAO-HourlyTaskFetch" "/F" 2>&1
if ($LASTEXITCODE -eq 0) {
  Write-Host '  OK: Task deleted' -ForegroundColor Green
} else {
  Write-Host "  WARNING: $result" -ForegroundColor Yellow
}

Write-Host ''
Write-Host '[3/4] Killing zombie node.exe (PID 5852)...' -ForegroundColor Yellow
$proc = Get-Process -Id 5852 -ErrorAction SilentlyContinue
if ($proc) {
  try {
    Stop-Process -Id 5852 -Force
    Write-Host '  OK: PID 5852 terminated' -ForegroundColor Green
  } catch {
    Write-Host "  WARNING: $($_.Exception.Message)" -ForegroundColor Yellow
  }
} else {
  Write-Host '  PID 5852 not found (may already be gone or rebooted)' -ForegroundColor Gray
}

Write-Host ''
Write-Host '[4/4] Verifying cleanup...' -ForegroundColor Yellow
$zombie = Get-Process -Id 5852 -ErrorAction SilentlyContinue
$v1Task = Get-ScheduledTask -TaskName 'XMRT-DAO-HourlyTaskFetch' -ErrorAction SilentlyContinue

if (-not $zombie) {
  Write-Host '  [OK] No zombie relay process' -ForegroundColor Green
} else {
  Write-Host '  [STILL ALIVE] Zombie relay still running' -ForegroundColor Red
}

if (-not $v1Task) {
  Write-Host '  [OK] v1 task deleted' -ForegroundColor Green
} else {
  Write-Host '  [STILL EXISTS] v1 task still in scheduler' -ForegroundColor Red
}

Write-Host ''
Write-Host '=== Cleanup complete ===' -ForegroundColor Cyan
Write-Host 'Recommended: Restart the relay to ensure only one instance is running:'
Write-Host '  taskkill /F /IM node.exe'
Write-Host '  cd C:\Users\PureTrek\Desktop\DevGruGold'
Write-Host '  nohup node relay/server.js > relay/relay-output.log 2>&1 &'
Write-Host ''
