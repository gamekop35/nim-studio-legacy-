@echo off
setlocal
cd /d "%~dp0"
title NIM Studio

where node >nul 2>nul
if errorlevel 1 (
  echo Installing Node.js, one time only...
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
)

where node >nul 2>nul
if errorlevel 1 (
  echo Could not install Node.js automatically. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: downloading app components...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Download failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

start "" /b cmd /c "npm start"
exit /b 0
