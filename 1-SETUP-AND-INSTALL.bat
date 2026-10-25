@echo off
setlocal
cd /d "%~dp0"
title NIM Studio setup
set CSC_IDENTITY_AUTO_DISCOVERY=false

echo.
echo  NIM Studio setup
echo  ================
echo  This takes about 3 to 5 minutes the first time. Keep this window open.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [1/3] Node.js is not installed. Installing it now, one time only...
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
) else (
  echo [1/3] Node.js found.
)

where node >nul 2>nul
if errorlevel 1 goto nonode

echo [2/3] Downloading app components...
call npm install --no-audit --no-fund
if errorlevel 1 goto fail

echo [3/3] Building the Windows installer...
call npm run dist
if errorlevel 1 goto fail

set "INSTALLER="
for %%f in ("dist\*Setup*.exe") do set "INSTALLER=%%f"
if not defined INSTALLER goto fail

echo.
echo  Done. Starting the installer...
start "" "%INSTALLER%"
echo  A portable version that needs no install is also in the "dist" folder.
echo.
pause
exit /b 0

:nonode
echo.
echo  Could not install Node.js automatically.
echo  Install the LTS version from https://nodejs.org, then run this file again.
echo.
pause
exit /b 1

:fail
echo.
echo  Something went wrong. Scroll up to see the error, then run this file again.
echo  If it keeps failing, try right-click and "Run as administrator".
echo.
pause
exit /b 1
