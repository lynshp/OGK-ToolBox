# License scope and binary components

The root MIT license applies to original OGKToolBox application source code. It does not relicense
third-party files or proprietary controller binaries merely because they are stored in this repository.

| Component | Terms |
| --- | --- |
| `src/OGKToolBox.Electron/resources/controller` | Proprietary precompiled module; see its `LICENSE.txt`. No controller source is included. |
| `src/OGKToolBox.Electron/resources/NYAGEKI_IO.dll` | Proprietary game IO component; see `NYAGEKI_IO.LICENSE.txt`. |
| FastGithub and dnscrypt-proxy | See the LICENSE files supplied under `assets/fastgithub`. |
| `node-hid` / `hidapi` | MIT/X11 and hidapi terms; license files are distributed with the packaged npm dependency. |
| BepInEx, Harmony, Mono.Cecil, MonoMod and other bundled dependencies | Retain their respective upstream licenses, copyright notices and attribution requirements. |
| Bundled game integration files, ICF, images and audio | Third-party works, excluded from the root MIT grant. The maintainer has confirmed redistribution of the supplied assets; this is not a grant to modify their third-party licenses. |

The proprietary controller and game IO binaries may be used with OGKToolBox, including local development
and testing. Other use or redistribution requires permission from their copyright holder. Independent
rights granted by third-party dependency licenses remain intact.

Precompiled modules are supplied to make the application buildable without disclosing private controller
implementation details. Do not add private controller sources, firmware, hardware documents, or local
source-history backups to this repository.
