@echo off
setlocal
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo Git is required.
  echo Install Git for Windows and run this file again.
  exit /b 1
)

set "NEW_REPO=0"
if not exist ".git" (
  git init
  if errorlevel 1 exit /b 1
  set "NEW_REPO=1"
)

git branch -M main
git remote get-url origin >nul 2>nul
if errorlevel 1 (
  git remote add origin https://github.com/HitBoyXx23-dev/navuryx-m3u-tool.git
) else (
  git remote set-url origin https://github.com/HitBoyXx23-dev/navuryx-m3u-tool.git
)
if errorlevel 1 exit /b 1

if "%NEW_REPO%"=="1" (
  git fetch origin main >nul 2>nul
  if not errorlevel 1 git reset origin/main
)

git config user.name >nul 2>nul
if errorlevel 1 git config user.name "HitBoyXx23-dev"
git config user.email >nul 2>nul
if errorlevel 1 git config user.email "228376718+HitBoyXx23-dev@users.noreply.github.com"

git add -A
if errorlevel 1 exit /b 1

git diff --cached --quiet
if not errorlevel 1 (
  echo No website changes to commit.
  pause
  exit /b 0
)

set "COMMIT_MESSAGE=%*"
if "%COMMIT_MESSAGE%"=="" set "COMMIT_MESSAGE=Update Navuryx website"

git commit -m "%COMMIT_MESSAGE%"
if errorlevel 1 exit /b 1

git push -u origin main
if errorlevel 1 (
  echo Push failed. Sign in to GitHub when prompted and try again.
  exit /b 1
)

echo Website pushed to GitHub successfully.
pause
