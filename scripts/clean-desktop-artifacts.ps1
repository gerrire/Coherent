$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$bundleRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'frontend\src-tauri\target\release\bundle\nsis'))
if (-not $bundleRoot.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Bundle directory is outside this project' }
$config = Get-Content -LiteralPath (Join-Path $projectRoot 'frontend\src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$version = [string]$config.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Invalid package metadata' }
$built = Join-Path $bundleRoot "Coherent_${version}_x64-setup.exe"
$latest = Join-Path $bundleRoot 'Coherent-setup.exe'
if (Test-Path -LiteralPath $built) {
    if (-not (Test-Path -LiteralPath "$built.sig")) { throw 'The new installer has no updater signature' }
    Move-Item -LiteralPath $built -Destination $latest -Force
    Move-Item -LiteralPath "$built.sig" -Destination "$latest.sig" -Force
}
if (-not (Test-Path -LiteralPath $latest) -or -not (Test-Path -LiteralPath "$latest.sig")) { throw 'No complete signed local installer exists' }
foreach ($entry in Get-ChildItem -LiteralPath $bundleRoot -File) {
    if ($entry.DirectoryName -ne $bundleRoot) { throw 'Unexpected artifact path' }
    if ($entry.Name -match '^Coherent_\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?_x64-setup\.exe(?:\.sig)?$' -or $entry.Name -eq 'latest.json') {
        Remove-Item -LiteralPath $entry.FullName
    }
}
Write-Host "Local signed installer: $latest"
