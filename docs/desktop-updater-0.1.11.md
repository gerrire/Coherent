# Installed-client updater verification, 29 October 2026

The reserved next upgrade after 0.1.10 was exercised through the installed application's own UI, using the ordinary latest GitHub desktop release. The downloaded local installer was not launched separately, and the installed executable was not overwritten by a file operation.

- Source commit: `651f87483d39` on `windows-client`.
- Public release: https://github.com/gerrire/Coherent/releases/tag/desktop-v0.1.11
- Configured endpoint: https://github.com/gerrire/Coherent/releases/latest/download/latest.json
- Public installer SHA-256: `b9e9a5f8faf2bdc027bc653879b322465d8342fa6d9da64b870975c56740479b`.
- `scripts/verify-desktop-release.ps1` passed for the configured public endpoint: downloaded bytes, original Minisign key, signed package version and rejection of tampered bytes. All four public assets also matched the local artifacts.
- The running 0.1.10 client found 0.1.11, downloaded it and displayed that its signature was verified. Its **Install and restart** button installed the update. The old process exited and a new installed 0.1.11 process started automatically at approximately 22:22 Moscow time.
- The UI remained signed in to the same account and restored the same selected conversation and theme. SHA-256 comparisons confirmed unchanged `capture-borderless.json`, `desktop-settings.json`, `media-permissions.json` and `theme.json`.
- Installed executable SHA-256: `06ebf261482412f8b1c3a923b04441a9ed49311f928fb83bc06c7cb740b97bf1`. Startup diagnostics identify build `651f87483d39` and report `packaged: false`: no sparse package identity/certificate trust was introduced.

This validates an actual installed-client update/restart, not just a build or a public download. It does not validate accepting a real incoming call in the repaired popup, and it does not fix the outstanding Task Manager Processes-tab attribution issue. The popup fix was checked with frontend rendering/regressions and native request-policy tests; a second-device incoming-call test remains outstanding.
