<#
OSAKA backup: database + n8n workflows/credentials + stored PDFs + manifest.

  powershell -ExecutionPolicy Bypass -File ops\backup.ps1 [-Keep 14]

Output: backups\<yyyyMMdd-HHmmss>\
  osaka.dump        pg_dump custom format (restore with ops\restore.ps1)
  n8n\workflows\    one JSON per workflow
  n8n\credentials\  one JSON per credential, still ENCRYPTED with N8N_ENCRYPTION_KEY
  storage\          the PDFs the app received
  manifest.json     versions, row counts, checksums (used by ops\verify-backup.ps1)

NOT included, on purpose: .env files. Credentials and encrypted DB fields can only be restored with the
same N8N_ENCRYPTION_KEY / FIELD_ENCRYPTION_KEY, so keep a copy of n8n\.env and app\.env.local
somewhere safe (password manager or encrypted drive), separately from these backups.
#>
param([int]$Keep = 14)

$Root = Split-Path $PSScriptRoot -Parent
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest = Join-Path $Root "backups\$stamp"
New-Item -ItemType Directory -Force $dest | Out-Null

function Step([string]$name, [scriptblock]$run, [switch]$Optional) {
  Write-Host "-> $name"
  & $run
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    if ($Optional) { Write-Warning "$name skipped (exit $LASTEXITCODE)"; $global:LASTEXITCODE = 0; return }
    throw "$name failed (exit $LASTEXITCODE)"
  }
}

try {
  Step 'Database dump' {
    docker exec osaka-intake-db-1 pg_dump -U postgres -d osaka -Fc -f /tmp/osaka.dump
    if ($LASTEXITCODE -eq 0) { docker cp osaka-intake-db-1:/tmp/osaka.dump "$dest\osaka.dump" }
    docker exec osaka-intake-db-1 rm -f /tmp/osaka.dump | Out-Null
  }

  Step 'n8n workflows' {
    docker exec osaka-intake-n8n-1 sh -c 'rm -rf /tmp/osaka-bk && mkdir -p /tmp/osaka-bk/workflows /tmp/osaka-bk/credentials && n8n export:workflow --all --separate --output=/tmp/osaka-bk/workflows' | Out-Null
  }
  Step 'n8n credentials (encrypted)' -Optional {
    docker exec osaka-intake-n8n-1 n8n export:credentials --all --separate --output=/tmp/osaka-bk/credentials | Out-Null
  }
  Step 'Copy n8n export' { docker cp osaka-intake-n8n-1:/tmp/osaka-bk/. "$dest\n8n" }

  $storage = Join-Path $Root 'app\storage'
  if (Test-Path $storage) {
    Write-Host '-> Stored PDFs'
    robocopy $storage "$dest\storage" /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE)" }
    $global:LASTEXITCODE = 0
  }

  Write-Host '-> Manifest'
  $tables = 'clients', 'documents', 'extractions', 'records'
  $counts = [ordered]@{}
  foreach ($t in $tables) { $counts[$t] = [int](docker exec osaka-intake-db-1 psql -U postgres -d osaka -tAc "select count(*) from $t") }
  $model = (ollama list | Select-String '^gemma4:e4b\s+(\S+)').Matches.Groups[1].Value
  $manifest = [ordered]@{
    createdAt      = (Get-Date).ToString('o')
    gitCommit      = ((git -C $Root rev-parse HEAD 2>$null) -join '')
    images         = [ordered]@{
      db  = (docker inspect osaka-intake-db-1 --format '{{.Image}}')
      n8n = (docker inspect osaka-intake-n8n-1 --format '{{.Image}}')
    }
    model          = [ordered]@{ name = 'gemma4:e4b'; id = $model }
    rowCounts      = $counts
    files          = [ordered]@{
      dumpSha256      = (Get-FileHash "$dest\osaka.dump" -Algorithm SHA256).Hash
      workflows       = @(Get-ChildItem "$dest\n8n\workflows" -Filter *.json -ErrorAction SilentlyContinue).Count
      credentials     = @(Get-ChildItem "$dest\n8n\credentials" -Filter *.json -ErrorAction SilentlyContinue).Count
      storedDocuments = @(Get-ChildItem "$dest\storage" -Recurse -File -ErrorAction SilentlyContinue).Count
    }
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 "$dest\manifest.json"

  # Retention: keep the newest $Keep backups.
  Get-ChildItem (Join-Path $Root 'backups') -Directory | Sort-Object Name -Descending | Select-Object -Skip $Keep |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -Confirm:$false }

  Write-Host "Backup OK: $dest"
  exit 0
} catch {
  Write-Error "Backup FAILED: $_"
  # A half-written backup must never be mistaken for a good one.
  Rename-Item $dest "$stamp-FAILED" -ErrorAction SilentlyContinue
  exit 1
}
