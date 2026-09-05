param([string]$InstallRoot = 'C:\BadizoPOS')
$ErrorActionPreference = 'Stop'
function Set-EnvValue([string]$Path,[string]$Name,[string]$Value) {
  $content = if (Test-Path -LiteralPath $Path) { [IO.File]::ReadAllText($Path) } else { '' }
  $line = "$Name=$Value"
  if ([regex]::IsMatch($content, "(?m)^$([regex]::Escape($Name))=.*$")) {
    $content = [regex]::Replace($content, "(?m)^$([regex]::Escape($Name))=.*$", $line)
  } else {
    if ($content -and !$content.EndsWith([Environment]::NewLine)) { $content += [Environment]::NewLine }
    $content += $line + [Environment]::NewLine
  }
  [IO.File]::WriteAllText($Path,$content,(New-Object System.Text.UTF8Encoding($false)))
}
try {
  $backend = Join-Path $InstallRoot 'backend'
  $envPath = Join-Path $backend '.env'
  $node = Join-Path $InstallRoot 'runtime\node.exe'
  $oauth = Join-Path $backend 'scripts\googleDriveOAuth.js'
  foreach($required in @($envPath,$node,$oauth)){if(!(Test-Path -LiteralPath $required)){throw "Missing installed file: $required"}}
  Write-Host 'Badizo Google Drive backup setup' -ForegroundColor Cyan
  Write-Host 'Create a Google OAuth Desktop App and Drive folder first. See the PDF guide.'
  $clientId = Read-Host 'Google OAuth Client ID'
  $secretSecure = Read-Host 'Google OAuth Client Secret' -AsSecureString
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secretSecure)
  try{$clientSecret=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
  $folderId = Read-Host 'Google Drive Folder ID'
  if(!$clientId -or !$clientSecret -or !$folderId){throw 'Client ID, Client Secret, and Folder ID are required.'}
  Set-EnvValue $envPath 'GOOGLE_DRIVE_CLIENT_ID' $clientId.Trim()
  Set-EnvValue $envPath 'GOOGLE_DRIVE_CLIENT_SECRET' $clientSecret.Trim()
  Set-EnvValue $envPath 'GOOGLE_DRIVE_BACKUP_FOLDER_ID' $folderId.Trim()
  Set-EnvValue $envPath 'GOOGLE_DRIVE_BACKUP_ENABLED' 'true'
  Set-EnvValue $envPath 'GOOGLE_DRIVE_BACKUP_KEEP_COUNT' '3'
  Set-EnvValue $envPath 'GOOGLE_DRIVE_RETRY_MINUTES' '10'
  Push-Location $backend
  & $node $oauth
  $code=$LASTEXITCODE
  Pop-Location
  if($code -ne 0){throw 'Google authorization did not complete.'}
  Restart-ScheduledTask -TaskName 'Badizo POS Backend' -ErrorAction Stop
  Write-Host 'Google Drive backup enabled. Offline backups retry when internet returns.' -ForegroundColor Green
  Write-Host 'The Badizo popup reports successful or pending cloud backup.' -ForegroundColor Green
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
Read-Host 'Press Enter to close' | Out-Null