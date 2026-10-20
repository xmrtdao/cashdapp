@echo off
setlocal enabledelayedexpansion
title XMRT Supervisor - single instance (canonical)
cd /d C:\Users\PureTrek\Desktop\xmrtdao

REM Consolidate: if a supervisor is already running, don't start a second.
set SUP_PID=
for /f "usebackq delims=" %%L in ("relay-data\supervisor.pid") do set SUP_PID=%%L

if not "!SUP_PID!"=="" (
    tasklist /FI "PID eq !SUP_PID!" 2>nul | findstr /i "node.exe" >nul
    if not errorlevel 1 goto :alreadyrunning
)
goto :start

:alreadyrunning
echo Supervisor already running (PID !SUP_PID!) - not starting a duplicate.
exit /b 0

:start
REM Canonical root supervisor (has single-instance lock). Foreground serve.
node supervisor.mjs
endlocal
