@echo off
setlocal
title Restore BADIZO Admin1 Barcode Shortcut
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; try { $installDir=Join-Path $env:LOCALAPPDATA 'BadizoAdmin1Barcode-20261021-v2'; $launcher=Join-Path $installDir 'OPEN_ADMIN1.cmd'; $exe=Join-Path $installDir 'Badizo.exe'; if (!(Test-Path -LiteralPath $exe) -or !(Test-Path -LiteralPath $launcher)) { throw 'Admin1 barcode app was not found for this Windows user. Run this file on Admin1 using the same Windows login used during installation.' }; $desktop=[Environment]::GetFolderPath('Desktop'); $shell=New-Object -ComObject WScript.Shell; $shortcut=$shell.CreateShortcut((Join-Path $desktop 'BADIZO Admin1 Barcode.lnk')); $shortcut.TargetPath=$launcher; $shortcut.WorkingDirectory=$installDir; $shortcut.IconLocation=$exe+',0'; $shortcut.Save(); Write-Host ('Shortcut restored: '+$desktop+'\BADIZO Admin1 Barcode.lnk') -ForegroundColor Green } catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }"
pause
endlocal
