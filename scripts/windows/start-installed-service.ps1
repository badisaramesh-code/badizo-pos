$ErrorActionPreference = 'Stop'
try {
    $service = Get-Service -Name 'BadizoServer' -ErrorAction Stop
    if ($service.Status -ne 'Running') {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            $child = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"')) -Wait -PassThru
            exit $child.ExitCode
        }
        Start-Service -Name 'BadizoServer'
    }
    for ($attempt = 1; $attempt -le 40; $attempt++) {
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:5000/api/health' -TimeoutSec 3
            if ($health.ok -eq $true) {
                Write-Host 'Badizo server is running. Open the Badizo desktop app on the counters.' -ForegroundColor Green
                $profile = Get-NetConnectionProfile -InterfaceAlias 'Ethernet' -ErrorAction SilentlyContinue
                if ($profile.NetworkCategory -eq 'Public') {
                    Write-Warning 'Ethernet is Public. The Badizo Shop LAN Boot Check may need to run again.'
                }
                exit 0
            }
        } catch { }
        Start-Sleep -Seconds 3
    }
    throw 'Badizo did not become ready. Check backend\logs\service.err.log.'
} catch {
    Write-Host ('Badizo startup check failed: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
