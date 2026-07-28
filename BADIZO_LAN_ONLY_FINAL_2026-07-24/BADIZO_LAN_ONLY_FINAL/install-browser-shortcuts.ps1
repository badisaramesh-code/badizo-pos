$ErrorActionPreference = 'Stop'

$server = '192.168.1.10'
$baseUrl = "http://${server}:5000"
$desktop = [Environment]::GetFolderPath('Desktop')
$sourceLauncher = Join-Path $PSScriptRoot 'open-badizo-lan.ps1'
$localLauncherDir = Join-Path $env:LOCALAPPDATA 'BadizoLAN'
$launcher = Join-Path $localLauncherDir 'open-badizo-lan.ps1'

function New-BadizoShortcut([string]$Name, [string]$Mode, [string]$User = '') {
  $shell = New-Object -ComObject WScript.Shell
  $shortcutPath = Join-Path $desktop "$Name.lnk"
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`" -LoginMode `"$Mode`""
  if ($User) { $arguments += " -LoginUser `"$User`"" }
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = $PSScriptRoot
  $shortcut.Description = 'Badizo POS - internet-free local LAN'
  $shortcut.Save()
  Write-Host "Created: $shortcutPath" -ForegroundColor Green
}

try {
  if (!(Test-Path -LiteralPath $sourceLauncher)) { throw "Missing launcher: $sourceLauncher" }
  New-Item -ItemType Directory -Path $localLauncherDir -Force | Out-Null
  Copy-Item -LiteralPath $sourceLauncher -Destination $launcher -Force
  Write-Host "Checking Badizo server at ${baseUrl}..."
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "${baseUrl}/api/health" -TimeoutSec 4
    if ($response.StatusCode -ne 200) { throw 'Health check failed.' }
    Write-Host 'Server is reachable on this LAN.' -ForegroundColor Green
  } catch {
    Write-Host 'Server is not reachable now. Shortcuts will still be installed.' -ForegroundColor Yellow
    Write-Host 'Keep the LAN router/switch and server PC on, then use the connection-test shortcut.' -ForegroundColor Yellow
  }

  New-BadizoShortcut 'Badizo - All Logins' 'all'
  New-BadizoShortcut 'Badizo - Admin 1' 'admin' 'admin1'
  New-BadizoShortcut 'Badizo - Admin 2' 'admin' 'admin2'
  foreach ($number in 1..6) { New-BadizoShortcut "Badizo - System $number" 'counter' "counter$number" }
  New-BadizoShortcut 'Badizo - Security 1' 'security' 'security1'
  New-BadizoShortcut 'Badizo - Security 2' 'security' 'security2'

  $shell = New-Object -ComObject WScript.Shell
  $testShortcut = $shell.CreateShortcut((Join-Path $desktop 'Badizo - LAN Connection Test.lnk'))
  $testShortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $testShortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -TestOnly"
  $testShortcut.WorkingDirectory = $PSScriptRoot
  $testShortcut.Save()
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
