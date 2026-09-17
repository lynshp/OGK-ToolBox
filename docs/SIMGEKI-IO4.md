# SimGEKI / IO4 communication

The maintained Electron client reads SimGEKI and IO4-compatible controllers directly through `node-hid`.
This path does not use the deprecated controller-provider SDK.

## Device matching

| Device mode | VID:PID | HID collection |
| --- | --- | --- |
| SimGEKI native | `8088:0101` | Gamepad: Usage Page `01`, Usage `04` |
| IO4-compatible | `0CA3:0021` | Gamepad: Usage Page `01`, Usage `04` |
| SimGEKI configuration | `8088:0101` | Vendor: Usage Page `FF00` |

Other gamepads are deliberately ignored. Controllers compatible with this integration should expose the
standard IO4 identity rather than requiring their real VID/PID to be added speculatively.

## IO4 input report

Input report ID is `01`. Offsets below are relative to the payload after the report ID.

| Offset | Size | Meaning |
| --- | --- | --- |
| `0` | 2 | Roller/lever, unsigned 16-bit little-endian; center is `8000` |
| `24..27` | 4 | Coin state/count pairs (not currently exposed in the common controller snapshot) |
| `28..33` | 6 | Button matrix |

Button bits are mapped in `electron/simgeki-io4-controller.ts`. Left Side and Right Side are active-low;
the other mapped inputs are active-high. The lever is inverted and scaled into the UI's `0..1023` range.

## SimGEKI configuration report

Configuration uses report ID `AA` with a 63-byte payload. Payload byte 1 is the command, byte 2 of a
response is success (`01`), and payload byte 3 carries the mode for get/set operations.

| Command | Value | Purpose |
| --- | --- | --- |
| `01` | none | Read input mode |
| `02` | payload byte 3 | Set input mode |
| `81` | none | Persist current configuration |

Modes are `1 = IO4 compatible`, `2 = DLL input`, and `3 = simulated keyboard`. A mode change is shown as
verified only after set, persist, and readback all succeed. The vendor protocol is never sent to a generic
`0CA3:0021` IO4 device.

Protocol behavior was independently implemented with the public
[SimGEKI-WebControl](https://github.com/SimDevices-Project/SimGEKI-WebControl) project at commit
`35000a4680e93a933fc0a58c7194ec04f1d5f47d` as a reference; no source file from that AGPL-3.0 project is
bundled in OGKToolBox.
