# SimGEKI / IO4 communication

The IO4 provider reads matching SimGEKI and IO4-compatible devices through `node-hid` in a separate
Node process. Electron Main supervises it through the same application API v1 used by other controller
providers; it does not open the HID device itself. The provider entry point is
`electron/providers/io4-provider.ts`, with device logic in `electron/simgeki-io4-controller.ts`.

The controller UI selects the active backend. An online selection is not displaced when another device
appears. `OGK_CONTROLLER_MODULE_DIR` selects an external provider exclusively, so the bundled IO4 reader
does not also open a device being tested by that provider. See [provider integration](CONTROLLER-PROVIDERS.md).

## Device matching

| Device mode | VID:PID | HID collection |
| --- | --- | --- |
| Production IO4-compatible identity | `0CA3:0021` | Gamepad: Usage Page `01`, Usage `04` |
| Debug IO4-compatible identity | `8088:0101` | Gamepad: Usage Page `01`, Usage `04` |
| SimGEKI configuration | Same as input collection | Vendor: Usage Page `FF00` |

Other gamepads are ignored. Both identifiers only discover an IO4-compatible input; neither identifies a
device as SimGEKI. When a vendor collection with the same VID, PID and (when available) serial number is
present, the provider queries the configuration protocol. Only a successful, valid mode readback promotes
the device identity to SimGEKI and exposes the three writable SimGEKI mode options.

The displayed controller name is read from the physical USB parent's localized
`DEVPKEY_Device_BusReportedDeviceDesc` string on Windows. The HID endpoint product string is deliberately
not used, so strings such as `I/O CONTROL BD;...` do not leak into the UI. Until that lookup completes or
when it is unavailable, the fallback name is `IO4 兼容控制器`.

The `SimGEKI` identity kind identifies configuration-protocol support, not the product brand. A firmware
name such as `MYGEKI` is preserved after the handshake. A failed name lookup keeps the IO4 fallback and
does not prevent verified mode settings. Other USB identities still require explicit discovery support.

## IO4 input report

Input report ID is `0x01`. Offsets below are relative to the payload after the report ID.

| Offset | Size | Meaning |
| --- | --- | --- |
| `0` | 2 | Roller/lever, unsigned 16-bit little-endian; center is `0x8000` |
| `24..27` | 4 | Coin state/count pairs (not currently exposed in the common controller snapshot) |
| `28..33` | 6 | Button matrix |

Button bits are mapped in `electron/simgeki-io4-controller.ts`. Left Side and Right Side are active-low;
the other mapped inputs are active-high. The lever is inverted and scaled into the UI's `0..1023` range.

## SimGEKI configuration report

Configuration uses report ID `AA` with a 63-byte payload. Payload byte 1 is the command and is echoed in
the response, payload byte 2 of a response is success (`01`), and payload byte 3 carries the mode for
get/set operations. Responses are matched to that echoed command so a delayed acknowledgement cannot be
mistaken for the following command's response.

| Command | Value | Purpose |
| --- | --- | --- |
| `01` | none | Read input mode |
| `02` | payload byte 3 | Set input mode |
| `81` | none | Persist current configuration |
| `A0` | none | Calibrate the roller's current position as center |

Modes are `1 = IO4 compatible`, `2 = DLL input`, and `3 = simulated keyboard`. A mode change is shown as
verified only after set, persist, and command-matched readback all succeed. Every recognized IO4 identity
may be probed for this configuration collection; devices that do not expose it or fail protocol validation
remain read-only IO4-compatible devices.

Only mode 1 emits the IO4 input reports used by the application's live monitor. In modes 2 and 3, a valid
configuration readback marks the controller ready without waiting for an IO4 input frame.

The SimGEKI joystick calibration action sends `A0` while the lever is centered, verifies its success
response, then sends `81` and verifies that the new center offset was persisted.

The application snapshot exposes supported modes through optional `inputModes` string IDs and labels.
This provider uses IDs `"1"`, `"2"` and `"3"` and maps the selected `input-mode` command to the device's
numeric values. Clients treat these IDs as opaque strings rather than applying that mapping to other
hardware. Other v1 providers, including the supplied C# Host, can continue using the existing boolean
`mode` command.

## Build and verification scope

`npm run build:main` compiles the provider into
`dist-electron/electron/providers/io4-provider.js` and includes the SDK runtime under `dist-electron/sdk`.
The Node entry, driver, SDK runtime and `node-hid` dependency must remain loadable in the installed layout.
Use the packaged application to verify native dependency loading as well as the development build.

Parser and fake-device tests check mappings and lifecycle paths without establishing hardware
compatibility. A functional release still needs real-device checks for input, reconnect, mode read/write
and readback. Do not infer support for every device advertising the IO4 IDs from simulated tests.

## Protocol reference

Protocol behavior was independently implemented with the public
[SimGEKI-WebControl](https://github.com/SimDevices-Project/SimGEKI-WebControl) project at commit
`35000a4680e93a933fc0a58c7194ec04f1d5f47d` as a reference; no source file from that AGPL-3.0 project is
bundled in OGKToolBox.

Configuration probing across both IO4 identities, command-response matching, center calibration and
DLL/keyboard readiness are adapted from [iamapig120's contribution](https://github.com/iamapig120/OGK-ToolBox/commit/c3a9e0476a68791830477e267a8b006d26fb0768).
