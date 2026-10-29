param(
 [Parameter(Mandatory=$true)][ValidatePattern('^[A-Fa-f0-9]{40}$')][string]$CertificateThumbprint,
 [string]$TimestampUrl = 'http://timestamp.digicert.com'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nativeRoot = Join-Path $projectRoot 'frontend\src-tauri'
$templates = Join-Path $nativeRoot 'windows\identity'
$output = Join-Path $projectRoot '.codex\windows-identity'
$certificate = Get-Item -LiteralPath ('Cert:\CurrentUser\My\'+$CertificateThumbprint) -ErrorAction Stop
if (-not $certificate.HasPrivateKey -or $certificate.NotAfter -le (Get-Date) -or $certificate.NotBefore -gt (Get-Date)) { throw 'A currently valid Windows code-signing certificate with a private key is required.' }
if ('1.3.6.1.5.5.7.3.3' -notin @($certificate.EnhancedKeyUsageList | ForEach-Object { [string]$_.ObjectId })) { throw 'The certificate does not permit code signing.' }
$chain = New-Object Security.Cryptography.X509Certificates.X509Chain
try { if (-not $chain.Build($certificate)) { throw 'Windows does not trust this signing certificate. No trust-store changes will be made.' } } finally { $chain.Dispose() }
$sdkRoot = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots').KitsRoot10
$sdk = Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'bin') -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'x64\makeappx.exe')) } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $sdk) { throw 'Windows SDK packaging tools are missing.' }
New-Item -ItemType Directory -Path (Join-Path $output 'package') -Force | Out-Null
$publisher = [Security.SecurityElement]::Escape($certificate.Subject)
foreach ($mapping in @(@('AppxManifest.xml','package\AppxManifest.xml'),@('application.manifest.xml','application.manifest.xml'))) {
 $source = Get-Content -LiteralPath (Join-Path $templates $mapping[0]) -Raw
 [IO.File]::WriteAllText((Join-Path $output $mapping[1]),$source.Replace('@@PUBLISHER@@',$publisher),[Text.UTF8Encoding]::new($false))
}
Copy-Item -LiteralPath (Join-Path $templates 'register.ps1') -Destination (Join-Path $output 'register.ps1') -Force
$scriptSignature = Set-AuthenticodeSignature -LiteralPath (Join-Path $output 'register.ps1') -Certificate $certificate -HashAlgorithm SHA256 -TimestampServer $TimestampUrl
if ($scriptSignature.Status -ne 'Valid') { throw 'Windows did not verify the signed identity registration helper.' }
Copy-Item -LiteralPath (Join-Path $templates 'installer-hooks.nsh') -Destination (Join-Path $output 'installer-hooks.nsh') -Force
Copy-Item -LiteralPath (Join-Path $nativeRoot 'icons\128x128.png') -Destination (Join-Path $output 'logo.png') -Force
$package = Join-Path $output 'Coherent.Identity.msix'
& (Join-Path $sdk.FullName 'x64\makeappx.exe') pack /o /d (Join-Path $output 'package') /nv /p $package *> (Join-Path $output 'pack.log')
if ($LASTEXITCODE -ne 0) { throw 'Identity package creation failed; see .codex/windows-identity/pack.log.' }
& (Join-Path $sdk.FullName 'x64\signtool.exe') sign /fd SHA256 /sha1 $CertificateThumbprint /tr $TimestampUrl /td SHA256 $package *> (Join-Path $output 'sign.log')
if ($LASTEXITCODE -ne 0) { throw 'Identity signing failed; see .codex/windows-identity/sign.log.' }
& (Join-Path $sdk.FullName 'x64\signtool.exe') verify /pa $package *> (Join-Path $output 'verify.log')
if ($LASTEXITCODE -ne 0 -or (Get-AuthenticodeSignature -LiteralPath $package).Status -ne 'Valid') { throw 'Windows did not verify the signed identity package.' }
$resources = @{}
foreach ($name in @('Coherent.Identity.msix','register.ps1','logo.png')) { $resources[(Join-Path $output $name)]='windows-identity/'+$name }
$config = @{bundle=@{resources=$resources;windows=@{certificateThumbprint=$CertificateThumbprint;digestAlgorithm='sha256';timestampUrl=$TimestampUrl;tsp=$true;nsis=@{installerHooks=(Join-Path $output 'installer-hooks.nsh')}}}}
$configPath = Join-Path $output 'tauri.identity.json'
[IO.File]::WriteAllText($configPath,($config | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
[pscustomobject]@{ManifestPath=(Join-Path $output 'application.manifest.xml');ConfigPath=$configPath;PackagePath=$package;Publisher=$certificate.Subject}
