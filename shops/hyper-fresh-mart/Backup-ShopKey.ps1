# Run interactively on the original shop PC. Requires Git for Windows with GnuPG.
# The passphrase goes into the GnuPG dialog only. Keep it in an off-PC vault.
$ErrorActionPreference = 'Stop'
$gpg = Join-Path $env:ProgramFiles 'Git/usr/bin/gpg.exe'
$key = Join-Path $env:LOCALAPPDATA 'BadizoCloudConnection/HFM001/shop-server.private'
$out = Join-Path $PSScriptRoot 'shop-server.private.gpg'
if (!(Test-Path -LiteralPath $key) -or (Test-Path -LiteralPath $out)) { throw 'Missing shop key or backup already exists.' }
$tmp = "$out.$([guid]::NewGuid()).partial"
try {
    & $gpg --no-symkey-cache --s2k-mode 3 --s2k-count 65011712 --cipher-algo AES256 --output $tmp --symmetric $key
    if ($LASTEXITCODE -ne 0) { throw 'Encryption did not complete.' }
    # Compare without printing or writing decrypted material.
    $check = & $gpg --no-symkey-cache --decrypt $tmp
    if ($LASTEXITCODE -ne 0 -or $check -cne (Get-Content -LiteralPath $key -Raw).Trim()) { throw 'Recovery verification failed.' }
    [IO.File]::Move($tmp, $out)
    Write-Output 'Encrypted key verified. Commit only shop-server.private.gpg to the recovery branch.'
} finally {
    Remove-Variable check -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp }
}
