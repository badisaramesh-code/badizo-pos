@echo off
setlocal
if "%~2"=="" (
  echo Usage: upgrade-enrolled-pos.bat "private-upgrade-config.json" "release-folder"
  exit /b 1
)
node "%~dp0..\..\tools\fleet\upgrade-windows-release.cjs" "%~f1" --apply "%~f2"
exit /b %errorlevel%
