# Windows Task Manager attribution

The system Task Manager is the acceptance surface. A resource panel inside Coherent does not fix attribution in Windows.

## Observed on 29 October 2026

Windows 11 25H2, build 26200.9711; Evergreen WebView2 156.0.4314.50; installed Coherent 0.1.10.

Task Manager was restarted and its Processes list sorted by Name. The Coherent application row still reported only approximately 8.5 MB, while its owned WebView2 processes were listed elsewhere. The browser process was a direct child of Coherent, with the correct `--webview-exe-name=coherent-desktop.exe` and version. Early `SetCurrentProcessExplicitAppUserModelID` is already present and does not resolve this on the tested system.

Two isolated C++/Win32 probes were built with the official Microsoft.Web.WebView2 SDK 1.0.4314.35, using a normal native window, an explicit AppUserModelID, a private data folder, and offline HTML. One used ordinary process creation; the other assigned the host to a Windows Job Object before starting WebView2. Both application rows showed only approximately 2.4 MB rather than including their WebView2 children. The probe windows were closed after comparison. Replacing Rust with C++ or adding a Job Object is therefore not a demonstrated fix.

A third probe with a sparse MSIX identity package succeeded after the owner explicitly approved temporary registration and certificate trust in LocalMachine/TrustedPeople. Task Manager displayed **Coherent Identity Probe (7)** with approximately 97–99 MB total private resident memory. Expanding it showed the native host, renderer, GPU, network, storage, browser manager and crashpad in the same group. Reading the package family from all seven owned PIDs independently confirmed the same family on every process. The unpackaged native host had previously appeared alone at approximately 2.4 MB.

The first registration attempt using CurrentUser/TrustedPeople failed with `0x800B0109`. Its trust entry was removed. The successful elevated test was limited to five minutes and cleaned up immediately after inspection: the test window was closed, the identity package unregistered, and the machine trust entry removed. The temporary signing key and user certificates were also removed. All cleanup conditions were checked. Installed Coherent 0.1.10 was not replaced or re-registered.

## Boundaries

- Do not rename, patch, inject into or replace the shared Microsoft WebView2 runtime.
- Do not disable sandboxing or fake the host's RAM consumption.
- Do not distribute a self-signed certificate as a silent trust-store modification.
- The probe confirms package identity fixes attribution on this machine. Do not claim the full Coherent migration is validated until its installed-client regression and updater tests pass.
- Keep the installed 0.1.10 intact for the owner's requested next-update test. A candidate may run from a separate test directory; it must not replace the installed client manually.

## Certificate-free inspection of the installed client

The owner subsequently accepted separate process rows instead of package grouping and ruled out obtaining a Windows signing certificate. Package identity remains optional; it is not required for Windows to enumerate the runtime processes or measure their CPU and memory.

The actual installed, unpackaged 0.1.10 was launched without replacing its executable. A fresh OS process snapshot found the native host plus seven WebView2 descendants (browser, crashpad, GPU, network, storage, renderer and audio). The owner opened Task Manager's **Details** tab and filtered by `msedgeweb`; a screenshot then showed all seven matching PIDs alongside a different application's seven WebView2 processes. This directly verifies visibility in Task Manager on the owner's machine, rather than extrapolating from the earlier probe.

The Details tab's current column selection did not show a memory-total column. Its narrow `Дель…` column showed mostly zero values; those must not be interpreted as the processes' total memory. Enable a memory working-set column and **Command line** for inspection. Most owned runtime rows contain `--webview-exe-name=coherent-desktop.exe`; the crashpad helper instead carries the client's `com.coherent.desktop` data-folder path. PIDs change after restarting the client, so compare a current snapshot or the client's process list.

After the owner enabled the columns, a second screenshot verified nonzero working-set, private-working-set and committed-memory values for all seven owned WebView2 rows. A simultaneous OS snapshot confirmed their ownership had not changed. The command-line column is enabled, although its current width truncates the identifying arguments. This completes installed-client visibility/resource inspection in Task Manager without Windows certificate trust, package registration or a client update. It does not fix the Processes-tab group name or provide an automatic aggregate there.

Filtering by `coherent` does not reliably find these rows: Task Manager's search field advertises name, publisher and PID, while their executable remains Microsoft's `msedgewebview2.exe`. Do not claim a renamed runtime or a repaired Processes-tab association. Neither has been implemented. A Windows signature is unnecessary for the verified Details-tab inspection.

**Acceptance remains unmet:** the owner explicitly rejected Details-tab/PID inspection as a product solution. The requirement is recognizable, resource-bearing entries on the ordinary **Processes** tab without a production signing certificate. The friend's system reportedly shows those entries for an older client, likely 0.1.6, on an unspecified custom Windows build; its exact OS/runtime versions are not known.

Comparison against 0.1.6 identified the later explicit process AUMID call as a testable difference. An additional offline native probe omitted that call; on the owner's Windows it still appeared on Processes with only about 2.4 MB for the host. This rules out removing that call as a demonstrated solution; it does not prove all differences from the older client have been tested. Installed client metadata is correctly named Coherent, its Start-menu AUMID is `com.coherent.desktop`, and the Evergreen runtime's Microsoft signature is valid. No production Task Manager fix is delivered by 0.1.11.

## References

- [Microsoft WebView2 issue 5628](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5628)
- [Tauri issue 15567](https://github.com/tauri-apps/tauri/issues/15567)
- [Microsoft WebView2 FAQ](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/end-user-faq)
- [Microsoft identity package guidance](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/grant-identity-to-nonpackaged-apps)

## Candidate build integration

`scripts/build-desktop.ps1 -WindowsSigningCertificateThumbprint <thumbprint>` prepares a trusted, signed sparse identity package and supplies the matching executable manifest to the native build. The certificate must already be in CurrentUser/My, have a private key and code-signing usage, and chain to a Windows-trusted authority. Preparation never creates or imports a certificate. The registration helper and both native executable/NSIS installer are signed with that certificate; existing Minisign updater signing remains separate and unchanged.

The NSIS pre-install hook registers the verified package before replacing application files; a registration failure aborts before file replacement. The uninstall hook removes the matching registration. Registration refuses unsigned/untrusted packages, publisher mismatches and identities attached to another installation directory. The identity package has an independent version, so ordinary app updates do not require changing its identity. Microphone, webcam, network and capture capabilities are declared for the existing app functions. Actual user consent remains necessary where Windows requires it.

Native startup preserves the OS-assigned packaged AppUserModelID and uses the existing explicit ID for unpackaged clients. The manifest keeps Common Controls v6, ordinary user privileges and unvirtualized Win32 resources, avoiding a deliberate move of the existing profile or native feature implementation.

The integration is opt-in and is **not released or installed**. Validation so far covers native compilation/tests, Windows SDK acceptance of the manifests, NSIS compilation of the hooks and failure on a missing signing certificate. Trusted signing, registration/uninstallation with the real client, media/profile/notification regression, and the actual 0.1.10-to-next-version in-app update/restart remain required.

## Current delivery dependency

The owner confirmed there is no production Windows code-signing certificate/service available. Public distribution of this identity-enabled candidate therefore remains blocked on a suitable trusted signing provider. The existing Minisign updater key is not an Authenticode/MSIX certificate. No new desktop release should imply that the installed app's Task Manager grouping is already fixed.

Microsoft's unsigned-package switch is explicitly intended for testing, not wide distribution; it is not used as a substitute for production signing. A self-signed test certificate must not be silently added to users' trust stores.
