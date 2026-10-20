@echo off
REM cron-runner.bat — Windows-compatible cron job runner
REM Runs active cron scripts at their scheduled intervals
REM Usage: start cron-runner.bat (runs in background loop)

cd /d C:\Users\PureTrek\Desktop\xmrtdao

:loop
  REM Every 5 minutes: fleet-chat-heartbeat
  echo [%date% %time%] Running fleet-chat-heartbeat...
  node relay/scripts/fleet-chat-heartbeat.mjs > nul 2>&1
  
  REM Every 10 minutes: health-check
  echo [%date% %time%] Running health-check...
  node relay/scripts/health-check.mjs > nul 2>&1
  
  REM Every 15 minutes: trustgraph-scanner + task-announcer
  echo [%date% %time%] Running trustgraph-scanner...
  node relay/trustgraph-scanner.mjs > nul 2>&1
  echo [%date% %time%] Running task-announcer...
  node relay/task-announcer.mjs > nul 2>&1
  
  REM Wait 5 minutes (300 seconds)
  timeout /t 300 /nobreak > nul
goto loop
