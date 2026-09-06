# Requires Windows PowerShell 5.1 or PowerShell 7 on Windows.
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$FrontendPort = 8781,
    [ValidateRange(1, 65535)][int]$BackendPort = 8782,
    [ValidateRange(1, 65535)][int]$GatewayPort = 8783,
    [ValidateSet('local', 'any')][string]$Control = 'local',
    [string]$FrontendRoot,
    [string]$Node,
    [string]$Cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$backendRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Resolve-RequiredFile([string]$FilePath, [string]$Description) {
    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        throw "$Description not found: $FilePath"
    }
    return (Resolve-Path -LiteralPath $FilePath).Path
}
function Assert-PortAvailable([int]$Port) {
    $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    if (@($listeners | Where-Object { $_.Port -eq $Port }).Count -gt 0) {
        throw "Port $Port is already in use. No existing process was stopped. Stop the owned public demo or choose -GatewayPort."
    }
    $probe = [Net.Sockets.Socket]::new([Net.Sockets.AddressFamily]::InterNetwork,
        [Net.Sockets.SocketType]::Stream, [Net.Sockets.ProtocolType]::Tcp)
    try {
        $probe.ExclusiveAddressUse = $true
        $probe.Bind([Net.IPEndPoint]::new([Net.IPAddress]::Loopback, $Port))
    } finally { $probe.Dispose() }
}
function Confirm-Http([string]$Url) {
    try { $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 4 }
    catch { throw "Required local service is unavailable at $Url. Start start-demo.ps1 first. $($_.Exception.Message)" }
    if ($response.StatusCode -ne 200) { throw "Expected HTTP 200 at $Url." }
}
function Process-Record($ProcessInfo, [string]$Executable, [string[]]$LaunchArguments,
    [string]$WorkingDirectory, [string]$Stdout, [string]$Stderr) {
    $ProcessInfo.Refresh()
    if ($ProcessInfo.HasExited) { throw "Process exited during startup. Inspect $Stderr" }
    return [ordered]@{
        pid = $ProcessInfo.Id
        executable = $Executable
        startedAtUtc = $ProcessInfo.StartTime.ToUniversalTime().ToString('o')
        startedAtUtcTicks = $ProcessInfo.StartTime.ToUniversalTime().Ticks.ToString()
        arguments = $LaunchArguments
        workingDirectory = $WorkingDirectory
        stdout = $Stdout
        stderr = $Stderr
        status = 'running'
    }
}
if (@($FrontendPort, $BackendPort, $GatewayPort | Select-Object -Unique).Count -ne 3) {
    throw 'Frontend, backend, and gateway ports must all differ.'
}
if (-not $FrontendRoot) { $FrontendRoot = Join-Path (Split-Path $backendRoot -Parent) 'sentry-gev-frontend' }
$frontendPath = (Resolve-Path -LiteralPath $FrontendRoot).Path
$gatewayScript = Resolve-RequiredFile (Join-Path $frontendPath 'scripts\sentry-public-gateway.mjs') 'Public gateway script'
$null = Resolve-RequiredFile (Join-Path $frontendPath 'dist\index.html') 'Frontend build (run npm.cmd run build first)'
$cloudflaredExe = Resolve-RequiredFile $Cloudflared 'cloudflared'
if (-not $Node) {
    $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($command) { $Node = $command.Source }
    else { $Node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
}
$nodeExe = Resolve-RequiredFile $Node 'Node.js'

# Do not load, rename, or rewrite an existing named-tunnel configuration.
$configurationRoots = @((Join-Path $env:USERPROFILE '.cloudflared'),
    (Join-Path $env:USERPROFILE '.cloudflare-warp'))
if ($env:ProgramData) { $configurationRoots += (Join-Path $env:ProgramData 'cloudflared') }
foreach ($configurationRoot in $configurationRoots) {
    foreach ($name in @('config.yml', 'config.yaml')) {
        $candidate = Join-Path $configurationRoot $name
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            throw "An existing cloudflared configuration was found at $candidate. It was not changed. Use a separate configuration-free environment for this temporary tunnel."
        }
    }
}
foreach ($name in @('TUNNEL_TOKEN', 'TUNNEL_TOKEN_FILE', 'TUNNEL_NAME', 'TUNNEL_HOSTNAME', 'TUNNEL_CRED_FILE')) {
    if ([Environment]::GetEnvironmentVariable($name, 'Process')) {
        throw "Existing named-tunnel environment option $name is set. It was not changed. Use a separate terminal without this option."
    }
}
Assert-PortAvailable $GatewayPort
$backendUrl = "http://127.0.0.1:$BackendPort"
$frontendUrl = "http://127.0.0.1:$FrontendPort"
$gatewayUrl = "http://127.0.0.1:$GatewayPort"
Confirm-Http "$frontendUrl/"
Confirm-Http "$backendUrl/api/v1/golden-demo/session"
$access = Invoke-RestMethod -Uri "$backendUrl/api/v1/reference/access" -TimeoutSec 4
if ($access.control -ne $Control) {
    throw "Backend control is '$($access.control)' but requested '$Control'. Stop the backend using its owned process record, then run start-demo.ps1 -Control $Control. This helper never restarts existing services."
}

$runName = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'), ([guid]::NewGuid().ToString('N').Substring(0, 6))
$runDirectory = Join-Path $backendRoot "logs\gev-public\$runName"
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
$stateFile = Join-Path $runDirectory 'public-processes.json'
$runState = [ordered]@{
    schemaVersion = 1
    kind = 'sentry-public-demo'
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    status = 'starting'
    control = $Control
    backendUrl = $backendUrl
    frontendUrl = $frontendUrl
    gatewayUrl = $gatewayUrl
    publicUrl = $null
    gateway = $null
    tunnel = $null
}
function Save-RunState {
    $runState | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $stateFile -Encoding UTF8
}
Save-RunState
try {
    $gatewayOut = Join-Path $runDirectory 'gateway.stdout.log'
    $gatewayErr = Join-Path $runDirectory 'gateway.stderr.log'
    $gatewayArguments = @($gatewayScript, '--port', "$GatewayPort", '--frontend-port', "$FrontendPort",
        '--backend-port', "$BackendPort", '--control', $Control)
    $gatewayLaunch = @{
        FilePath = $nodeExe
        ArgumentList = @(('"{0}"' -f $gatewayScript), '--port', "$GatewayPort", '--frontend-port', "$FrontendPort",
            '--backend-port', "$BackendPort", '--control', $Control)
        WorkingDirectory = $frontendPath
        WindowStyle = 'Hidden'
        PassThru = $true
        RedirectStandardOutput = $gatewayOut
        RedirectStandardError = $gatewayErr
    }
    $gatewayProcess = Start-Process @gatewayLaunch
    $runState.gateway = Process-Record $gatewayProcess $nodeExe $gatewayArguments $frontendPath $gatewayOut $gatewayErr
    Save-RunState
    $gatewayDeadline = [DateTime]::UtcNow.AddSeconds(20)
    $gatewayReady = $false
    while ([DateTime]::UtcNow -lt $gatewayDeadline) {
        $gatewayProcess.Refresh()
        if ($gatewayProcess.HasExited) { throw "Gateway exited. Inspect $gatewayErr" }
        try {
            $response = Invoke-WebRequest -Uri "$gatewayUrl/" -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { $gatewayReady = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
    if (-not $gatewayReady) { throw "Gateway did not become ready at $gatewayUrl/. Inspect $gatewayErr" }
    $tunnelOut = Join-Path $runDirectory 'tunnel.stdout.log'
    $tunnelErr = Join-Path $runDirectory 'tunnel.stderr.log'
    $tunnelArguments = @('tunnel', '--url', $gatewayUrl, '--protocol', 'http2', '--no-autoupdate', '--metrics', '127.0.0.1:0')
    $tunnelLaunch = @{
        FilePath = $cloudflaredExe
        ArgumentList = $tunnelArguments
        WorkingDirectory = $runDirectory
        WindowStyle = 'Hidden'
        PassThru = $true
        RedirectStandardOutput = $tunnelOut
        RedirectStandardError = $tunnelErr
    }
    $tunnelProcess = Start-Process @tunnelLaunch
    $runState.tunnel = Process-Record $tunnelProcess $cloudflaredExe $tunnelArguments $runDirectory $tunnelOut $tunnelErr
    Save-RunState
    Write-Host "Waiting up to 60 seconds for a temporary HTTPS address. Logs: $runDirectory"
    $tunnelDeadline = [DateTime]::UtcNow.AddSeconds(60)
    $registered = $false
    while ([DateTime]::UtcNow -lt $tunnelDeadline) {
        $tunnelProcess.Refresh()
        if ($tunnelProcess.HasExited) { throw "cloudflared exited. Inspect $tunnelErr" }
        $logText = ''
        foreach ($logFile in @($tunnelOut, $tunnelErr)) {
            if (Test-Path -LiteralPath $logFile) {
                $logText += [string](Get-Content -LiteralPath $logFile -Raw -ErrorAction SilentlyContinue)
            }
        }
        $match = [regex]::Match($logText, 'https://[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com')
        if ($match.Success) { $runState.publicUrl = $match.Value }
        $registered = $logText -match 'Registered tunnel connection'
        if ($runState.publicUrl -and $registered) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not ($runState.publicUrl -and $registered)) {
        throw "The temporary tunnel did not register within 60 seconds. Inspect $tunnelErr"
    }
    $runState.status = 'ready'
    Save-RunState
    Write-Host "SENTRY public demo: $($runState.publicUrl)/?sentry=1"
    Write-Host "Detailed console: $($runState.publicUrl)/console/"
    Write-Host "Scenario control: $($runState.publicUrl)/scenario"
    Write-Host "Control mode: $Control"
    Write-Host "Owned gateway/tunnel processes: $stateFile"
    Write-Host 'Stop the public gateway and tunnel with stop-public-demo.ps1. The original local servers remain running.'
} catch {
    $startupError = $_
    $runState.status = 'failed'
    $runState['error'] = $startupError.Exception.Message
    Save-RunState
    if ($runState.gateway -or $runState.tunnel) {
        try { & (Join-Path $PSScriptRoot 'stop_public_demo.ps1') -StateFile $stateFile }
        catch { Write-Warning "Automatic cleanup could not verify or stop a process. Run stop-public-demo.ps1 -StateFile '$stateFile'. $($_.Exception.Message)" }
    }
    throw $startupError
}
