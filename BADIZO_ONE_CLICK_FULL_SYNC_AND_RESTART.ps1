[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ExpectedRoot = 'D:\badizo-pos-main'
$ExpectedBranch = 'main'
$ExpectedRemoteName = 'origin'
$ExpectedRemoteUrl = 'https://github.com/badisaramesh-code/badizo-pos.git'
$BackendServiceName = 'BadizoServer'
$BackupTaskName = 'Badizo Daily Drive Backup'
$BackupRoot = 'D:\BadizoCloudBackups'
$HealthUrl = 'http://127.0.0.1:5000/api/health'
$AppUrl = 'http://127.0.0.1:5000'
$LogRoot = Join-Path $ExpectedRoot 'logs\one-click'
$RunStamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
$LogFile = Join-Path $LogRoot "badizo-one-click-$RunStamp.log"
$FinalReady = $false
$TranscriptStarted = $false

function Write-Step {
  param([string]$Message)
  Write-Host ''
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Invoke-Git {
  param(
    [Parameter(Mandatory)][string]$Explanation,
    [Parameter(Mandatory)][string[]]$Arguments,
    [switch]$Capture
  )

  Write-Host "Git safety: $Explanation" -ForegroundColor DarkCyan
  if ($Capture) {
    $output = & git @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "Git command failed: git $($Arguments -join ' ')`n$($output -join [Environment]::NewLine)"
    }
    return @($output)
  }

  & git @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Git command failed: git $($Arguments -join ' ')"
  }
}

function Get-GitLines {
  param([string]$Explanation, [string[]]$Arguments)
  return @(Invoke-Git -Explanation $Explanation -Arguments $Arguments -Capture |
    ForEach-Object { "$_" } |
    Where-Object { $_ -ne '' })
}

function Assert-NoGitOperationInProgress {
  $gitDirText = (Get-GitLines -Explanation 'Locate Git metadata so merge/rebase state can be checked.' -Arguments @('rev-parse', '--git-dir') | Select-Object -First 1)
  if (!$gitDirText) { throw 'Unable to locate the Git metadata directory.' }
  $gitDir = if ([IO.Path]::IsPathRooted($gitDirText)) { $gitDirText } else { Join-Path $ExpectedRoot $gitDirText }
  $markers = @('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply')
  $active = @($markers | Where-Object { Test-Path -LiteralPath (Join-Path $gitDir $_) })
  if ($active.Count) {
    throw "A Git merge/rebase/cherry-pick/revert is already in progress: $($active -join ', '). Resolve it manually first."
  }
}

function Assert-NoConflicts {
  $conflicts = Get-GitLines -Explanation 'Check the index for unresolved merge conflicts.' -Arguments @('diff', '--name-only', '--diff-filter=U')
  if ($conflicts.Count) {
    throw "Merge conflicts require manual review. Conflicted files: $($conflicts -join ', ')"
  }
  Assert-NoGitOperationInProgress
}

function Test-SecretOrDumpPath {
  param([string]$RelativePath)
  $p = $RelativePath.Replace('\', '/').ToLowerInvariant()
  $name = [IO.Path]::GetFileName($p)
  if ($name -eq '.env' -or $name -like '.env.*') { return $true }
  if ($name -match '(credentials?|service[-_]?account|client[-_]?secret).*[.]json$') { return $true }
  if ($name -match '[.](pem|key|pfx|p12|ppk|sql|dump|bak)$') { return $true }
  if ($p -match '(^|/)(backups?|database[-_]?dumps?)(/|$)') { return $true }
  return $false
}

function Test-GeneratedOrForbiddenPath {
  param([string]$RelativePath)
  $p = $RelativePath.Replace('\', '/').ToLowerInvariant()
  if ($p -match '(^|/)(node_modules|build|dist|coverage|logs?|backups?)(/|$)') { return $true }
  if ($p -match '[.](zip|exe|msi|7z|rar|log|sql|dump|bak|pem|key|pfx|p12|ppk)$') { return $true }
  return $false
}

function Test-SafeSourcePath {
  param([string]$RelativePath)
  if (Test-SecretOrDumpPath $RelativePath) { return $false }
  if (Test-GeneratedOrForbiddenPath $RelativePath) { return $false }
  $p = $RelativePath.Replace('\', '/')
  $name = [IO.Path]::GetFileName($p)
  if ($name -in @('.gitignore', '.gitattributes', 'Dockerfile')) { return $true }
  $allowed = @('.js','.jsx','.mjs','.cjs','.ts','.tsx','.json','.css','.scss','.sass','.less','.html','.md','.txt','.ps1','.bat','.cmd','.sh','.yml','.yaml','.toml','.ini','.conf','.config','.xml','.nsh')
  return $allowed -contains [IO.Path]::GetExtension($p).ToLowerInvariant()
}

function Assert-NoObviousSecrets {
  param([string[]]$ChangedFiles)
  $secretPaths = @($ChangedFiles | Where-Object { Test-SecretOrDumpPath $_ })
  if ($secretPaths.Count) {
    throw "Refusing to continue: secret or database-dump filenames are present in Git-visible changes: $($secretPaths -join ', ')"
  }

  $contentFindings = New-Object System.Collections.Generic.List[string]
  foreach ($relative in $ChangedFiles) {
    if (!(Test-SafeSourcePath $relative)) { continue }
    $full = Join-Path $ExpectedRoot $relative
    if (!(Test-Path -LiteralPath $full -PathType Leaf)) { continue }
    $item = Get-Item -LiteralPath $full
    if ($item.Length -gt 5MB) { continue }
    $text = Get-Content -LiteralPath $full -Raw -ErrorAction SilentlyContinue
    if ($null -eq $text) { continue }
    if ($text -match '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' -or
        $text -match '"type"\s*:\s*"service_account"' -or
        $text -match '"private_key"\s*:\s*"-----BEGIN') {
      $contentFindings.Add($relative)
    }
  }
  if ($contentFindings.Count) {
    throw "Refusing to continue: obvious private-key or service-account content detected in: $($contentFindings -join ', ')"
  }
}

function Wait-TaskCompletion {
  param([string]$TaskName, [datetime]$PreviousRunTime, [int]$TimeoutSeconds = 1200)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Seconds 2
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
    if ($task.State -ne 'Running' -and $info.LastRunTime -gt $PreviousRunTime) { return $info }
  } while ((Get-Date) -lt $deadline)
  throw "Backup task '$TaskName' did not finish within $TimeoutSeconds seconds."
}

function Invoke-ProductionBackup {
  Write-Step 'Creating verified database and configuration backups'
  $task = Get-ScheduledTask -TaskName $BackupTaskName -ErrorAction SilentlyContinue
  if (!$task) { throw "Required verified backup task was not found: $BackupTaskName" }
  if ($task.State -eq 'Running') { throw "Backup task is already running: $BackupTaskName" }

  $action = @($task.Actions)[0]
  $expectedScript = 'D:\badizo-pos-main\backend\scripts\badizo_cloud_backup.js'
  if ($action.Execute -notmatch 'node[.]exe' -or $action.Arguments -notlike "*$expectedScript*" -or $action.Arguments -notmatch '(?:^|\s)daily(?:\s|$)') {
    throw "Backup task configuration differs from the verified production daily-backup command. Review '$BackupTaskName' manually."
  }

  $before = Get-ScheduledTaskInfo -TaskName $BackupTaskName -ErrorAction Stop
  $backupStartedAt = Get-Date
  Start-ScheduledTask -TaskName $BackupTaskName -ErrorAction Stop
  $after = Wait-TaskCompletion -TaskName $BackupTaskName -PreviousRunTime $before.LastRunTime
  if ($after.LastTaskResult -ne 0) { throw "Database backup task failed with result $($after.LastTaskResult)." }

  $newDump = Get-ChildItem -LiteralPath (Join-Path $BackupRoot 'daily') -Filter 'badizo_daily_*.sql' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $backupStartedAt.AddSeconds(-2) -and $_.Length -gt 1MB } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (!$newDump) { throw 'Backup task reported success, but no new validated daily SQL backup was found.' }
  Write-Host "Database backup verified: $($newDump.Name) ($([math]::Round($newDump.Length / 1MB, 1)) MB)" -ForegroundColor Green

  $configBackupDir = Join-Path $BackupRoot "pre-update-config\$RunStamp"
  New-Item -ItemType Directory -Path $configBackupDir -Force | Out-Null
  $configFiles = @('backend\.env', 'electron\app-config.json')
  $copied = 0
  foreach ($relative in $configFiles) {
    $source = Join-Path $ExpectedRoot $relative
    if (Test-Path -LiteralPath $source -PathType Leaf) {
      $destination = Join-Path $configBackupDir $relative
      New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
      Copy-Item -LiteralPath $source -Destination $destination -Force
      $copied++
    }
  }
  if ($copied -eq 0) { throw 'No production configuration files were available to back up.' }
  Write-Host "Configuration backup verified outside the repository: $configBackupDir" -ForegroundColor Green
}

function Invoke-NpmCiIfRequired {
  param([string[]]$ChangedAcrossUpdate)
  $npm = 'C:\Program Files\nodejs\npm.cmd'
  if (!(Test-Path -LiteralPath $npm)) { $npm = (Get-Command npm.cmd -ErrorAction Stop).Source }
  foreach ($area in @('backend','frontend','electron')) {
    $manifestChanged = @($ChangedAcrossUpdate | Where-Object { $_ -in @("$area/package.json", "$area/package-lock.json") }).Count -gt 0
    if (!$manifestChanged) {
      Write-Host "Dependencies unchanged for $area; skipping npm ci."
      continue
    }
    Write-Step "Installing locked $area dependencies"
    Push-Location (Join-Path $ExpectedRoot $area)
    try {
      & $npm ci --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "npm ci failed in $area." }
    } finally { Pop-Location }
  }
}

function Invoke-FrontendBuildIfRequired {
  param([string[]]$ChangedAcrossUpdate)
  $buildIndex = Join-Path $ExpectedRoot 'frontend\build\index.html'
  $frontendChanged = @($ChangedAcrossUpdate | Where-Object { $_ -like 'frontend/*' }).Count -gt 0
  if (!$frontendChanged -and (Test-Path -LiteralPath $buildIndex)) {
    Write-Host 'Frontend source unchanged and production build exists; skipping build.'
    return
  }

  Write-Step 'Building the production frontend served by the backend'
  $npm = 'C:\Program Files\nodejs\npm.cmd'
  if (!(Test-Path -LiteralPath $npm)) { $npm = (Get-Command npm.cmd -ErrorAction Stop).Source }
  Push-Location (Join-Path $ExpectedRoot 'frontend')
  $oldSkipOpen = $env:BADIZO_SKIP_OPEN_AFTER_BUILD
  try {
    $env:BADIZO_SKIP_OPEN_AFTER_BUILD = '1'
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend production build failed.' }
  } finally {
    $env:BADIZO_SKIP_OPEN_AFTER_BUILD = $oldSkipOpen
    Pop-Location
  }
  if (!(Test-Path -LiteralPath $buildIndex)) { throw 'Frontend build finished without build\index.html.' }
}

function Test-BackendHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 5
    return $response.StatusCode -eq 200 -and $response.Content -match '"ok"\s*:\s*true'
  } catch { return $false }
}

function Restart-VerifiedBackendService {
  Write-Step 'Restarting the verified NSSM backend service'
  $service = Get-CimInstance Win32_Service -Filter "Name='$BackendServiceName'" -ErrorAction SilentlyContinue
  if (!$service) { throw "Required production service was not found: $BackendServiceName" }
  if ($service.PathName -ne 'C:\BadizoService\nssm.exe') { throw "Unexpected service wrapper for ${BackendServiceName}: $($service.PathName)" }
  $nssm = $service.PathName
  $application = ((& $nssm get $BackendServiceName Application) -join '').Replace([char]0, '').Trim()
  $directory = ((& $nssm get $BackendServiceName AppDirectory) -join '').Replace([char]0, '').Trim()
  $parameters = ((& $nssm get $BackendServiceName AppParameters) -join '').Replace([char]0, '').Trim()
  if ($application -ne 'C:\Program Files\nodejs\node.exe' -or $directory -ne 'D:\badizo-pos-main\backend' -or $parameters -ne 'server.js') {
    throw 'BadizoServer NSSM parameters differ from the verified production configuration; refusing to restart.'
  }

  Restart-Service -Name $BackendServiceName -Force -ErrorAction Stop
  $deadline = (Get-Date).AddSeconds(90)
  do {
    Start-Sleep -Seconds 2
    if (Test-BackendHealth) { break }
  } while ((Get-Date) -lt $deadline)
  if (!(Test-BackendHealth)) { throw 'Badizo backend did not become healthy after the service restart.' }

  $service = Get-CimInstance Win32_Service -Filter "Name='$BackendServiceName'"
  $listener = Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (!$listener -or $listener.OwningProcess -ne $service.ProcessId) {
    throw 'Port 5000 is not owned by the verified BadizoServer service process.'
  }
  Write-Host "Backend healthy on port 5000. Service PID=$($service.ProcessId)" -ForegroundColor Green
}

function Open-BadizoApplication {
  Write-Step 'Opening the verified Badizo server application'
  $desktop = [Environment]::GetFolderPath('Desktop')
  $shortcutPath = Join-Path $desktop 'Badizo Server.lnk'
  if (!(Test-Path -LiteralPath $shortcutPath)) { throw "Verified desktop launcher is missing: $shortcutPath" }
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
  if ($shortcut.TargetPath -notmatch 'msedge[.]exe$' -or $shortcut.Arguments -notmatch '--app=["'']?http://127[.]0[.]0[.]1:5000') {
    throw 'Badizo Server desktop shortcut no longer matches the verified Edge app-mode launcher.'
  }

  $existing = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '--app=["'']?http://127[.]0[.]0[.]1:5000' } |
    Select-Object -First 1
  if ($existing) {
    Write-Host "Badizo Edge app is already open (PID=$($existing.ProcessId)); no duplicate started."
  } else {
    Start-Process -FilePath $shortcutPath
    Start-Sleep -Seconds 5
  }

  $opened = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '--app=["'']?http://127[.]0[.]0[.]1:5000' } |
    Select-Object -First 1
  if (!$opened) { throw 'The verified Badizo Edge app-mode process was not detected after launch.' }
  $rootResponse = Invoke-WebRequest -UseBasicParsing -Uri $AppUrl -TimeoutSec 8
  if ($rootResponse.StatusCode -ne 200) { throw "Badizo application URL returned HTTP $($rootResponse.StatusCode)." }
  Write-Host "Application open in Edge app mode. PID=$($opened.ProcessId)" -ForegroundColor Green
}

try {
  $actualRoot = (Get-Location).Path.TrimEnd('\')
  if ($actualRoot -ne $ExpectedRoot) { throw "Run this automation only from $ExpectedRoot. Current path: $actualRoot" }
  if (!(Test-Path -LiteralPath (Join-Path $ExpectedRoot '.git'))) { throw 'Expected Git repository metadata was not found.' }

  New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
  Start-Transcript -LiteralPath $LogFile -Force | Out-Null
  $TranscriptStarted = $true
  Write-Host "Badizo production one-click workflow started at $(Get-Date -Format s)"
  Write-Host "Log: $LogFile"

  Write-Step 'Git preflight: status, branch, remote, operation state'
  Invoke-Git -Explanation 'Show the current working tree status before any synchronization.' -Arguments @('status', '--short', '--branch')
  $branch = (Get-GitLines -Explanation 'Verify the current branch is main.' -Arguments @('branch', '--show-current') | Select-Object -First 1)
  if ($branch -ne $ExpectedBranch) { throw "Current branch is '$branch'; expected '$ExpectedBranch'." }
  $remoteUrl = (Get-GitLines -Explanation 'Verify origin points to the approved Badizo repository.' -Arguments @('remote', 'get-url', $ExpectedRemoteName) | Select-Object -First 1)
  if ($remoteUrl -ne $ExpectedRemoteUrl) { throw "origin is '$remoteUrl'; expected '$ExpectedRemoteUrl'." }
  Assert-NoGitOperationInProgress

  $changed = Get-GitLines -Explanation 'List Git-visible local changes for secret and staging safety checks.' -Arguments @('ls-files', '--modified', '--deleted', '--others', '--exclude-standard')
  Assert-NoObviousSecrets -ChangedFiles $changed
  $unsafeTracked = Get-GitLines -Explanation 'Identify tracked modifications that are outside the safe source allowlist.' -Arguments @('ls-files', '--modified', '--deleted') |
    Where-Object { !(Test-SafeSourcePath $_) }
  if ($unsafeTracked.Count) { throw "Tracked non-source/generated changes require manual review: $($unsafeTracked -join ', ')" }

  Invoke-ProductionBackup

  Write-Step 'Fetching and comparing origin/main'
  Invoke-Git -Explanation 'Fetch the approved origin without changing application files.' -Arguments @('fetch', $ExpectedRemoteName)
  Write-Host 'Incoming commits:' -ForegroundColor Yellow
  $incoming = Get-GitLines -Explanation 'Show commits present on origin/main but not local HEAD.' -Arguments @('log', '--oneline', 'HEAD..origin/main')
  if ($incoming.Count) { $incoming | ForEach-Object { Write-Host $_ } } else { Write-Host '(none)' }
  Write-Host 'Outgoing commits:' -ForegroundColor Yellow
  $outgoing = Get-GitLines -Explanation 'Show commits present locally but not on origin/main.' -Arguments @('log', '--oneline', 'origin/main..HEAD')
  if ($outgoing.Count) { $outgoing | ForEach-Object { Write-Host $_ } } else { Write-Host '(none)' }

  $beforeUpdateHead = (Get-GitLines -Explanation 'Record the pre-update commit for dependency/build decisions.' -Arguments @('rev-parse', 'HEAD') | Select-Object -First 1)
  $safeChanges = @($changed | Where-Object { Test-SafeSourcePath $_ } | Sort-Object -Unique)
  if ($safeChanges.Count) {
    Write-Step 'Safe local source changes selected for commit'
    $safeChanges | ForEach-Object { Write-Host "  $_" }
    foreach ($file in $safeChanges) {
      Invoke-Git -Explanation "Stage only approved source/configuration file: $file" -Arguments @('add', '--', $file)
    }
    $staged = Get-GitLines -Explanation 'Show the exact files that will be committed.' -Arguments @('diff', '--cached', '--name-only')
    if (!$staged.Count) { throw 'Safe changes were detected, but nothing was staged.' }
    Write-Host 'Files to be committed:' -ForegroundColor Yellow
    $staged | ForEach-Object { Write-Host "  $_" }
    Assert-NoObviousSecrets -ChangedFiles $staged
    $commitMessage = "chore: safe Badizo sync $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
    Invoke-Git -Explanation "Create the displayed automatic source-only commit: $commitMessage" -Arguments @('commit', '-m', $commitMessage)
  } else {
    Write-Host 'No safe local source changes require a commit.'
  }

  Write-Step 'Rebasing onto origin/main'
  try {
    Invoke-Git -Explanation 'Update main using pull --rebase from the approved origin; never force or reset.' -Arguments @('pull', '--rebase', $ExpectedRemoteName, $ExpectedBranch)
  } catch {
    Write-Host 'Pull/rebase stopped. Resolve conflicts manually; this automation will not abort, reset, or force anything.' -ForegroundColor Red
    throw
  }
  Assert-NoConflicts

  $changedAcrossUpdate = Get-GitLines -Explanation 'Determine files changed across this update for conditional install/build.' -Arguments @('diff', '--name-only', "$beforeUpdateHead..HEAD")
  Invoke-NpmCiIfRequired -ChangedAcrossUpdate $changedAcrossUpdate
  Invoke-FrontendBuildIfRequired -ChangedAcrossUpdate $changedAcrossUpdate

  Write-Step 'Pushing main only after successful rebase and checks'
  $outgoingAfterRebase = Get-GitLines -Explanation 'Recheck outgoing commits before deciding whether to push.' -Arguments @('log', '--oneline', 'origin/main..HEAD')
  if ($outgoingAfterRebase.Count) {
    Invoke-Git -Explanation 'Push verified main to origin with a normal push; force push is prohibited.' -Arguments @('push', $ExpectedRemoteName, $ExpectedBranch)
  } else {
    Write-Host 'No outgoing commits; push skipped.'
  }

  Restart-VerifiedBackendService
  Open-BadizoApplication

  Write-Step 'Final verification'
  if (!(Test-BackendHealth)) { throw 'Final backend health check failed.' }
  Invoke-Git -Explanation 'Show final working tree status after push and restart.' -Arguments @('status', '--short', '--branch')
  Invoke-Git -Explanation 'Show the latest three commits for final verification.' -Arguments @('log', '--oneline', '-3')
  Assert-NoConflicts
  $FinalReady = $true
} catch {
  Write-Host ''
  Write-Host 'ERROR:' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
} finally {
  Write-Host ''
  if ($FinalReady) {
    Write-Host 'BADIZO READY' -ForegroundColor Green
  } else {
    Write-Host 'BADIZO NOT READY - REVIEW REQUIRED' -ForegroundColor Red
  }
  Write-Host "Log: $LogFile"
  if ($TranscriptStarted) { Stop-Transcript | Out-Null }
  Write-Host ''
  Read-Host 'Press Enter to close this window' | Out-Null
}

if (!$FinalReady) { exit 1 }

