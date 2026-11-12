param([ValidateRange(1, 65535)][int]$Port = 4175)
& (Join-Path $PSScriptRoot 'start-windows.ps1') -Port $Port -Stop
exit $LASTEXITCODE
