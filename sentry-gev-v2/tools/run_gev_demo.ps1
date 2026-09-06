# Requires Windows PowerShell 5.1 or PowerShell 7 on Windows.
[CmdletBinding()]
param(
    [string]$Python,
    [string]$FrontendRoot,
    [string]$NodeDirectory,
    [ValidateRange(1, 65535)][int]$FrontendPort = 8781,
    [ValidateRange(1, 65535)][int]$BackendPort = 8782,
    [ValidateSet('sortie', 'golden')][string]$Scenario = 'sortie',
    [ValidateSet('local', 'any')][string]$Control = 'local'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$backendRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Resolve-ExistingFile([string]$FilePath, [string]$Description) {
    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        throw "$Description not found: $FilePath"
    }
    return (Resolve-Path -LiteralPath $FilePath).Path
}

function Find-NodeWithNpm {
    $candidates = @(
        Get-Command node.exe -All -CommandType Application -ErrorAction SilentlyContinue |
            ForEach-Object { $_.Source }
        Join-Path $env:ProgramFiles 'nodejs\node.exe'
    )
    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        $candidateNpm = Join-Path (Split-Path $candidate -Parent) 'npm.cmd'
        if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and
            (Test-Path -LiteralPath $candidateNpm -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw 'A Node.js installation containing both node.exe and npm.cmd was not found. Install Node.js or pass -NodeDirectory.'
}

function Assert-PortAvailable([int]$Port) {
    $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    if (@($listeners | Where-Object { $_.Port -eq $Port }).Count -gt 0) {
        throw "Port $Port is already in use. No existing process was stopped. Choose different ports."
    }
    $probe = [Net.Sockets.Socket]::new(
        [Net.Sockets.AddressFamily]::InterNetwork,
        [Net.Sockets.SocketType]::Stream,
        [Net.Sockets.ProtocolType]::Tcp
    )
    try {
        $probe.ExclusiveAddressUse = $true
        $probe.Bind([Net.IPEndPoint]::new([Net.IPAddress]::Loopback, $Port))
    } catch {
        throw "Cannot bind 127.0.0.1:$Port. No existing process was stopped. $($_.Exception.Message)"
    } finally {
        $probe.Dispose()
    }
}

function Get-ProcessRecord($Process, [string]$Executable, [string]$WorkingDirectory,
    [string]$Url, [string]$Stdout, [string]$Stderr) {
    $Process.Refresh()
    if ($Process.HasExited) {
        throw "Process exited during startup. Inspect $Stderr"
    }
    return [ordered]@{
        pid = $Process.Id
        startedAtUtc = $Process.StartTime.ToUniversalTime().ToString('o')
        executable = $Executable
        workingDirectory = $WorkingDirectory
        url = $Url
        stdout = $Stdout
        stderr = $Stderr
    }
}

function Wait-LocalHttp($Process, [string]$Url, [string]$Stderr) {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) {
            throw "Process exited with code $($Process.ExitCode). Inspect $Stderr"
        }
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return }
        } catch {
            # Startup can precede binding; retry only this launch's loopback URL.
        }
        Start-Sleep -Milliseconds 300
    }
    throw "Startup timed out at $Url. Inspect $Stderr"
}

if ($FrontendPort -eq $BackendPort) { throw 'Frontend and backend ports must differ.' }
if (-not $Python) { $Python = Join-Path $backendRoot '.venv\Scripts\python.exe' }
$pythonExe = Resolve-ExistingFile $Python 'Python (create a local .venv or pass -Python)'
if (-not $FrontendRoot) {
    $FrontendRoot = Join-Path (Split-Path $backendRoot -Parent) 'sentry-gev-frontend'
}
$frontendPath = (Resolve-Path -LiteralPath $FrontendRoot).Path
$viteEntry = Resolve-ExistingFile (Join-Path $frontendPath 'node_modules\vite\bin\vite.js') `
    'Vite (run npm.cmd ci in the frontend checkout first)'

if ($NodeDirectory) {
    $nodeExe = Resolve-ExistingFile (Join-Path $NodeDirectory 'node.exe') 'Node.js'
} else {
    $nodeExe = Find-NodeWithNpm
}
$nodeFolder = Split-Path $nodeExe -Parent
$npmCmd = Resolve-ExistingFile (Join-Path $nodeFolder 'npm.cmd') 'npm'
$nodeVersionText = & $nodeExe -p 'process.versions.node'
if ($LASTEXITCODE -ne 0) { throw 'Cannot read the Node.js version.' }
$nodeVersion = [version]$nodeVersionText
if (-not (($nodeVersion.Major -eq 24 -and $nodeVersion -ge [version]'24.14.0') `
    -or $nodeVersion.Major -eq 26)) {
    throw "GOD's EYE requires Node.js 24.14.0+ within 24.x, or 26.x; found $nodeVersionText."
}

# Preflight both ports before starting either service. Child servers also refuse
# port reuse (the Python exclusive server and Vite --strictPort).
Assert-PortAvailable $FrontendPort
Assert-PortAvailable $BackendPort
$runName = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'), ([guid]::NewGuid().ToString('N').Substring(0, 6))
$runDirectory = Join-Path $backendRoot "logs\gev-demo\$runName"
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
$stateFile = Join-Path $runDirectory 'processes.json'
$backendUrl = "http://127.0.0.1:$BackendPort"
$frontendUrl = "http://127.0.0.1:$FrontendPort"
$demoUrl = "$frontendUrl/?sentry=1"
$runState = [ordered]@{
    schemaVersion = 1
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    status = 'starting'
    scenario = $Scenario
    control = $Control
    frontend = $null
    backend = $null
}
function Save-RunState {
    $runState | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $stateFile -Encoding UTF8
}

# These process-scoped values are restored even if startup fails. No .env,
# system PATH, other checkout, or API credentials are modified.
$environmentNames = @('PYTHONPATH', 'PYTHONNOUSERSITE', 'PYTHONUNBUFFERED',
    'SENTRY_BACKEND_URL', 'HOST', 'PORT', 'PATH', 'PSModulePath')
$savedEnvironment = @{}
foreach ($name in $environmentNames) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    $env:PYTHONPATH = Join-Path $backendRoot 'src'
    $env:PYTHONNOUSERSITE = '1'
    $env:PYTHONUNBUFFERED = '1'
    $backendOut = Join-Path $runDirectory 'backend.stdout.log'
    $backendErr = Join-Path $runDirectory 'backend.stderr.log'
    $backendProcess = Start-Process -FilePath $pythonExe `
        -ArgumentList @('-m', 'sentry_atm.infrastructure.http', '--host', '127.0.0.1',
            '--port', "$BackendPort", '--scenario', $Scenario, '--control', $Control) `
        -WorkingDirectory $backendRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $backendOut -RedirectStandardError $backendErr
    $runState.backend = Get-ProcessRecord $backendProcess $pythonExe $backendRoot `
        $backendUrl $backendOut $backendErr
    Save-RunState
    Wait-LocalHttp $backendProcess "$backendUrl/api/v1/reference/access" $backendErr

    $env:SENTRY_BACKEND_URL = $backendUrl
    $env:HOST = '127.0.0.1'
    $env:PORT = "$FrontendPort"
    $env:PATH = "$nodeFolder;$($savedEnvironment['PATH'])"
    # The upstream Windows credential hardener invokes Windows PowerShell 5.1.
    # Do not let a parent PowerShell 7 module path redirect its Get-Acl module.
    $env:PSModulePath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
    $frontendOut = Join-Path $runDirectory 'frontend.stdout.log'
    $frontendErr = Join-Path $runDirectory 'frontend.stderr.log'
    # Start Vite through node.exe directly so the recorded PID belongs to the
    # server, avoiding a cmd/npm wrapper and PowerShell execution-policy changes.
    $frontendProcess = Start-Process -FilePath $nodeExe `
        -ArgumentList @(('"{0}"' -f $viteEntry), '--host', '127.0.0.1',
            '--port', "$FrontendPort", '--strictPort') `
        -WorkingDirectory $frontendPath -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $frontendOut -RedirectStandardError $frontendErr
    $runState.frontend = Get-ProcessRecord $frontendProcess $nodeExe $frontendPath `
        $demoUrl $frontendOut $frontendErr
    Save-RunState
    Wait-LocalHttp $frontendProcess "$frontendUrl/" $frontendErr
    $runState.status = 'ready'
    Save-RunState
    Write-Host "GOD's EYE + SENTRY: $demoUrl"
    Write-Host "SENTRY V2 backend: $backendUrl"
    Write-Host "Process ownership and logs: $stateFile"
    Write-Host "npm available at: $npmCmd"
} catch {
    $runState.status = 'failed'
    $runState['error'] = $_.Exception.Message
    Save-RunState
    Write-Warning "Startup failed. Any processes already started by this launch are recorded in $stateFile. No process was terminated."
    throw
} finally {
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
}
