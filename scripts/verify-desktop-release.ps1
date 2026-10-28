param(
    [string]$BundleDirectory,
    [string]$VerifierExecutable
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nativeRoot = Join-Path $projectRoot 'frontend\src-tauri'
$config = Get-Content -LiteralPath (Join-Path $nativeRoot 'tauri.conf.json') -Raw | ConvertFrom-Json
$version = [string]$config.version
$bundle = if ($BundleDirectory) { [IO.Path]::GetFullPath($BundleDirectory) } else { Join-Path $nativeRoot 'target\release\bundle\nsis' }
$localInstaller = Join-Path $bundle 'Coherent-setup.exe'
if (-not (Test-Path -LiteralPath $localInstaller)) { $localInstaller = Join-Path $bundle "Coherent_${version}_x64-setup.exe" }
if (-not (Test-Path -LiteralPath $localInstaller) -or -not (Test-Path -LiteralPath "$localInstaller.sig")) { throw 'Local signed installer is required for comparison' }
$expectedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $localInstaller).Hash
$expectedSignature = (Get-Content -LiteralPath "$localInstaller.sig" -Raw).Trim()
$expectedPrefix = "https://github.com/gerrire/Coherent/releases/download/desktop-v$version/"
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('coherent-update-check-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temporary) | Out-Null
try {
    foreach ($endpoint in $config.plugins.updater.endpoints) {
        if ([string]$endpoint -match '\{\{') { throw 'This verifier requires a static updater endpoint' }
        $manifest = Invoke-RestMethod -Uri $endpoint -Headers @{ 'Cache-Control' = 'no-cache'; 'User-Agent' = 'Coherent-Updater-Verification' } -TimeoutSec 45
        if ($manifest.version -ne $version) { throw "Public updater offers $($manifest.version), expected $version" }
        $platform = $manifest.platforms.'windows-x86_64'
        if (-not $platform -or -not ([string]$platform.url).StartsWith($expectedPrefix, [StringComparison]::Ordinal)) { throw 'Updater points outside this versioned desktop release' }
        if ($platform.signature -ne $expectedSignature) { throw 'Public updater signature differs from the verified local package' }
        $download = Join-Path $temporary 'Coherent-setup.exe'
        Invoke-WebRequest -Uri $platform.url -OutFile $download -Headers @{ 'Cache-Control' = 'no-cache'; 'User-Agent' = 'Coherent-Updater-Verification' } -TimeoutSec 90
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash -ne $expectedHash) { throw 'Public installer bytes differ from the local build' }
        [IO.File]::WriteAllText("$download.sig", [string]$platform.signature, [Text.UTF8Encoding]::new($false))
        Push-Location $nativeRoot
        try {
            if ($VerifierExecutable) {
                & $VerifierExecutable $download
            } else {
                cargo run --release --locked --features tauri/custom-protocol --example verify_desktop_update -- $download
            }
            if ($LASTEXITCODE -ne 0) { throw 'Downloaded updater signature or signed version verification failed' }
        } finally { Pop-Location }
        Write-Host "Public update channel verified: $version (windows-x86_64)"
    }
    if (-not $config.plugins.updater.endpoints.Count) { throw 'No application updater endpoint is configured' }
} finally {
    # Only the exact files created by this verification are removed.
    foreach ($name in @('Coherent-setup.exe', 'Coherent-setup.exe.sig')) {
        $path = Join-Path $temporary $name
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
    }
    [IO.Directory]::Delete($temporary)
}
