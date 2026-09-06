[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$FrontendPort = 8781,
    [ValidateRange(1, 65535)][int]$BackendPort = 8782,
    [ValidateSet('sortie', 'golden')][string]$Scenario = 'sortie',
    [ValidateSet('local', 'any')][string]$Control = 'local'
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'sentry-gev-v2\tools\run_gev_demo.ps1') `
    -FrontendPort $FrontendPort -BackendPort $BackendPort -Scenario $Scenario -Control $Control
