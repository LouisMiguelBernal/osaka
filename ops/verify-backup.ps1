<#
Proves a backup is restorable WITHOUT touching live data: restores the dump into a throwaway
database (osaka_restore_test), compares row counts with the manifest, checks file counts and the
dump checksum, then drops the throwaway database.

  powershell -ExecutionPolicy Bypass -File ops\verify-backup.ps1 [-Backup backups\<stamp>]   (default: newest)
#>
param([string]$Backup)

$Root = Split-Path $PSScriptRoot -Parent
if (-not $Backup) {
  $Backup = (Get-ChildItem (Join-Path $Root 'backups') -Directory | Where-Object Name -notlike '*FAILED' | Sort-Object Name -Descending | Select-Object -First 1).FullName
}
if (-not $Backup -or -not (Test-Path "$Backup\manifest.json")) { Write-Error "No backup with a manifest found."; exit 1 }
$m = Get-Content "$Backup\manifest.json" -Raw | ConvertFrom-Json
$fail = @()
$test = 'osaka_restore_test'

Write-Host "Verifying $Backup"
if ((Get-FileHash "$Backup\osaka.dump" -Algorithm SHA256).Hash -ne $m.files.dumpSha256) { $fail += 'dump checksum mismatch' }

docker exec -e PGOPTIONS="-c client_min_messages=warning" osaka-intake-db-1 psql -U postgres -qc "drop database if exists $test" | Out-Null
docker exec osaka-intake-db-1 psql -U postgres -qc "create database $test" | Out-Null
docker cp "$Backup\osaka.dump" osaka-intake-db-1:/tmp/verify.dump
docker exec osaka-intake-db-1 pg_restore -U postgres -d $test --no-owner /tmp/verify.dump
if ($LASTEXITCODE -ne 0) { $fail += "pg_restore exit $LASTEXITCODE" }

foreach ($p in $m.rowCounts.PSObject.Properties) {
  $n = [int](docker exec osaka-intake-db-1 psql -U postgres -d $test -tAc "select count(*) from $($p.Name)")
  $mark = if ($n -eq [int]$p.Value) { 'ok' } else { $fail += "$($p.Name): restored $n, expected $($p.Value)"; 'MISMATCH' }
  Write-Host ("  {0,-24} {1,6}  {2}" -f $p.Name, $n, $mark)
}
docker exec osaka-intake-db-1 rm -f /tmp/verify.dump | Out-Null
docker exec osaka-intake-db-1 psql -U postgres -qc "drop database $test" | Out-Null

$wf = @(Get-ChildItem "$Backup\n8n\workflows" -Filter *.json -ErrorAction SilentlyContinue).Count
if ($wf -ne $m.files.workflows -or $wf -lt 1) { $fail += "workflows: $wf files, manifest $($m.files.workflows)" }
foreach ($f in Get-ChildItem "$Backup\n8n\workflows" -Filter *.json -ErrorAction SilentlyContinue) {
  try { $null = Get-Content $f.FullName -Raw | ConvertFrom-Json } catch { $fail += "unreadable workflow $($f.Name)" }
}
$docs = @(Get-ChildItem "$Backup\storage" -Recurse -File -ErrorAction SilentlyContinue).Count
if ($docs -ne $m.files.storedDocuments) { $fail += "stored documents: $docs, manifest $($m.files.storedDocuments)" }
Write-Host ("  workflows {0}, credentials {1}, stored PDFs {2}" -f $wf, $m.files.credentials, $docs)

$liveModel = (ollama list | Select-String '^gemma4:e4b\s+(\S+)').Matches.Groups[1].Value
if ($liveModel -and $liveModel -ne $m.model.id) {
  Write-Warning "Model changed since this backup: backup $($m.model.id), now $liveModel. Re-check a few documents before trusting results."
}

if ($fail.Count) { Write-Host "VERIFY FAILED:`n - $($fail -join "`n - ")" -ForegroundColor Red; exit 1 }
Write-Host 'VERIFY PASSED: backup restores cleanly and matches its manifest.' -ForegroundColor Green
exit 0
