@echo off
rem Interactive task launcher for the learn corpus.
rem Double-click it, or run "run.bat" from a terminal. Plain numbered menu,
rem no decorative characters, so it reads cleanly with a screen reader.
setlocal
pushd "%~dp0"

:menu
echo.
echo learn corpus -- task launcher
echo.
echo   1. CI-parity local gate: lint, format, typecheck, tests, build, and checks
echo   2. Quality gate only: build, then glyph, link, and convention checks
echo   3. Build the accessible HTML only (all subjects)
echo   4. Build only changed pages (incremental, by file modification time)
echo   5. Glyph check only (characters a screen reader cannot read)
echo   6. Internal link check only (run a build first)
echo   7. Convention check only (nav chain, ascii arrows, subject lints)
echo   8. Open the built landing page in your browser
echo   9. Git status
echo  10. Git log (recent 15 commits)
echo   0. Exit
echo.
set "choice="
set /p "choice=Enter a number and press Enter: "

if "%choice%"=="1" ( bun run ci:local & goto after )
if "%choice%"=="2" ( bun run check & goto after )
if "%choice%"=="3" ( bun run build & goto after )
if "%choice%"=="4" ( bun run build:changed & goto after )
if "%choice%"=="5" ( bun run tools\checks.ts glyph & goto after )
if "%choice%"=="6" ( bun run tools\checks.ts links & goto after )
if "%choice%"=="7" ( bun run tools\checks.ts conventions & goto after )
if "%choice%"=="8" (
  if exist "html\index.html" (
    start "" "html\index.html"
    goto menu
  ) else (
    echo Built landing page not found at html\index.html.
    echo Run option 1 or 2 first to generate the HTML output.
    goto after
  )
)
if "%choice%"=="9" ( git status & goto after )
if "%choice%"=="10" ( git log --oneline -15 & goto after )
if "%choice%"=="0" ( popd & endlocal & exit /b 0 )

echo Unrecognized choice: "%choice%". Please enter a number from the menu.
goto menu

:after
echo.
echo Done. Press any key to return to the menu.
pause >nul
goto menu
