@echo off
rem the pod control setup: Node.js check, firewall rule, start-at-logon shortcut, start now.
rem   setup.cmd              first-time setup (safe to re-run)
rem   setup.cmd -Uninstall   stop the server, remove the shortcut and firewall rule
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
echo.
pause
