@echo off
rem Restarts the background the pod control server - run this after deploying an update.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Restart
echo.
pause
