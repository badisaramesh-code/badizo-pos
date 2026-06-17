param(
  [string]$ServerIp = '192.168.1.12',
  [string]$DatabaseName = 'badizo_pos',
  [string]$MySqlUser = 'root',
  [string]$MySqlPassword = '1234',
  [switch]$SkipPrerequisites
)

$ErrorActionPreference = 'Stop'

function Write-Step {
  param([string]$Message)
  Write-Host ''
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this setup as Administrator. Use setup-new-shop-server-one-click.bat for automatic UAC prompt.'
  }
}

function Refresh-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machinePath;$userPath"
}

function Get-CommandPath {
  param([string]$Name)

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  return $null
}

function Require-Winget {
  $winget = Get-CommandPath -Name 'winget.exe'
  if (!$winget) {
    throw 'winget was not found. Install App Installer from Microsoft Store, then run this setup again.'
  }

  return $winget
}

function Install-WingetPackage {
  param(
    [string]$Label,
    [string[]]$PackageIds
  )

  $winget = Require-Winget
  foreach ($packageId in $PackageIds) {
    Write-Host "Trying to install $Label using winget package: $packageId"
    & $winget install --id $packageId -e --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -eq 0) {
      Write-Host "$Label install command completed." -ForegroundColor Green
      Refresh-ProcessPath
      return $true
    }
  }

  return $false
}

function Ensure-NodeJs {
  Write-Step 'Checking Node.js'
  Refresh-ProcessPath
  $node = Get-CommandPath -Name 'node.exe'
  $npm = Get-CommandPath -Name 'npm.cmd'
  if ($node -and $npm) {
    Write-Host "Node.js found: $node" -ForegroundColor Green
    Write-Host "npm found: $npm" -ForegroundColor Green
    return
  }

  Write-Host 'Node.js was not found. Installing Node.js LTS with winget...' -ForegroundColor Yellow
  $installed = Install-WingetPackage -Label 'Node.js LTS' -PackageIds @('OpenJS.NodeJS.LTS')
  if (!$installed -or !(Get-CommandPath -Name 'node.exe') -or !(Get-CommandPath -Name 'npm.cmd')) {
    throw 'Node.js installation did not finish correctly. Install Node.js LTS manually, then run this setup again.'
  }
}

function Resolve-Npm {
  Refresh-ProcessPath
  $npm = Get-CommandPath -Name 'npm.cmd'
  if (!$npm) {
    throw 'npm.cmd was not found. Install Node.js first, then run this setup again.'
  }

  return $npm
}

function Get-MySqlServices {
  return @(Get-Service -Name 'MySQL*' -ErrorAction SilentlyContinue)
}

function Ensure-MySqlService {
  Write-Step 'Checking MySQL service'
  $services = Get-MySqlServices
  if ($services.Count -eq 0) {
    Write-Host 'MySQL service was not found. Trying MySQL installation with winget...' -ForegroundColor Yellow
    $installed = Install-WingetPackage -Label 'MySQL' -PackageIds @('Oracle.MySQL', 'Oracle.MySQLInstaller')
    if (!$installed) {
      throw 'MySQL installation could not be automated through winget. Install MySQL Server 8.x manually, set root password to 1234, then run this setup again.'
    }
    Start-Sleep -Seconds 10
    $services = Get-MySqlServices
  }

  if ($services.Count -eq 0) {
    throw 'MySQL was installed or launched, but no Windows service was found yet. Complete the MySQL installer wizard, set root password to 1234, then run this setup again.'
  }

  foreach ($service in $services) {
    Write-Host "MySQL service found: $($service.Name)"
    Set-Service -Name $service.Name -StartupType Automatic
    if ($service.Status -ne 'Running') {
      Start-Service -Name $service.Name
    }
  }

  Write-Host 'MySQL service is configured to start automatically.' -ForegroundColor Green
}

function Get-MySqlClientPath {
  Refresh-ProcessPath
  $mysql = Get-CommandPath -Name 'mysql.exe'
  if ($mysql) {
    return $mysql
  }

  $candidates = @(
    'C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe',
    'C:\Program Files\MySQL\MySQL Server 8.3\bin\mysql.exe',
    'C:\Program Files\MySQL\MySQL Server 8.2\bin\mysql.exe',
    'C:\Program Files\MySQL\MySQL Server 8.1\bin\mysql.exe',
    'C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe'
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  return $null
}

function Ensure-Database {
  Write-Step 'Checking Badizo database'
  $mysql = Get-MySqlClientPath
  if (!$mysql) {
    throw 'mysql.exe was not found. Install MySQL Server with client tools, then run this setup again.'
  }

  $sql = "CREATE DATABASE IF NOT EXISTS ``$DatabaseName`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  & $mysql "-u$MySqlUser" "-p$MySqlPassword" -e $sql
  if ($LASTEXITCODE -ne 0) {
    throw "Cannot connect to MySQL using user '$MySqlUser' and password '$MySqlPassword'. Set MySQL root password to 1234 or update this script parameters, then run again."
  }

  Write-Host "Database ready: $DatabaseName" -ForegroundColor Green
}

function Install-AppDependencies {
  Write-Step 'Installing Badizo app dependencies'
  $appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  $npm = Resolve-Npm
  $folders = @(
    (Join-Path $appRoot 'backend'),
    (Join-Path $appRoot 'frontend')
  )

  foreach ($folder in $folders) {
    if (!(Test-Path (Join-Path $folder 'package.json'))) {
      throw "Missing package.json in $folder. Make sure the deployment package includes backend and frontend folders."
    }

    Write-Host "Running npm install in $folder"
    Push-Location $folder
    & $npm install
    if ($LASTEXITCODE -ne 0) {
      Pop-Location
      throw "npm install failed in $folder"
    }
    Pop-Location
  }
}

function Run-ServerLanSetup {
  Write-Step 'Running Badizo server LAN setup'
  $lanSetup = Join-Path $PSScriptRoot 'setup-server-lan-one-click.ps1'
  if (!(Test-Path $lanSetup)) {
    throw "Missing setup file: $lanSetup"
  }

  & $lanSetup -ServerIp $ServerIp
}

try {
  Assert-Administrator
  Write-Host 'Badizo POS new shop server setup' -ForegroundColor Green
  Write-Host "Server IP: $ServerIp"
  Write-Host "Database: $DatabaseName"

  if (!$SkipPrerequisites) {
    Ensure-NodeJs
    Ensure-MySqlService
    Ensure-Database
    Install-AppDependencies
  } else {
    Write-Host 'Skipping prerequisite install/check because -SkipPrerequisites was used.' -ForegroundColor Yellow
  }

  Run-ServerLanSetup
} catch {
  Write-Host ''
  Write-Host 'New shop server setup failed.' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host ''
  Write-Host 'Press Enter to close this window.'
  Read-Host | Out-Null
  exit 1
}
