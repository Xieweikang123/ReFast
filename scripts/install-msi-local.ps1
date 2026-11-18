param(
  [Parameter(Mandatory = $true)]
  [string]$MsiPath
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $MsiPath)) {
  Write-Error "MSI not found: $MsiPath"
  exit 1
}

Get-Process -Name "re-fast" -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host ("Stopping PID {0}" -f $_.Id)
  Stop-Process -Id $_.Id -Force
}

Start-Sleep -Seconds 1

Write-Host ("Installing {0}" -f $MsiPath)
$p = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", $MsiPath, "/qn", "/norestart") -Wait -PassThru
Write-Host ("msiexec exit: {0}" -f $p.ExitCode)
exit $p.ExitCode
