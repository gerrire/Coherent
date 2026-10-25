param(
    [string]$Notes = 'Обновление Coherent для Windows.'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot 'frontend\src-tauri\tauri.conf.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$version = [string]$config.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
    throw "Invalid desktop version: $version"
}

$frontendPackage = Get-Content -LiteralPath (Join-Path $projectRoot 'frontend\package.json') -Raw | ConvertFrom-Json
# Windows PowerShell cannot convert npm's empty root-package key to an object.
# Rename that key only in the in-memory copy; keep the actual lock file intact.
$frontendLockJson = Get-Content -LiteralPath (Join-Path $projectRoot 'frontend\package-lock.json') -Raw
$frontendLock = ($frontendLockJson -replace '(?m)^(\s*)"":\s*\{', '$1"__coherent_root_package": {') | ConvertFrom-Json
$cargoPackage = Get-Content -LiteralPath (Join-Path $projectRoot 'frontend\src-tauri\Cargo.toml') -Raw
$cargoLock = Get-Content -LiteralPath (Join-Path $projectRoot 'frontend\src-tauri\Cargo.lock') -Raw
$cargoVersion = [regex]::Match($cargoPackage, '(?ms)^\[package\]\s.*?^version = "([^"]+)"').Groups[1].Value
$cargoLockVersion = [regex]::Match($cargoLock, '(?m)^name = "coherent-desktop"\r?\nversion = "([^"]+)"').Groups[1].Value
if ($frontendPackage.version -ne $version -or $frontendLock.version -ne $version -or $frontendLock.packages.__coherent_root_package.version -ne $version -or $cargoVersion -ne $version -or $cargoLockVersion -ne $version) {
    throw 'The desktop version differs between Tauri, Cargo and frontend manifests. Update all package and lock files before publishing.'
}

$bundle = Join-Path $projectRoot 'frontend\src-tauri\target\release\bundle\nsis'
$installerName = "Coherent_${version}_x64-setup.exe"
$installer = Join-Path $bundle $installerName
if (-not (Test-Path -LiteralPath $installer)) {
    $installerName = 'Coherent-setup.exe'
    $installer = Join-Path $bundle $installerName
}
$signatureFile = "$installer.sig"
if (-not (Test-Path -LiteralPath $installer) -or -not (Test-Path -LiteralPath $signatureFile)) {
    throw 'Build the signed desktop installer first: .\scripts\build-desktop.ps1'
}

$signature = (Get-Content -LiteralPath $signatureFile -Raw).Trim()
if (-not $signature) { throw 'The updater signature is empty.' }
$tag = "desktop-v$version"
$downloadUrl = "https://github.com/gerrire/Coherent/releases/download/$tag/$installerName"
$manifest = [ordered]@{
    version = $version
    notes = $Notes
    pub_date = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    platforms = [ordered]@{
        'windows-x86_64' = [ordered]@{
            signature = $signature
            url = $downloadUrl
        }
    }
}
$manifestPath = Join-Path $bundle 'latest.json'
$json = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($manifestPath, $json + "`n", [System.Text.UTF8Encoding]::new($false))

Write-Host "Release tag: $tag"
Write-Host "Installer: $installer"
Write-Host "Updater manifest: $manifestPath"
Write-Host 'Attach both the installer and latest.json to a non-prerelease GitHub Release with this tag.'
