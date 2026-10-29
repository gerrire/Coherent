# Windows delivery priority

The owner requires every delivered Windows release to be available through the application's built-in updater. A local installer alone does not complete a release request.

- Keep the existing updater signing key and signed-version checks compatible with installed clients.
- Publish the signed installer, signature, `latest.json` and checksums in an ordinary GitHub desktop release marked latest. Server deployment releases must never replace the desktop update channel.
- Before reporting delivery, verify the public endpoint configured in `frontend/src-tauri/tauri.conf.json`, download its Windows package and verify its bytes, signature and signed version. Use `scripts/verify-desktop-release.ps1`.
- State separately whether an actual update/restart inside an installed client was tested. Do not equate a successful build or download with an installed-client test.
- Keep Windows source changes on the `windows-client` branch. Routine web pushes should not automatically publish desktop releases.
- The owner has reserved the next installed-client upgrade after 0.1.10 for an end-to-end built-in updater test. Do not manually install that upgrade, overwrite the installed executable, downgrade the client, or substitute a local installer test. Keep the installed 0.1.10 until the signed public update is ready, then exercise download, verification, installation, restart, and session/settings restoration through the running app.
