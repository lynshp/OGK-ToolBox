# Architecture

Electron is the only maintained desktop client. The deprecated WPF project remains compile-compatible only.

## Resource service

Electron Main starts the self-contained .NET API on loopback with a random per-process session token.
Application services handle scanning, configuration, resource access, backups and exports. The renderer
uses typed IPC and does not receive the API session token. Game data stays in the selected installation.

## Controller binary boundary

Development and packaged builds both launch the supplied `OGKToolBox.ControllerHost.exe` as a separate,
supervised process. The executable, compatibility manifest, checksums and license live under
`src/OGKToolBox.Electron/resources/controller`. No controller source project or Git submodule is compiled.

Electron validates module compatibility and the ready/health handshake before exposing controller state.
It releases virtual keys on focus loss and shutdown, restarts a failed process, and stops the controller
before installing an application update. A controller failure does not prevent resource browsing.

SimGEKI and IO4-compatible HID input is implemented directly in the Electron main process under
`electron/simgeki-io4-controller.ts`. `electron/controller-hub.ts` combines that reader with the legacy
controller process without routing SimGEKI through the deprecated provider SDK.

Public integration code describes application operations and typed snapshots only. Device wire formats,
firmware, calibration algorithms and hardware documentation are maintained separately and are not part of
this source distribution. The controller binary uses a separate proprietary license.

## Packaging

CI builds/tests .NET application code, verifies controller artifact hashes, tests/type-checks/builds Electron,
and packages the precompiled controller plus the API runtime. Checksums prevent accidental mismatches;
they are not a code-signing identity or a mechanism to prohibit source forks.

An application update replaces the installed application components together. User indexes, caches and
backups in game directories remain separate. Runtime code does not fetch or compile private sources.
