# Windows Task Manager attribution

The system Task Manager is the acceptance surface. A resource panel inside Coherent does not fix attribution in Windows.

## Observed on 29 October 2026

Windows 11 25H2, build 26200.9711; Evergreen WebView2 156.0.4314.50; installed Coherent 0.1.10.

Task Manager was restarted and its Processes list sorted by Name. The Coherent application row still reported only approximately 8.5 MB, while its owned WebView2 processes were listed elsewhere. The browser process was a direct child of Coherent, with the correct `--webview-exe-name=coherent-desktop.exe` and version. Early `SetCurrentProcessExplicitAppUserModelID` is already present and does not resolve this on the tested system.

Two isolated C++/Win32 probes were built with the official Microsoft.Web.WebView2 SDK 1.0.4314.35, using a normal native window, an explicit AppUserModelID, a private data folder, and offline HTML. One used ordinary process creation; the other assigned the host to a Windows Job Object before starting WebView2. Both application rows showed only approximately 2.4 MB rather than including their WebView2 children. The probe windows were closed after comparison. Replacing Rust with C++ or adding a Job Object is therefore not a demonstrated fix.

A third probe with a sparse MSIX identity package has been prepared locally. Its first registration attempt failed with `0x800B0109` despite trusting the test certificate in CurrentUser/TrustedPeople. That trust entry was removed on failure. A separate, explicitly approved elevated test is required before testing LocalMachine/TrustedPeople. No production certificate, package registration or runtime change should be inferred from this investigation.

## Boundaries

- Do not rename, patch, inject into or replace the shared Microsoft WebView2 runtime.
- Do not disable sandboxing or fake the host's RAM consumption.
- Do not distribute a self-signed certificate as a silent trust-store modification.
- Do not claim package identity fixes Task Manager until a native screenshot and process ownership checks confirm it.
- Keep the installed 0.1.10 intact for the owner's requested next-update test. A candidate may run from a separate test directory; it must not replace the installed client manually.

## References

- [Microsoft WebView2 issue 5628](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5628)
- [Tauri issue 15567](https://github.com/tauri-apps/tauri/issues/15567)
- [Microsoft WebView2 FAQ](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/end-user-faq)
- [Microsoft identity package guidance](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/grant-identity-to-nonpackaged-apps)

An identity package is a test direction, not yet an accepted solution. Public distribution would additionally require a suitable trusted code-signing certificate; the updater's existing Minisign key serves a different purpose and must remain unchanged.
