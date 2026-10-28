# Windows delivery priority

The owner requires every delivered Windows release to be available through the application's built-in updater. A local installer alone does not complete a release request.

- Keep the existing updater signing key and signed-version checks compatible with installed clients.
- Publish the signed installer, signature, `latest.json` and checksums in an ordinary GitHub desktop release marked latest. Server deployment releases must never replace the desktop update channel.
- Before reporting delivery, verify the public endpoint configured in `frontend/src-tauri/tauri.conf.json`, download its Windows package and verify its bytes, signature and signed version. Use `scripts/verify-desktop-release.ps1`.
- State separately whether an actual update/restart inside an installed client was tested. Do not equate a successful build or download with an installed-client test.
- Keep Windows source changes on the `windows-client` branch. Routine web pushes should not automatically publish desktop releases.
