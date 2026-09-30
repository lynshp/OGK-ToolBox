# Local player capture

`PlayerCapture.cs` is a BepInEx 5 / Harmony 2 plugin for the Unity Mono game. It observes six core read responses (`GetUserData/Music/Card/Character/Item/Option`) and optional `GetUserActivity` responses (module 1.0.3) and writes local records under `Tools/OGKToolBox/player-data/captures`. The module does not send requests, change game responses, disable encryption, or write server data. The Electron page installs it only when the user enables capture and the game is stopped. Stopping capture removes the enable marker; existing archives remain.

Build on Windows with the local game available (commercial assemblies are build references only and are never copied):

```powershell
powershell -NoProfile -File scripts/build-player-capture.ps1 -GameRoot <package-directory>
```

This uses the Windows .NET Framework compiler with `/noconfig /nostdlib+`, the game's Mono BCL reference assemblies, and the existing bundled BepInEx/Harmony references, and produces `resources/player-capture/OGKToolBox.PlayerCapture.dll`. The Unity 5 game uses the .NET 2.0/3.5 API surface; desktop .NET 4 defaults compile successfully but fail at runtime (for example, multi-argument `Path.Combine`). Rebuild this artifact whenever the source changes. The Electron builder includes only this self-authored plugin from that directory, not game assemblies.

The module reports initialization, read errors, and successful responses in `capture-status.txt`, with a five-second heartbeat. The UI expires connection status after twenty seconds without a heartbeat and preserves initialization failures for diagnosis. Diagnostics contain exception type names only, not player data. If no status file appears, check both `BepInEx/LogOutput.log` and `mu3_Data/output_log.txt`: BepInEx recognizing the plugin does not prove Unity successfully invoked its initialization.

The initial adapter was checked against local game 1.50 metadata. Other versions fail with a capture status if the hook signatures do not match. Compilation and synthetic tests do not establish live-game compatibility.

Outside-game reads have two connection sources:

- `player-bootstrap.ts` reads each user's server and keychip from `segatools.ini` on every fetch (`dns.default`, optional `dns.AimeDB`, and `keychip.id`). ALL.Net PowerOn discovers the API endpoint, AimeDB lookup v2 resolves the existing card's player ID, and six core whitelisted read APIs fetch the save with bounded pagination. An optional `GetUserActivityApi` read with kind 2 supplies the game's ten recent music activities; unsupported HTTP 404/405/501 responses do not prevent the core save. Activity id is the music ID and sortNumber is a Unix timestamp. This activity does not identify the played difficulty or a per-play score; the UI explicitly leaves those fields unavailable. Explicit imported play logs may provide difficulty and per-play scores; only that difficulty's chart constant is shown, never all charts or a substituted best score. It needs no capture files, BepInEx or running game. The page seeds its local card selector from the 20-digit Aime access code in the `[aime] aimePath` file (relative to the game root, default `DEVICE/aime.txt`); users can add and reorder their own cards. Server and keychip stay in the main process. Missing card files allow manual card addition. Neither the INI nor the card file is modified. The current adapter uses game version 1.50; other versions have not been validated.
- Existing game captures retain their recorded endpoint, player ID, User-Agent and item-category cursors for optional refresh. The internal compatibility path remains, but the UI uses the single configuration-based fetch action rather than a separate refresh button.

Direct configuration supports compatible ALL.Net/AimeDB deployments with ordinary plaintext JSON read endpoints, including the deployment used for private testing. It does not extract the game's encryption keys, use a previous user's identity, register missing cards, send GameLogin/Upsert, or bypass certificate checks. ALL.Net can establish a machine session and Aime lookup can update server access timestamps. Servers requiring other authentication or encrypted game requests may need another adapter. Keychip alone does not identify a player.

Protocol references (independent client implementation): [AquaDX ALL.Net client](https://github.com/MewoLab/AquaDX/blob/v1-dev/src/main/java/icu/samnyan/aqua/net/transfer/AllNetClient.kt), [AimeDB client and packet layout](https://github.com/MewoLab/AquaDX/blob/v1-dev/src/main/java/icu/samnyan/aqua/sega/aimedb/AimeDbClient.kt), [Ongeki data reader](https://github.com/MewoLab/AquaDX/blob/v1-dev/src/main/java/icu/samnyan/aqua/net/transfer/DataBroker.kt). No user card numbers, keychips, player IDs or server session URLs are bundled.

JSON imports retain the original object, normalize recognized music detail fields, and preserve other resources in the downloadable local archive. They do not upload or restore anything to a server. The actual deployment's export format still needs a user-provided sample for acceptance testing.
