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
echo    2. Create a new PUBLIC repository named  nim-studio
echo       (it is fine if GitHub added a README to it)
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
git config core.autocrlf false
git config user.name >nul 2>nul || git config user.name "%GHUSER%"
git config user.email >nul 2>nul || git config user.email "%GHUSER%@users.noreply.github.com"
git add -A
git commit -m "NIM Studio"
git branch -M main
git remote remove origin >nul 2>nul
git remote add origin https://github.com/%GHUSER%/nim-studio.git

echo.
echo A browser window may open so you can sign in to GitHub. Approve it.
git push -u origin main
if not errorlevel 1 goto pushed

echo.
echo The GitHub repository already has files in it. Merging them with yours...
git pull origin main --allow-unrelated-histories --no-edit -X ours
git push -u origin main
if not errorlevel 1 goto pushed

echo.
echo Merging did not work. Replacing the GitHub copy with this folder instead...
git push -u origin main --force
if errorlevel 1 goto fail

:pushed
echo.
echo  Connected. Next:
echo    - Double-click 3-PUBLISH-UPDATE.bat to release a version.
echo    - Then build and install the app once with 1-SETUP-AND-INSTALL.bat.
echo      Installed copies check for updates by themselves from then on.
echo.
pause
exit /b 0

:fail
echo.
echo  Something went wrong. Scroll up to see the error.
echo  Check that the repository "nim-studio" exists on GitHub under your username
echo  and that you approved the GitHub sign-in in your browser.
pause
exit /b 1
