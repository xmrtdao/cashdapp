@echo off
REM Fix Vex-Supervisor to point at xmrtdao instead of DevGruGold
schtasks /Delete /TN "Vex-Supervisor" /F 2>nul
schtasks /Create /SC ONLOGON /TN "Vex-Supervisor" /TR "cmd.exe /c start /B node C:\Users\PureTrek\Desktop\xmrtdao\supervisor.mjs --once" /RU PureTrek /RL LIMITED /F
