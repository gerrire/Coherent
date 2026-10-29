param(
 [Parameter(Mandatory=$true)][ValidateSet('Register','Unregister')][string]$Action,
 [Parameter(Mandatory=$true)][string]$InstallDirectory
)
$ErrorActionPreference = 'Stop'
try {
 $installRoot = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
 if (-not [IO.Path]::IsPathRooted($InstallDirectory)) { throw 'An absolute installation directory is required.' }
 $packagePath = Join-Path $PSScriptRoot 'Coherent.Identity.msix'
 # Never add trust, enable developer mode, or install an unsigned identity.
 $signature = Get-AuthenticodeSignature -LiteralPath $packagePath
 if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) { throw 'The identity package requires a Windows-trusted signature.' }
 Add-Type -AssemblyName System.IO.Compression.FileSystem
 $zip = [IO.Compression.ZipFile]::OpenRead($packagePath)
 try {
  $entry = $zip.GetEntry('AppxManifest.xml')
  if (-not $entry -or $entry.Length -gt 65536) { throw 'Invalid identity manifest.' }
  $settings = New-Object Xml.XmlReaderSettings
  $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
  $reader = [Xml.XmlReader]::Create($entry.Open(), $settings)
  try { $manifest = New-Object Xml.XmlDocument; $manifest.XmlResolver=$null; $manifest.Load($reader) } finally { $reader.Dispose() }
 } finally { $zip.Dispose() }
 $identity = $manifest.DocumentElement.Identity
 if ($identity.Name -ne 'Coherent.Desktop' -or $identity.Publisher -ne $signature.SignerCertificate.Subject) { throw 'Identity publisher/name mismatch.' }
 [Windows.Management.Deployment.PackageManager,Windows.Management.Deployment,ContentType=WindowsRuntime] | Out-Null
 $manager = New-Object Windows.Management.Deployment.PackageManager
 $existing = @(Get-AppxPackage -Name Coherent.Desktop | Where-Object { $_.Publisher -eq $identity.Publisher })
 foreach ($registered in $existing) {
  $package = $manager.FindPackageForUser('', $registered.PackageFullName)
  $registeredRoot = $package.EffectiveExternalPath
  if (-not $registeredRoot -or [IO.Path]::GetFullPath($registeredRoot).TrimEnd('\') -ne $installRoot) { throw 'The identity is registered to a different installation directory.' }
 }
 if ($Action -eq 'Unregister') {
  foreach ($registered in $existing) { Remove-AppxPackage -Package $registered.PackageFullName -ErrorAction Stop }
 } elseif ($existing.Count -eq 0) {
  Add-AppxPackage -Path $packagePath -ExternalLocation $installRoot -ErrorAction Stop
 } elseif ($existing.Count -ne 1 -or [version]$existing[0].Version -ne [version]$identity.Version) {
  throw 'Unexpected identity package version. A deliberate identity migration is required.'
 }
 Write-Output "Coherent identity: $Action completed."
 exit 0
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
