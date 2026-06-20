@echo off
rem Double-click to fetch a fresh SPICE ticket and open the console in remote-viewer.
rem RemoteSigned runs this local repo script without bypassing all policy enforcement.
pwsh -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0spice-console.ps1"
echo.
pause
