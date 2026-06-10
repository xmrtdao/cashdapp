@echo off
REM Cleanup script — run once, as Administrator (right-click -> Run as admin).
REM Self-elevates if not already elevated.
REM
REM Actions:
REM   1. Delete 4 stale Windows tasks superseded by relay/supervisor.mjs + alice.mjs --daemon
REM   2. Install Vex-Supervisor as a logon-trigger task so the watchdog survives reboot/login
REM
REM Safe to re-run. Idempotent.

setlocal
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting admin elevation...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

set REPO=C:\Users\PureTrek\Desktop\DevGruGold
set TASKS=XMRT-DAO-HourlyTaskFetch "XMRT-DAO-HourlyTaskFetch-v2" XMRT-Relay-Watchdog VexSupervisor-Heartbeat

echo === Step 1: deleting 4 stale tasks ===
set OK=0
set SKIP=0
for %%T in (%TASKS%) do (
  schtasks /query /tn "%%T" >nul 2>&1
  if %errorlevel% equ 0 (
    schtasks /delete /tn "%%T" /f
    if %errorlevel% equ 0 (
      echo [OK]   deleted: %%T
      set /a OK+=1
    ) else (
      echo [FAIL] could not delete: %%T
    )
  ) else (
    echo [SKIP] not present: %%T
    set /a SKIP+=1
  )
)
echo.
echo Task cleanup: %OK% deleted, %SKIP% already absent.

echo.
echo === Step 2: installing Vex-Supervisor (logon task) ===
schtasks /query /tn "Vex-Supervisor" >nul 2>&1
if %errorlevel% equ 0 (
  echo [SKIP] Vex-Supervisor already installed
) else (
  if exist "%REPO%\relay-data\supervisor-task.xml" (
    schtasks /create /tn "Vex-Supervisor" /xml "%REPO%\relay-data\supervisor-task.xml" /f
    if %errorlevel% equ 0 (
      echo [OK]   installed Vex-Supervisor
    ) else (
      echo [FAIL] schtasks /create returned %errorlevel%
    )
  ) else (
    echo [WARN] supervisor-task.xml missing; run `node relay\supervisor.mjs --install` first
  )
)

echo.
echo === Remaining XMRT/Vex tasks ===
schtasks /query /fo table 2>&1 | findstr /i "XMRT Vex"

endlocal
