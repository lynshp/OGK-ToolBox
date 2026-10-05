param([string]$GameRoot)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$core = Join-Path $projectRoot 'resources/hdd-setup/mod/BepInEx/core'
$managed = Join-Path $GameRoot 'mu3_Data/Managed'
$unity = Join-Path $managed 'UnityEngine.dll'
if (!(Test-Path -LiteralPath $unity)) { throw 'Specify -GameRoot pointing to the local Unity Mono game package. Game DLLs are not copied to the output.' }
$output = Join-Path $projectRoot 'resources/player-capture'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
# Compile against the game's Mono BCL, not the compiler's newer desktop framework.
# /noconfig also prevents csc.rsp from adding incompatible .NET 4 references.
& $compiler /noconfig /nologo /nostdlib+ /target:library /optimize+ "/out:$output/OGKToolBox.PlayerCapture.dll" "/reference:$managed/mscorlib.dll" "/reference:$managed/System.dll" "/reference:$managed/System.Core.dll" "/reference:$core/BepInEx.dll" "/reference:$core/0Harmony20.dll" "/reference:$unity" (Join-Path $projectRoot 'game-capture/PlayerCapture.cs') (Join-Path $projectRoot 'game-capture/PlayerEdits.cs') (Join-Path $projectRoot 'game-capture/PlayerEditJson.cs')
if ($LASTEXITCODE -ne 0) { throw 'Player capture compilation failed.' }
