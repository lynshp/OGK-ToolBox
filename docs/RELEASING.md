# Releasing

Electron + NSIS is the only shipped desktop client. Release builds include the resource API, the supplied
C# controller Host, and the Node IO4 provider with its runtime dependencies.

1. Install .NET 10 SDK and Node.js 24 on Windows x64.
2. Run `tools/Get-Vgmstream.ps1` to obtain the pinned audio decoder.
3. Run `tools/Build-Release.ps1`. Version defaults to the Electron package version.
4. Verify the installed application and relevant device workflows using the checks below.
5. To publish, explicitly run `tools/Build-Release.ps1 -Publish` with GitHub CLI installed and authenticated.

The build runs application tests, locked npm install, controller artifact validation, Electron tests,
typechecking and installer generation. It checks the packaged API runtime and exact controller files.
The supplied Host bundle version must match the app; use a compatible maintainer-supplied bundle when
updating the app version. Do not bypass compatibility checks by changing metadata alone.

`src/OGKToolBox.Electron/resources/controller/artifact.json` records the required SHA-256 hashes.
The Host and its accompanying files are included in the installer. `build:main` also compiles the IO4
provider and copies the SDK runtime into `dist-electron/sdk`. Packaging keeps the provider entry point,
driver, SDK runtime and required HID dependencies accessible outside ASAR.

After generating a Windows directory build, run the packaged controller check from
`src/OGKToolBox.Electron` (CI runs the same check):

```powershell
$env:OGK_CONTROLLER_PACKAGED_DIR = (Resolve-Path '../../artifacts/electron/win-unpacked').Path
node tests/controller-packaged.cjs
```

This loads the packaged native HID binding without opening devices, then substitutes an empty device
list to check the provider handshake, commands, crash recovery and shutdown. It also verifies that the
bundled Host executable is unchanged. It does not exercise the NSIS installer or real hardware.

Before publishing a controller change, verify the installed layout:

- The supplied Host can start, report a snapshot and stop.
- The IO4 provider can load `node-hid` from its installed location and exit cleanly without a device.
- An explicit `OGK_CONTROLLER_MODULE_DIR` starts only that external provider; clearing it restores
  bundled backend selection.
- An online selection is retained when another backend becomes available; manual selection routes the
  displayed state and commands to the intended backend.
- Backend switching proceeds only after the previous running provider confirms input release with
  `Verified`; a rejected, unconfirmed or timed-out release keeps the previous selection.
- With applicable real hardware, input, disconnect/reconnect, mode writes, persistence and readback behave
  correctly. Record hardware and firmware details separately from simulator results.

Passing parser, mock-device or process tests does not establish real-device compatibility. A successful
development launch also does not verify ASAR layout or native dependency loading in the installer.

Published releases go to `lynshp/OGKToolBox-releases` and contain an installer, its `.blockmap`, and
`latest.yml`. Their filenames and SHA-512 metadata must match. The publishing script never deletes an
existing release. A `v*` source tag triggers the release workflow; CI uses the `RELEASES_GITHUB_TOKEN`
secret for the releases repository. Secret values must never be embedded in source or artifacts.

User profiles, game indexes, local logs, private development directories, and history backups are not
release inputs. Bundled third-party files retain their own license terms; see `THIRD-PARTY-NOTICES.md`.

## Update channels and troubleshooting

Settings → About has one GitHub source selector: Automatic (default), FastGithub, GH-Proxy,
and native GitHub. The preference applies to version checks, installers, Option packages and Mods.
Old two-selector preferences reset to Automatic on migration. Each application check re-probes the
three sources concurrently in isolated sessions. Automatic uses the first successfully validated source
immediately; remaining diagnostics finish in the background without switching an active download.
Manual mode waits only for the selected source. Stale results from previous checks are ignored. The same
source is used for its version check and installer download; failed version checks can fall back only
in Automatic mode. Manual selections are respected. Subsequent package requests prefer the detected
source and can fall back in Automatic mode before returning a response stream.

GH-Proxy reads the fixed `releases/latest/download/latest.yml` URL, so discovering the latest version
does not require knowing a tag. It probes the five nodes (gh-proxy.org, v4.gh-proxy.org,
v6.gh-proxy.org, cdn.gh-proxy.org, axisnow.gh-proxy.org), validates the version manifest and installer
file header, returns the first valid node without waiting for slower nodes, and uses the selected node as an electron-updater generic feed for both metadata and
installer. It also forwards public raw manifests and Release API requests for Option and Mod downloads.
Authenticated requests are excluded from GH-Proxy. A node responding to ping alone is insufficient.
The asset hash from the manifest remains enforced. No silent full-download restart occurs after
transmission has begun. Option and Mod failures link directly to these shared settings.

The diagnostics field includes timestamps, the route, failed phase, HTTP/network error and metadata
endpoint. Tokens and signed URL query strings are redacted. Users can select and copy this field when
reporting problems, or join group 827579852 to obtain updates.

Application updates use a full installer download with hash verification. Both startup checks and manual checks automatically download
an available update, then show the restart/later dialog after successful verification. Choosing later
keeps the restart/install button available without repeatedly prompting for the same version.
Differential download is disabled to avoid reconstruction failure silently restarting a full download after progress reaches
100%. Progress remains below 100% until verification succeeds. An installer download/verification
failure stops with diagnostics; the user can select another route and retry. Checking and downloading
share one operation lock so repeated IPC/UI requests cannot start overlapping operations. Existing
validated installer caching remains managed by electron-updater.

After building, `node tests/update-ui.electron.cjs` checks the actual About UI with an isolated profile
and mocked network state. `npm test` includes route selection, timeout, fallback, concurrency,
verification-failure and session-isolation tests. These do not establish connectivity on a user's network.

### Opt-in live frontend download check

After building, run `node tests/live-download.electron.cjs` with a prepared directory bundle at
`artifacts/update-review/win-unpacked`, or set `OGK_LIVE_RESOURCES` to its resources directory.
This test makes real public network requests and can download a complete installer. It uses a fresh
`artifacts/live-download-*` profile, cache and empty game directory, retaining a JSON report and screenshot.
It clicks the actual Option single/batch, Mod and About update buttons, then runs production IPC,
streaming, hash verification and package installation. Only the two smallest manifest entries are exposed
for bounded package sampling; library/hardware state is simulated and the installed version is represented
as 1.1.7 to exercise the update path. The restart dialog callback is recorded and answered Later;
the installer and downloaded Mod code are never executed. This is not full installer/hardware acceptance.

Set `OGK_LIVE_PACKAGES_ONLY=1` to omit the app update, `OGK_LIVE_APP_ONLY=1` to omit package actions,
or `OGK_LIVE_QUERY_SOURCE=fastgithub`, `ghproxy`, `github` or `auto` to exercise the unified source. The default is native GitHub; the old asset-source argument no longer changes routing. A successful small-asset probe does not guarantee sustained throughput.

### FastGithub verification

The embedded process requires its DataRoot to exist before launch. Its TLS response may contain only
the leaf certificate, without Electron's `issuerCert` field. Both GitHub sessions therefore verify the
leaf's signature against the CA read from this process's profile, along with the allowed hostname,
certificate hostname, validity periods and CA constraint. An issuer name alone never grants trust.
No CA is installed into the OS trust store and system proxy settings are not changed.

`node tests/fastgithub-live.electron.cjs` uses a fresh profile and the same prepared resources directory
as the frontend live test. It verifies raw manifest, Release API, latest.yml and a pinned small asset
through the actual proxy, including body format and SHA-256. Windows sandbox accounts may fail in
FastGithub's native PFX key loading; use a normal user session for live TLS acceptance. Tests use public
certificate-only fixtures; no CA private key belongs in source control.
