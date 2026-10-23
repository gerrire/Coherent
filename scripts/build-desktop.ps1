$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$frontend = Join-Path $projectRoot 'frontend'
$portableNode = Join-Path $projectRoot '.tools\node\node-v24.22.1-win-x64'
if (Test-Path -LiteralPath (Join-Path $portableNode 'npm.cmd')) {
    $env:PATH = "$portableNode;$env:PATH"
    $npm = Join-Path $portableNode 'npm.cmd'
} else {
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
}

$cargoDir = Join-Path $env:USERPROFILE '.cargo\bin'
$env:PATH = "$cargoDir;$env:PATH"
$key = Join-Path $env:USERPROFILE '.tauri\coherent.key'
$passwordFile = Join-Path $env:USERPROFILE '.tauri\coherent.key.password.dpapi'
if (-not (Test-Path -LiteralPath $key) -or -not (Test-Path -LiteralPath $passwordFile)) {
    throw 'Missing local updater signing key. See frontend/src-tauri/README.md.'
}

$secure = (Get-Content -LiteralPath $passwordFile -Raw).Trim() | ConvertTo-SecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $env:TAURI_SIGNING_PRIVATE_KEY = $key
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    Push-Location $frontend
    try {
        & $npm run tauri build
        if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}
