@echo off
setlocal

set "SERVER_HOST=192.168.1.9"
set "LOGIN_USER=counter2"
set "BADIZO_DIR=%APPDATA%\Badizo"
set "LAUNCHER=%BADIZO_DIR%\OPEN_COUNTER2_BADIZO_APP.bat"

title Install Badizo Counter2 shortcut

echo Installing Badizo Counter2 desktop shortcut...
echo Server: http://%SERVER_HOST%:5000
echo.

if not exist "%BADIZO_DIR%" mkdir "%BADIZO_DIR%" >nul 2>nul

> "%LAUNCHER%" (
  echo @echo off
  echo setlocal
  echo set "SERVER_HOST=%SERVER_HOST%"
  echo set "LOGIN_USER=%LOGIN_USER%"
  echo set "BADIZO_APP_URL=http://%%SERVER_HOST%%:5000?loginMode=counter^&loginUser=%%LOGIN_USER%%"
  echo set "BADIZO_API_HEALTH_URL=http://%%SERVER_HOST%%:5000/api/health"
  echo set "BADIZO_SERVER_HOSTS=%%SERVER_HOST%%,badizo-server.local,badizo-server,server"
  echo set "BADIZO_EXE="
  echo if exist "%%LOCALAPPDATA%%\Programs\Badizo\Badizo.exe" set "BADIZO_EXE=%%LOCALAPPDATA%%\Programs\Badizo\Badizo.exe"
  echo if not defined BADIZO_EXE if exist "%%ProgramFiles%%\Badizo\Badizo.exe" set "BADIZO_EXE=%%ProgramFiles%%\Badizo\Badizo.exe"
  echo if not defined BADIZO_EXE if exist "C:\Program Files ^(x86^)\Badizo\Badizo.exe" set "BADIZO_EXE=C:\Program Files ^(x86^)\Badizo\Badizo.exe"
  echo if defined BADIZO_EXE ^(
  echo   start "" "%%BADIZO_EXE%%"
  echo   exit /b 0
  echo ^)
  echo start "" "%%BADIZO_APP_URL%%"
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$desktop=[Environment]::GetFolderPath('Desktop'); $target='%LAUNCHER%'; $shortcut=Join-Path $desktop 'Badizo.lnk'; $oldCounter2=Join-Path $desktop 'Badizo Counter2.lnk'; if (Test-Path $oldCounter2) { Remove-Item -LiteralPath $oldCounter2 -Force }; $ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut($shortcut); $s.TargetPath=$target; $s.WorkingDirectory=Split-Path -Parent $target; $s.IconLocation='%LOCALAPPDATA%\Programs\Badizo\Badizo.exe,0'; $s.Save(); Write-Host ('Shortcut created: ' + $shortcut) -ForegroundColor Green"

echo.
echo Done. Use the Desktop shortcut: Badizo
echo This overwrites Badizo shortcut to open Counter2 on server %SERVER_HOST%.
echo.
pause
