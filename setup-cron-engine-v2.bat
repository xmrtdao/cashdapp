@echo off
REM ─────────────────────────────────────────────────────────────
REM setup-cron-engine-v2.bat
REM Creates a Windows Scheduled Task to run XMRT DAO cron-engine-v2
REM every 30 seconds (polls jobs). Run as Administrator once.
REM ─────────────────────────────────────────────────────────────

setlocal enabledelayedexpansion

echo ╔══════════════════════════════════════════════════════╗
echo ║   XMRT DAO — Create Cron Engine v2 Scheduled Task  ║
echo ╚══════════════════════════════════════════════════════╝
echo.

set "SCRIPT_DIR=%~dp0"
set "NODE_PATH=C:\Program Files\nodejs\node.exe"
set "SCRIPT_PATH=%SCRIPT_DIR%relay\cron-engine-v2.mjs"
set "TASK_NAME=XMRT-DAO-CronEngine-v2"
set "LOG_DIR=%SCRIPT_DIR%relay\relay-data\cron-logs"

REM Create log directory
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo Task Name:  %TASK_NAME%
echo Script:     %SCRIPT_PATH%
echo Node:       %NODE_PATH%
echo Log Dir:    %LOG_DIR%
echo.

REM Delete existing task if it exists
schtasks /query /tn "%TASK_NAME%" >nul 2>&1
if !errorlevel! equ 0 (
    echo [*] Removing existing task...
    schtasks /delete /tn "%TASK_NAME%" /f
)

REM Create the scheduled task — runs every 5 minutes (fastest schtasks allows)
REM cron-engine-v2.mjs itself polls every 30 seconds internally
echo [*] Creating scheduled task (runs every 5 minutes)...

schtasks /create ^
    /tn "%TASK_NAME%" ^
    /tr "\"%NODE_PATH%\" \"%SCRIPT_PATH%\" --daemon" ^
    /sc minute ^
    /mo 5 ^
    /st 00:00 ^
    /du 23:59 ^
    /f ^
    /it

if !errorlevel! equ 0 (
    echo [OK] Task created successfully!
    echo.
    echo The cron-engine-v2 will run every 5 minutes.
    echo It polls cron.job every 30 seconds internally.
    echo.
    echo Logs will be written to: %LOG_DIR%
    echo.
    echo To start now: schtasks /run /tn "%TASK_NAME%"
    echo To check status: schtasks /query /tn "%TASK_NAME%"
    echo To remove: schtasks /delete /tn "%TASK_NAME%" /f
) else (
    echo [ERROR] Failed to create task. Make sure you ran as Administrator.
)

endlocal
pause
