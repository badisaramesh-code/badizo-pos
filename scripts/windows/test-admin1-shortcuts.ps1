$ErrorActionPreference = 'Stop'
$testRoot = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..\outputs')).Path ('admin1-shortcut-test-' + [guid]::NewGuid().ToString('N'))
$appDir = Join-Path $testRoot 'app'
$desktopDir = Join-Path $testRoot 'desktop'
$programsDir = Join-Path $testRoot 'programs'
$startupDir = Join-Path $testRoot 'startup'
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
Set-Content -LiteralPath (Join-Path $appDir 'Badizo.exe') -Value 'Test placeholder - never executed'
Set-Content -LiteralPath (Join-Path $appDir 'OPEN_ADMIN1.cmd') -Value '@exit /b'
$script = Join-Path $appDir 'repair-admin1-shortcuts.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'repair-admin1-shortcuts.ps1') -Destination $script
$parameters = @{ InstallDirectory=$appDir; DesktopDirectory=$desktopDir; ProgramsDirectory=$programsDir; StartupDirectory=$startupDir; Quiet=$true }
& $script @parameters -InstallLogonRepair
$shell = New-Object -ComObject WScript.Shell
$desktopLink = Join-Path $desktopDir 'BADIZO Admin1 Barcode.lnk'
$programsLink = Join-Path $programsDir 'BADIZO Admin1 Barcode.lnk'
$startupLink = Join-Path $startupDir 'BADIZO Admin1 Shortcut Repair.lnk'
foreach ($link in @($desktopLink, $programsLink)) {
  if (!(Test-Path -LiteralPath $link)) { throw "Missing shortcut $link" }
  if ($shell.CreateShortcut($link).TargetPath -ne (Join-Path $appDir 'OPEN_ADMIN1.cmd')) { throw 'Shortcut target mismatch' }
}
if ($shell.CreateShortcut($startupLink).Arguments -notlike '*-Quiet') { throw 'Login repair command is incorrect' }
$originalWriteTime = (Get-Item -LiteralPath $desktopLink).LastWriteTimeUtc
& $script @parameters
if ((Get-Item -LiteralPath $desktopLink).LastWriteTimeUtc -ne $originalWriteTime) { throw 'Valid shortcuts should not be rewritten' }
Remove-Item -LiteralPath $desktopLink
& $script @parameters
if (!(Test-Path -LiteralPath $desktopLink)) { throw 'Deleted Desktop shortcut was not recovered' }
$broken = $shell.CreateShortcut($programsLink)
$broken.TargetPath = Join-Path $appDir 'missing.exe'
$broken.Arguments = 'stale arguments'
$broken.Save()
& $script @parameters
$fixed = $shell.CreateShortcut($programsLink)
if ($fixed.TargetPath -ne (Join-Path $appDir 'OPEN_ADMIN1.cmd') -or $fixed.Arguments) { throw 'Broken Start menu shortcut was not repaired' }
$missingRejected = $false
$missingParameters = $parameters.Clone()
$missingParameters.InstallDirectory = Join-Path $testRoot 'missing-install'
try { & $script @missingParameters } catch {
  if ($_.Exception.Message -notlike '*App is missing*') { throw }
  $missingRejected = $true
}
if (!$missingRejected) { throw 'Missing installation must produce a clear failure' }
Set-Content -LiteralPath (Join-Path $appDir 'client-settings.json') -Value '{"shortcutName":"BADIZO Counter Stable"}'
& $script @parameters -InstallLogonRepair
if (!(Test-Path -LiteralPath (Join-Path $desktopDir 'BADIZO Counter Stable.lnk'))) { throw 'Configured role shortcut was not created' }
if (!(Test-Path -LiteralPath (Join-Path $startupDir 'BADIZO Counter Stable Shortcut Repair.lnk'))) { throw 'Configured role login repair was not created' }
Write-Host 'PASS: Desktop and Start menu creation, login recovery, repeat runs, deleted shortcut recovery, broken target repair, missing installation handling.'
Write-Host "All shortcut tests ran inside $testRoot"
