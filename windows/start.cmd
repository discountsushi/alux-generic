@echo off
rem Runs the server in this window (Ctrl+C to stop) - handy for troubleshooting.
rem For the normal background server use setup.cmd / restart.cmd.
cd /d "%~dp0.."
node server.js
echo.
pause
