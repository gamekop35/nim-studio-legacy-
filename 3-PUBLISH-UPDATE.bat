@echo off
setlocal
cd /d "%~dp0"
title Publish a NIM Studio update
set "PATH=%PATH%;%ProgramFiles%\Git\cmd;%ProgramFiles%\nodejs"

for /f "usebackq" %%v in (`node -p "require('./package.json').version"`) do set CUR=%%v
echo.
echo  Publish an update
echo  =================
echo  Current version: %CUR%
echo  Make your changes first, then enter a HIGHER version number.
echo.
set /p NEWV=New version (for example 1.1.1): 
if "%NEWV%"=="" exit /b 1

call npm version %NEWV% --no-git-tag-version
if errorlevel 1 goto fail
git add -A
git commit -m "Release v%NEWV%"
git tag v%NEWV%
git push
git push origin v%NEWV%
if errorlevel 1 goto fail

echo.
echo  Sent. GitHub now builds the installer, which takes about 5 minutes.
echo  Everyone with the installed app gets the update next time they open it.
echo  Progress: open your repository on GitHub and click the Actions tab.
echo.
pause
exit /b 0

:fail
echo.
echo  Something went wrong. Scroll up to see the error.
echo  Run 2-CONNECT-GITHUB-ONCE.bat first if you have not yet, and use a new version number.
pause
exit /b 1
