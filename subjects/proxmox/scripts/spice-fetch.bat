@echo off
rem Double-click to fetch the SPICE console.vv only (no launch). Open it within ~30s.
rem RemoteSigned runs this local repo script without bypassing all policy enforcement.
pwsh -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0spice-console.ps1" -FetchOnly
echo.
pause
