$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$runtime = Get-Command node -ErrorAction SilentlyContinue
if (-not $runtime) {
    Write-Host 'Нужен Node.js 22 или новее. Установите его, затем запустите start.ps1 снова.'
    exit 1
}
& $runtime.Source (Join-Path $PSScriptRoot 'server.mjs')
