param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$monitorRoot = $PSScriptRoot
$nodePath = (Get-Command node -ErrorAction Stop).Source
$runtimePath = Join-Path $monitorRoot 'data\runtime.json'
if (Test-Path -LiteralPath $runtimePath) {
    try {
        $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
        $address = 'http://127.0.0.1:' + $runtime.port
        $health = Invoke-RestMethod -Uri ($address + '/api/health') -TimeoutSec 2
        if ($health.app -eq 'kimi-usage-monitor' -and $health.pid -eq $runtime.pid) {
            if (-not $NoBrowser) { Start-Process $address }
            Write-Output $address
            exit 0
        }
    } catch { }
}
$dataDirectory = Join-Path $monitorRoot 'data'
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$monitorPath = Join-Path $monitorRoot 'monitor.cjs'
$monitorProcess = Start-Process -FilePath $nodePath -ArgumentList @(('"' + $monitorPath + '"'), '--serve') -WorkingDirectory $monitorRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDirectory 'monitor.stdout.log') -RedirectStandardError (Join-Path $dataDirectory 'monitor.stderr.log') -PassThru
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 1000
    if ($monitorProcess.HasExited) { throw ('Monitor stopped. See ' + (Join-Path $dataDirectory 'monitor.stderr.log')) }
    try {
        $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
        if ($runtime.pid -ne $monitorProcess.Id) { continue }
        $address = 'http://127.0.0.1:' + $runtime.port
        $health = Invoke-RestMethod -Uri ($address + '/api/health') -TimeoutSec 2
        if ($health.app -eq 'kimi-usage-monitor' -and $health.pid -eq $monitorProcess.Id) {
            if (-not $NoBrowser) { Start-Process $address }
            Write-Output $address
            exit 0
        }
    } catch { }
}
throw 'Monitor did not become ready within 30 seconds. Check data/monitor.stderr.log.'
