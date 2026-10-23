param(
  [string]$InstallDirectory = $PSScriptRoot,
  [string]$DesktopDirectory = [Environment]::GetFolderPath('Desktop'),
  [string]$ProgramsDirectory = [Environment]::GetFolderPath('Programs'),
  [string]$StartupDirectory = [Environment]::GetFolderPath('Startup'),
  [string]$ShortcutName = '',
  [switch]$InstallLogonRepair,
  [switch]$Quiet
)
$ErrorActionPreference = 'Stop'
if (!$ShortcutName) {
  $settingsPath = Join-Path $InstallDirectory 'client-settings.json'
  if (Test-Path -LiteralPath $settingsPath) {
    $ShortcutName = (Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json).shortcutName
  }
  if (!$ShortcutName) { $ShortcutName = 'BADIZO Admin1 Barcode' }
}
if ($ShortcutName.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) { throw 'Invalid shortcut name in app settings.' }
$launcher = Join-Path $InstallDirectory 'OPEN_ADMIN1.cmd'
$exe = Join-Path $InstallDirectory 'Badizo.exe'
if (!(Test-Path -LiteralPath $launcher -PathType Leaf) -or !(Test-Path -LiteralPath $exe -PathType Leaf)) {
  throw 'Admin1 app is missing for this Windows login. Use the Windows login used during installation.'
}
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @($DesktopDirectory, $ProgramsDirectory)) {
  New-Item -ItemType Directory -Force -Path $folder | Out-Null
  $shortcutPath = Join-Path $folder ($ShortcutName + '.lnk')
  $shortcut = $shell.CreateShortcut($shortcutPath)
  if (!(Test-Path -LiteralPath $shortcutPath) -or $shortcut.TargetPath -ne $launcher -or $shortcut.WorkingDirectory -ne $InstallDirectory -or $shortcut.Arguments) {
    $shortcut.TargetPath = $launcher
    $shortcut.Arguments = ''
    $shortcut.WorkingDirectory = $InstallDirectory
    $shortcut.IconLocation = $exe + ',0'
    $shortcut.Save()
    try {
      Add-Content -LiteralPath (Join-Path $InstallDirectory 'shortcut-repair.log') -Value ("{0} user={1} restored={2}" -f (Get-Date -Format o), $env:USERNAME, $shortcutPath)
    } catch { }
  }
}
if ($InstallLogonRepair) {
  $repairScript = Join-Path $InstallDirectory 'repair-admin1-shortcuts.ps1'
  if (!(Test-Path -LiteralPath $repairScript)) { throw 'Shortcut repair script is missing from the installed app.' }
  New-Item -ItemType Directory -Force -Path $StartupDirectory | Out-Null
  $startupName = if ($ShortcutName -eq 'BADIZO Admin1 Barcode') { 'BADIZO Admin1 Shortcut Repair.lnk' } else { $ShortcutName + ' Shortcut Repair.lnk' }
  $startupShortcut = $shell.CreateShortcut((Join-Path $StartupDirectory $startupName))
  $startupShortcut.TargetPath = Join-Path $PSHOME 'powershell.exe'
  $startupShortcut.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $repairScript + '" -Quiet'
  $startupShortcut.WorkingDirectory = $InstallDirectory
  $startupShortcut.WindowStyle = 7
  $startupShortcut.Save()
}
if (!$Quiet) { Write-Host "$ShortcutName is available on Desktop and in the Start menu." -ForegroundColor Green }
