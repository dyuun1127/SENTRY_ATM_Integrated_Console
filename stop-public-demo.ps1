[CmdletBinding()]
param([string]$StateFile)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'sentry-gev-v2\tools\stop_public_demo.ps1') -StateFile $StateFile
