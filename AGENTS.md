# Windows delivery priority

The owner requires every delivered Windows release to be available through the application's built-in updater. A local installer alone does not complete a release request.

- Keep the existing updater signing key and signed-version checks compatible with installed clients.
- Publish the signed installer, signature, `latest.json` and checksums in an ordinary GitHub desktop release marked latest. Server deployment releases must never replace the desktop update channel.
- Before reporting delivery, verify the public endpoint configured in `frontend/src-tauri/tauri.conf.json`, download its Windows package and verify its bytes, signature and signed version. Use `scripts/verify-desktop-release.ps1`.
- State separately whether an actual update/restart inside an installed client was tested. Do not equate a successful build or download with an installed-client test.
- Keep Windows source changes on the `windows-client` branch. Routine web pushes should not automatically publish desktop releases.
- The owner's reserved end-to-end upgrade test was completed on 29 October 2026 from installed 0.1.10 to 0.1.11 through the running app: public download, signature verification, installation, restart, and session/settings restoration were observed. See docs/desktop-updater-0.1.11.md. Continue using the built-in updater for installed-client upgrades; do not overwrite the installed executable, downgrade the client, or substitute a local installer test.
- The owner reserved the 0.1.11-to-0.1.12 upgrade for their own assessment of seamless updating. Build, publish and verify the public channel, but do not initiate downloading, installation or restart in the installed client on their PC.
