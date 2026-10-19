<#
Nightly job (Windows Task Scheduler "OSAKA nightly backup", 02:00): backup, then verify the new backup.
Log: backups\nightly.log (appended; last 2000 lines kept). Exit code 0 only if both steps pass.
Docker Desktop is started and awaited if it is not running (the task runs in your user session).
#>
$Root = Split-Path $PSScriptRoot -Parent
$log = Join-Path $Root 'backups\nightly.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
function Log([string]$m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Add-Content -Encoding utf8 $log }

Log '=== nightly start'
docker version --format '{{.Server.Version}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Log 'Docker not running; starting Docker Desktop'
  Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
  for ($i = 0; $i -lt 60; $i++) { Start-Sleep 5; docker version --format '{{.Server.Version}}' 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { break } }
  if ($LASTEXITCODE -ne 0) { Log 'FAILED: Docker did not start within 5 minutes'; exit 1 }
  Push-Location (Join-Path $Root 'n8n'); docker compose up -d 2>&1 | Out-Null; Pop-Location
  for ($i = 0; $i -lt 24; $i++) { Start-Sleep 5; if ((docker inspect osaka-intake-db-1 --format '{{.State.Health.Status}}' 2>$null) -eq 'healthy') { break } }
}

$out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'backup.ps1') 2>&1
$backupExit = $LASTEXITCODE
$out | ForEach-Object { Log "  backup: $_" }
if ($backupExit -ne 0) { Log "FAILED: backup exit $backupExit"; exit 1 }

$out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'verify-backup.ps1') 2>&1
$verifyExit = $LASTEXITCODE
$out | ForEach-Object { Log "  verify: $_" }
if ($verifyExit -ne 0) { Log "FAILED: verify exit $verifyExit"; exit 1 }

Log '=== nightly OK'
$lines = Get-Content $log
if ($lines.Count -gt 2000) { $lines | Select-Object -Last 2000 | Set-Content -Encoding utf8 $log }
exit 0
