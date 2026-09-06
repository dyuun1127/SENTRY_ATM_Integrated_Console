# Stop only the two exact processes recorded by run_public_demo.ps1.
[CmdletBinding()]
param([string]$StateFile)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$backendRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$logRoot = [IO.Path]::GetFullPath((Join-Path $backendRoot 'logs\gev-public'))
if (-not $StateFile) {
    if (-not (Test-Path -LiteralPath $logRoot -PathType Container)) { throw 'No public-demo process records exist.' }
    $latest = Get-ChildItem -LiteralPath $logRoot -Filter 'public-processes.json' -File -Recurse |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $latest) { throw 'No public-demo process record was found. Pass -StateFile for the exact run.' }
    $StateFile = $latest.FullName
}
$statePath = (Resolve-Path -LiteralPath $StateFile).Path
$allowedPrefix = $logRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $statePath.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The ownership record must be under this backend's logs\gev-public directory: $logRoot"
}
$runState = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($runState.schemaVersion -ne 1 -or $runState.kind -ne 'sentry-public-demo') {
    throw 'This is not a supported SENTRY public-demo ownership record.'
}
function Save-State {
    $runState | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding UTF8
}
function Verified-Process($Record, [string]$Role) {
    if (-not $Record) { return $null }
    $processId = [int]$Record.pid
    if ($processId -le 0) { throw "Invalid process ID for $Role." }
    $processInfo = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $processInfo) { $Record.status = 'already-exited'; return $null }
    $expectedExe = [IO.Path]::GetFullPath([string]$Record.executable)
    $actualExe = [IO.Path]::GetFullPath([string]$processInfo.Path)
    $actualTicks = $processInfo.StartTime.ToUniversalTime().Ticks
    $expectedTicks = [long]::Parse([string]$Record.startedAtUtcTicks, [Globalization.CultureInfo]::InvariantCulture)
    $timestampTicks = if ($Record.startedAtUtc -is [DateTime]) {
        $Record.startedAtUtc.ToUniversalTime().Ticks
    } else {
        [DateTime]::Parse([string]$Record.startedAtUtc, [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime().Ticks
    }
    if (-not $actualExe.Equals($expectedExe, [StringComparison]::OrdinalIgnoreCase) -or
        $actualTicks -ne $expectedTicks -or $timestampTicks -ne $expectedTicks) {
        $Record.status = 'ownership-mismatch'
        Save-State
        throw "Ownership mismatch for $Role PID $processId. No action taken on this process."
    }
    $expectedName = if ($Role -eq 'gateway') { 'node.exe' } else { 'cloudflared.exe' }
    if (-not [IO.Path]::GetFileName($expectedExe).Equals($expectedName, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unexpected executable for $Role. No process was stopped."
    }
    return $processInfo
}
# Validate every surviving process before stopping either. A recycled PID cannot
# redirect the stop operation to someone else's backend, frontend, or tunnel.
$verified = @{}
foreach ($role in @('tunnel', 'gateway')) {
    $verified[$role] = Verified-Process $runState.$role $role
}
foreach ($role in @('tunnel', 'gateway')) {
    if (-not $verified[$role]) { continue }
    # Recheck immediately before the stop; do not terminate by process name or tree.
    $current = Verified-Process $runState.$role $role
    if ($current) {
        Stop-Process -InputObject $current -ErrorAction Stop
        if (-not $current.WaitForExit(5000)) { throw "$role did not exit within 5 seconds." }
        $runState.$role.status = 'stopped'
    }
    Save-State
}
$runState.status = 'stopped'
$runState | Add-Member -NotePropertyName stoppedAtUtc -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
Save-State
Write-Host "Public gateway and tunnel stopped. Local frontend/backend were not changed. Record: $statePath"
