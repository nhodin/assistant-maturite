# Copy the data of the local (XAMPP, Windows) database to the target.
#
# Two ways to deliver it:
#   -ShareDir \\192.168.1.200\share   (HA add-on) drop the dump in
#       <share>\maturity-import\; the add-on imports it at its next start, and
#       only into an EMPTY database. No DB port to open, no DB password here.
#   -TargetHost/-TargetPassword       import directly over the network
#       (e.g. the local docker-compose test on port 3307).
#
# The schema is NOT dumped: the container creates it with `prisma db push`.
#
# Windows MariaDB stores table names in lower case (lower_case_table_names=1);
# Prisma on Linux creates them as the model names (RunPage...) and Linux is case
# sensitive, so the dump is rewritten to the Prisma names.
#
#   .\deploy\migrate-db.ps1 -ShareDir \\192.168.1.200\share
param(
  [string]$ShareDir,
  [string]$TargetHost,
  [int]$TargetPort = 3306,
  [string]$TargetUser = "maturite",
  [string]$TargetPassword,
  [string]$TargetDatabase = "maturite",
  [string]$SourceUser = "maturite",
  [string]$SourcePassword = "maturite",
  [string]$SourceDatabase = "maturite",
  [string]$MysqlBin = "C:\xampp\mysql\bin"
)

$ErrorActionPreference = "Stop"
if (-not $ShareDir -and -not $TargetHost) { throw "Pass -ShareDir or -TargetHost" }
$dump = Join-Path $PSScriptRoot "out\maturite-data.sql"
New-Item -ItemType Directory -Force (Split-Path $dump) | Out-Null

Write-Host "1/3 Dumping data of $SourceDatabase (local)..."
& "$MysqlBin\mysqldump.exe" -h 127.0.0.1 -u $SourceUser "-p$SourcePassword" `
  --no-create-info --complete-insert --skip-triggers --single-transaction `
  --hex-blob --default-character-set=utf8mb4 --net-buffer-length=1048576 `
  --result-file="$dump" $SourceDatabase
if ($LASTEXITCODE -ne 0) { throw "mysqldump failed" }

Write-Host "2/3 Renaming tables to the Prisma model names..."
$models = Select-String -Path (Join-Path $PSScriptRoot "..\prisma\schema.prisma") -Pattern '^model (\w+)' |
  ForEach-Object { $_.Matches[0].Groups[1].Value }
$sql = [IO.File]::ReadAllText($dump)
foreach ($m in $models) {
  $sql = $sql -creplace ('`' + $m.ToLower() + '`'), ('`' + $m + '`')
}
[IO.File]::WriteAllText($dump, $sql, (New-Object Text.UTF8Encoding $false))

if ($ShareDir) {
  $dir = Join-Path $ShareDir "maturity-import"
  New-Item -ItemType Directory -Force $dir | Out-Null
  Copy-Item $dump $dir -Force
  Remove-Item $dump
  Write-Host "3/3 Dump dropped in $dir - (re)start the add-on, check its log for 'import done',"
  Write-Host "    then delete that folder (it holds client data)."
  return
}

Write-Host "3/3 Importing into ${TargetHost}:$TargetPort/$TargetDatabase..."
& "$MysqlBin\mysql.exe" -h $TargetHost -P $TargetPort -u $TargetUser "-p$TargetPassword" `
  --default-character-set=utf8mb4 --max-allowed-packet=64M $TargetDatabase `
  -e "SET FOREIGN_KEY_CHECKS=0; source $($dump -replace '\\','/'); SET FOREIGN_KEY_CHECKS=1;"
if ($LASTEXITCODE -ne 0) { throw "import failed" }
Remove-Item $dump
Write-Host "Done."
