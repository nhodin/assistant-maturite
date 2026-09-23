# Assemble the Home Assistant local add-on folder.
#
# HA builds a local add-on from its own folder, so the folder must hold the
# Dockerfile AND the sources it copies. This script builds that folder in
# deploy/out/maturity_analyzer, and optionally copies it to the HA "local_apps"
# share (Samba add-on).
#
# First install:
#   .\deploy\package-addon.ps1 -Destination \\192.168.1.200\local_apps
# Update (bumps the patch version in ha-addon/config.yaml first - HA only
# offers the update when the version changes):
#   .\deploy\package-addon.ps1 -Bump -Destination \\192.168.1.200\local_apps
#
# Then in HA: Parametres -> Applications -> Installer une application ->
# menu (3 points) -> Rechercher des mises a jour. See deploy/README.md.
param(
  [string]$Destination,
  [switch]$Bump
)

$ErrorActionPreference = "Stop"
$app = Split-Path -Parent $PSScriptRoot
$out = Join-Path $PSScriptRoot "out\maturity_analyzer"
$config = Join-Path $PSScriptRoot "ha-addon\config.yaml"

if ($Bump) {
  $yaml = [IO.File]::ReadAllText($config)
  $m = [regex]::Match($yaml, 'version: "(\d+)\.(\d+)\.(\d+)"')
  if (-not $m.Success) { throw "No version found in $config" }
  $old = "$($m.Groups[1].Value).$($m.Groups[2].Value).$($m.Groups[3].Value)"
  $new = "$($m.Groups[1].Value).$($m.Groups[2].Value).$([int]$m.Groups[3].Value + 1)"
  $yaml = $yaml.Replace("version: `"$old`"", "version: `"$new`"")
  [IO.File]::WriteAllText($config, $yaml, (New-Object Text.UTF8Encoding $false))
  Write-Host "Version $old -> $new"
}

if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force "$out\deploy", "$out\data" | Out-Null

Copy-Item "$PSScriptRoot\ha-addon\*" $out
Copy-Item "$app\Dockerfile", "$app\.dockerignore", "$app\package.json", "$app\package-lock.json", "$app\tsconfig.json" $out
Copy-Item "$PSScriptRoot\docker-entrypoint.sh" "$out\deploy\"
Copy-Item "$app\data\*.csv" "$out\data\"
Copy-Item -Recurse "$app\prisma", "$app\src" $out

$version = [regex]::Match([IO.File]::ReadAllText($config), 'version: "([^"]+)"').Groups[1].Value
Write-Host "Add-on $version assembled in $out"

if ($Destination) {
  $target = Join-Path $Destination "maturity_analyzer"
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Copy-Item -Recurse $out $target
  Write-Host "Copied to $target"
}
