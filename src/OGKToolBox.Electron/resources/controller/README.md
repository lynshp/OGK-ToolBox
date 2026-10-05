# Controller module

This directory contains the Windows x64 controller module for OGKToolBox 1.1.10.
The public desktop distribution launches `OGKToolBox.ControllerHost.exe` as a separate process.

- `OGKToolBox.ControllerHost.exe`: self-contained process rebuilt for this release from the pinned Core revision in `module.json`.
- `module.json`: application/module compatibility metadata for 1.1.10, using module API 1 and protocol 1.
- `artifact.json`: SHA-256 hashes of the executable and manifest.
- `LICENSE.txt`: component license terms.

This release incorporates device reconnect/state reset fixes, configuration readback tracking,
Leonardo input-report validation against HID descriptors and consecutive frames, and Pico brightness/control-packet handling.
Protocol and simulated transport checks do not establish real-hardware compatibility.

Run `npm run verify:controller` from the Electron project before development or packaging.
Checksums detect mismatched files; they are not digital signatures.
Module compatibility must be verified when updating release metadata.
