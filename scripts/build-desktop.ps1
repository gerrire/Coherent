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
$originalKey = $env:TAURI_SIGNING_PRIVATE_KEY
$originalPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
$pointer = [IntPtr]::Zero
try {
    # CI supplies the original key through secrets. Local Windows builds use
    # the same key and a password encrypted for the current Windows account.
    if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
        $key = Join-Path $env:USERPROFILE '.tauri\coherent.key'
        $passwordFile = Join-Path $env:USERPROFILE '.tauri\coherent.key.password.dpapi'
        if (-not (Test-Path -LiteralPath $key)) {
            throw 'Set TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD, or restore ~/.tauri/coherent.key. See docs/desktop-signing.md.'
        }
        $env:TAURI_SIGNING_PRIVATE_KEY = $key
        if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
            if (-not (Test-Path -LiteralPath $passwordFile)) {
                throw 'The local signing password is missing. See docs/desktop-signing.md.'
            }
            $secure = (Get-Content -LiteralPath $passwordFile -Raw).Trim() | ConvertTo-SecureString
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        }
    }
    Push-Location $frontend
    try {
        & $npm run tauri build
        if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE" }
        & (Join-Path $PSScriptRoot 'clean-desktop-artifacts.ps1')
    } finally {
        Pop-Location
    }
} finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $env:TAURI_SIGNING_PRIVATE_KEY = $originalKey
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $originalPassword
}
