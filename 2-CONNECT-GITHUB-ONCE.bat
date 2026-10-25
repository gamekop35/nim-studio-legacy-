@echo off
setlocal
cd /d "%~dp0"
title Connect NIM Studio to GitHub
set "PATH=%PATH%;%ProgramFiles%\Git\cmd;%ProgramFiles%\nodejs"

echo.
echo  One-time setup for automatic updates
echo  ====================================
echo  Before you continue:
echo    1. Make a free account at https://github.com
echo    2. Create a new PUBLIC repository named  nim-studio  (leave it empty)
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo Installing Git, one time only...
  winget install -e --id Git.Git --silent --accept-package-agreements --accept-source-agreements
  set "PATH=%PATH%;%ProgramFiles%\Git\cmd"
)
where git >nul 2>nul
if errorlevel 1 (
  echo Could not install Git automatically. Install it from https://git-scm.com and run this again.
  pause
  exit /b 1
)

set /p GHUSER=Your GitHub username: 
if "%GHUSER%"=="" exit /b 1

node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.build.publish[0].owner=process.argv[1];fs.writeFileSync('package.json',JSON.stringify(p,null,2))" %GHUSER%
if errorlevel 1 goto fail

git init
git config user.name >nul 2>nul || git config user.name "%GHUSER%"
git config user.email >nul 2>nul || git config user.email "%GHUSER%@users.noreply.github.com"
git add -A
git commit -m "Initial version"
git branch -M main
git remote remove origin >nul 2>nul
git remote add origin https://github.com/%GHUSER%/nim-studio.git
echo.
echo A browser window may open so you can sign in to GitHub. Approve it.
git push -u origin main
if errorlevel 1 goto fail

echo.
echo  Connected. Next:
echo    - Double-click 3-PUBLISH-UPDATE.bat to release version 1.1.0 or any newer one.
echo    - Then build and install this version once with 1-SETUP-AND-INSTALL.bat.
echo      Installed copies check for updates by themselves from then on.
echo.
pause
exit /b 0

:fail
echo.
echo  Something went wrong. Scroll up to see the error.
echo  Check that the repository "nim-studio" exists on GitHub and is empty.
pause
exit /b 1
