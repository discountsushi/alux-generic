@echo off
rem Stops the background the pod control server (whatever is listening on port 4810).
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 4810 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }; 'Stopped.' } else { 'Not running.' }"
echo.
pause
