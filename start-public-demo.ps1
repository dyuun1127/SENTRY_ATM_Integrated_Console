[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$FrontendPort = 8781,
    [ValidateRange(1, 65535)][int]$BackendPort = 8782,
    [ValidateRange(1, 65535)][int]$GatewayPort = 8783,
    [ValidateSet('local', 'any')][string]$Control = 'local'
)
$ErrorActionPreference = 'Stop'
$options = @{ FrontendPort = $FrontendPort; BackendPort = $BackendPort; GatewayPort = $GatewayPort; Control = $Control }
& (Join-Path $PSScriptRoot 'sentry-gev-v2\tools\run_public_demo.ps1') @options
