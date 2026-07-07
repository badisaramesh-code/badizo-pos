param(
  [string]$ServerIp = '192.168.1.9',
  [string]$TargetRoot = 'C:\BadizoServer',
  [switch]$SkipInstall
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
    throw 'Run this migration as Administrator. Use migrate-existing-server-to-deployment-one-click.bat for automatic UAC prompt.'
  }
}

function Resolve-Npm {
  $npmCmd = 'C:\Program Files\nodejs\npm.cmd'
  if (Test-Path $npmCmd) {
    return $npmCmd
  }

  $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (!$command) {
    throw 'npm.cmd was not found. Install Node.js first.'
  }

  return $command.Source
}

function Assert-SafeTarget {
  $fullTarget = [System.IO.Path]::GetFullPath($TargetRoot)
  $root = [System.IO.Path]::GetPathRoot($fullTarget)

  if ([string]::IsNullOrWhiteSpace($fullTarget) -or $fullTarget -eq $root) {
    throw "Unsafe target folder: $TargetRoot"
  }

  if ($fullTarget -like "$($env:SystemRoot)*") {
    throw "Target folder cannot be inside Windows system folder: $fullTarget"
  }

  return $fullTarget.TrimEnd('\')
}

function Stop-BadizoTasks {
  Write-Step 'Stopping old Badizo startup tasks'
  foreach ($taskName in @('Badizo POS Backend', 'Badizo POS Frontend')) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      Write-Host "Stopped task: $taskName"
    } else {
      Write-Host "Task not found: $taskName" -ForegroundColor Yellow
    }
  }
}

function Stop-ProcessListeningOnPort {
  param([int]$Port)

  $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  $processIds = $connections |
    Select-Object -ExpandProperty OwningProcess -Unique |
    Where-Object { $_ -and $_ -ne $PID }

  foreach ($processId in $processIds) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process) {
      Write-Host "Stopping process on port ${Port}: $($process.ProcessName) ($processId)"
      Stop-Process -Id $processId -Force
    }
  }
}

function Stop-OldAppProcesses {
  Write-Step 'Stopping old backend/frontend processes'
  Stop-ProcessListeningOnPort -Port 3000
  Stop-ProcessListeningOnPort -Port 5000
  Start-Sleep -Seconds 2
}

function Copy-DirectoryWithoutNoise {
  param(
    [string]$Source,
    [string]$Destination,
    [string[]]$ExcludedNames
  )

  if (!(Test-Path $Source)) {
    throw "Source folder missing: $Source"
  }

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -Path $Source -Force | Where-Object {
    $ExcludedNames -notcontains $_.Name
  } | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $Destination -Recurse -Force
  }
}

function Copy-AppFiles {
  param(
    [string]$SourceRoot,
    [string]$DestinationRoot
  )

  Write-Step 'Copying app files to deployment folder'
  New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null

  Copy-DirectoryWithoutNoise `
    -Source (Join-Path $SourceRoot 'backend') `
    -Destination (Join-Path $DestinationRoot 'backend') `
    -ExcludedNames @('node_modules', 'backups', 'logs', 'server.out.log', 'server.err.log')

  Copy-DirectoryWithoutNoise `
    -Source (Join-Path $SourceRoot 'frontend') `
    -Destination (Join-Path $DestinationRoot 'frontend') `
    -ExcludedNames @('node_modules', 'build', 'logs')

  Copy-DirectoryWithoutNoise `
    -Source (Join-Path $SourceRoot 'scripts') `
    -Destination (Join-Path $DestinationRoot 'scripts') `
    -ExcludedNames @()

  $rootFiles = @(
    'BADIZO_DEPLOYMENT_GUIDE.md',
    'NEW_SHOP_DEPLOYMENT.md',
    'SHOP_UPDATE.md',
    'SERVER_SLAVE_SETUP.md'
  )

  foreach ($fileName in $rootFiles) {
    $sourceFile = Join-Path $SourceRoot $fileName
    if (Test-Path $sourceFile) {
      Copy-Item -Path $sourceFile -Destination $DestinationRoot -Force
    }
  }

  $convenienceFiles = @(
    'apply-shop-update-one-click.bat',
    'setup-slave-one-click.bat',
    'setup-slave-app.ps1'
  )

  foreach ($fileName in $convenienceFiles) {
    $sourceFile = Join-Path (Join-Path $SourceRoot 'scripts\windows') $fileName
    if (Test-Path $sourceFile) {
      Copy-Item -Path $sourceFile -Destination $DestinationRoot -Force
    }
  }

  $installer = Get-ChildItem -Path (Join-Path $SourceRoot 'electron\dist') -Filter 'Badizo Setup*.exe' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($installer) {
    Copy-Item -Path $installer.FullName -Destination $DestinationRoot -Force
  }

  Write-Host "Deployment folder ready: $DestinationRoot" -ForegroundColor Green
}

function Install-AppDependencies {
  param([string]$DestinationRoot)

  if ($SkipInstall) {
    Write-Host 'Skipping npm install because -SkipInstall was used.' -ForegroundColor Yellow
    return
  }

  Write-Step 'Installing backend/frontend dependencies'
  $npm = Resolve-Npm
  foreach ($folderName in @('backend', 'frontend')) {
    $folder = Join-Path $DestinationRoot $folderName
    if (!(Test-Path (Join-Path $folder 'package.json'))) {
      throw "Missing package.json in $folder"
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

function Build-Frontend {
  param([string]$DestinationRoot)

  Write-Step 'Building frontend for server IP'
  $npm = Resolve-Npm
  $frontendDir = Join-Path $DestinationRoot 'frontend'
  Push-Location $frontendDir
  $previousApiBaseUrl = $env:REACT_APP_API_BASE_URL
  $previousSkipOpenAfterBuild = $env:BADIZO_SKIP_OPEN_AFTER_BUILD
  try {
    $env:REACT_APP_API_BASE_URL = "http://$ServerIp`:5000/api"
    $env:BADIZO_SKIP_OPEN_AFTER_BUILD = '1'
    & $npm run build
    $buildExitCode = $LASTEXITCODE
  } finally {
    $env:REACT_APP_API_BASE_URL = $previousApiBaseUrl
    $env:BADIZO_SKIP_OPEN_AFTER_BUILD = $previousSkipOpenAfterBuild
    Pop-Location
  }
  if ($buildExitCode -ne 0) {
    throw 'Frontend build failed.'
  }
}

function Add-FirewallRuleIfMissing {
  param(
    [string]$DisplayName,
    [int]$Port
  )

  $existing = Get-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Firewall rule already exists: $DisplayName" -ForegroundColor Yellow
    return
  }

  New-NetFirewallRule `
    -DisplayName $DisplayName `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort $Port `
    -Action Allow | Out-Null

  Write-Host "Firewall rule added: $DisplayName" -ForegroundColor Green
}

function Install-StartupTasks {
  param([string]$DestinationRoot)

  Write-Step 'Installing startup tasks from deployment folder'
  $scriptRoot = Join-Path $DestinationRoot 'scripts\windows'
  & (Join-Path $scriptRoot 'install-backend-startup-task.ps1')
  & (Join-Path $scriptRoot 'install-frontend-startup-task.ps1') -ServerIp $ServerIp

  Add-FirewallRuleIfMissing -DisplayName 'Badizo Frontend 3000' -Port 3000
  Add-FirewallRuleIfMissing -DisplayName 'Badizo Backend 5000' -Port 5000
}

function Test-Url {
  param([string]$Url)

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 8
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
      Write-Host "OK: $Url" -ForegroundColor Green
      return $true
    }
  } catch {
    Write-Host "FAILED: $Url" -ForegroundColor Red
    return $false
  }

  Write-Host "FAILED: $Url" -ForegroundColor Red
  return $false
}

function Test-FinalHealth {
  Write-Step 'Checking migrated server'
  Start-Sleep -Seconds 8
  $backendLocal = Test-Url -Url 'http://localhost:5000/api/health'
  $frontendLocal = Test-Url -Url 'http://localhost:3000'
  $backendLan = Test-Url -Url "http://${ServerIp}:5000/api/health"
  $frontendLan = Test-Url -Url "http://${ServerIp}:3000"

  if (!$backendLocal -or !$frontendLocal -or !$backendLan -or !$frontendLan) {
    throw 'Migration finished, but one or more server checks failed.'
  }
}

try {
  Assert-Administrator

  $sourceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  $destinationRoot = Assert-SafeTarget

  Write-Host 'Badizo existing server to deployment migration' -ForegroundColor Green
  Write-Host "Source repo folder: $sourceRoot"
  Write-Host "Target deployment folder: $destinationRoot"
  Write-Host "Server IP: $ServerIp"
  Write-Host ''
  Write-Host 'This migration does not uninstall MySQL, delete MySQL data, drop database, or reset sales data.' -ForegroundColor Yellow

  Stop-BadizoTasks
  Stop-OldAppProcesses
  Copy-AppFiles -SourceRoot $sourceRoot -DestinationRoot $destinationRoot
  Install-AppDependencies -DestinationRoot $destinationRoot
  Build-Frontend -DestinationRoot $destinationRoot
  Install-StartupTasks -DestinationRoot $destinationRoot
  Test-FinalHealth

  Write-Host ''
  Write-Host 'Migration completed successfully.' -ForegroundColor Green
  Write-Host "Badizo server now runs from: $destinationRoot" -ForegroundColor Green
  Write-Host 'MySQL database was not touched.' -ForegroundColor Green
  Write-Host ''
  Write-Host 'Press Enter to close this window.'
  Read-Host | Out-Null
} catch {
  Write-Host ''
  Write-Host 'Migration failed.' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host ''
  Write-Host 'MySQL database was not intentionally changed by this script.' -ForegroundColor Yellow
  Write-Host 'Press Enter to close this window.'
  Read-Host | Out-Null
  exit 1
}
