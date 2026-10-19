<#
Restores a backup over the LIVE OSAKA data. Destructive: the database is replaced by the backup.
Run ops\verify-backup.ps1 on the backup first.

  powershell -ExecutionPolicy Bypass -File ops\restore.ps1 -Backup backups\<stamp> -Force

Requires the same N8N_ENCRYPTION_KEY (n8n\.env) and FIELD_ENCRYPTION_KEY (app\.env.local)
that were in use when the backup was taken, or credentials / encrypted fields will not decrypt.
Stop the app (npm run dev) first so nothing writes during the restore.
#>
param([Parameter(Mandatory)][string]$Backup, [switch]$Force)

if (-not (Test-Path "$Backup\manifest.json")) { Write-Error "Not a backup folder: $Backup"; exit 1 }
if (-not $Force) { Write-Error "Refusing to overwrite live data without -Force."; exit 1 }
$Root = Split-Path $PSScriptRoot -Parent

Write-Host '-> Safety backup of current state'
& powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'backup.ps1')
if ($LASTEXITCODE -ne 0) { Write-Error 'Safety backup failed; nothing restored.'; exit 1 }

Write-Host '-> Database'
docker cp "$Backup\osaka.dump" osaka-intake-db-1:/tmp/restore.dump
docker exec osaka-intake-db-1 pg_restore -U postgres -d osaka --clean --if-exists --no-owner /tmp/restore.dump
$dbExit = $LASTEXITCODE
docker exec osaka-intake-db-1 rm -f /tmp/restore.dump | Out-Null
if ($dbExit -ne 0) { Write-Error "pg_restore failed (exit $dbExit)"; exit 1 }

Write-Host '-> n8n workflows and credentials'
docker exec osaka-intake-n8n-1 sh -c 'rm -rf /tmp/osaka-rs && mkdir -p /tmp/osaka-rs' | Out-Null
docker cp "$Backup\n8n\." osaka-intake-n8n-1:/tmp/osaka-rs
docker exec osaka-intake-n8n-1 n8n import:workflow --separate --input=/tmp/osaka-rs/workflows
if (@(Get-ChildItem "$Backup\n8n\credentials" -Filter *.json -ErrorAction SilentlyContinue).Count) {
  docker exec osaka-intake-n8n-1 n8n import:credentials --separate --input=/tmp/osaka-rs/credentials
}
docker restart osaka-intake-n8n-1 | Out-Null

if (Test-Path "$Backup\storage") {
  Write-Host '-> Stored PDFs'
  robocopy "$Backup\storage" (Join-Path $Root 'app\storage') /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Write-Error "robocopy failed (exit $LASTEXITCODE)"; exit 1 }
}

Write-Host "Restore complete from $Backup. Start the app again with: npm run dev -- --port 3030"
exit 0
