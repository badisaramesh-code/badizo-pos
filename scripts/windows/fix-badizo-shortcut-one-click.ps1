$ErrorActionPreference = 'Stop'

$appExe = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Badizo\Badizo.exe'),
  (Join-Path $env:ProgramFiles 'Badizo\Badizo.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Badizo\Badizo.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

if (!$appExe) { throw 'Badizo.exe was not found. Install Badizo first.' }

$iconPath = @(
  (Join-Path (Split-Path $appExe) 'resources\assets\badizo.ico'),
  (Join-Path (Split-Path $appExe) 'assets\badizo.ico'),
  $appExe
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
Get-ChildItem -LiteralPath $desktop -Filter 'Badizo*.lnk' -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -ne 'Badizo.lnk' } |
  Remove-Item -Force

$shortcutPath = Join-Path $desktop 'Badizo.lnk'
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $appExe
$shortcut.WorkingDirectory = Split-Path $appExe
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Description = 'Badizo POS'
$shortcut.Save()

Start-Process -FilePath "$env:SystemRoot\System32\ie4uinit.exe" -ArgumentList '-show' -WindowStyle Hidden -ErrorAction SilentlyContinue
Write-Host "SUCCESS: $shortcutPath" -ForegroundColor Green
