import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pbkdf2Sync } from "node:crypto";

export type PlayerGameProtocol = { userAgent(api: string, userId: number): string };
const failure = "无法读取本机游戏的请求标识，未连接服务器；请检查游戏资源和工具箱安装。本地合并成绩保留。";

// BLAKE2b with a caller-provided key and 32-byte digest, as used by the game's
// calcB2b_k. No commercial key, salt or resource content is bundled here.
export function playerProtocolDigest(bytes: Buffer, key: Buffer): Buffer {
  if (!key.length || key.length > 64) throw new Error("Invalid digest key");
  const mask = (1n << 64n) - 1n;
  const iv = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n, 0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n];
  const sigma = [[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],[14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3],[11,8,12,0,5,2,15,13,10,14,3,6,7,1,9,4],[7,9,3,1,13,12,11,14,2,6,5,10,4,0,15,8],[9,0,5,7,2,4,10,15,14,1,11,12,6,8,3,13],[2,12,6,10,0,11,8,3,4,13,7,5,15,14,1,9],[12,5,1,15,14,13,4,10,0,7,6,3,9,2,8,11],[13,11,7,14,12,1,3,9,5,0,15,4,8,6,2,10],[6,15,14,9,11,3,0,8,12,2,13,7,1,4,10,5],[10,2,8,4,7,6,1,5,15,11,9,14,3,12,13,0]];
  const h = [...iv]; h[0] ^= 0x01010020n ^ BigInt(key.length << 8);
  const rotate = (x: bigint, bits: bigint) => ((x >> bits) | (x << (64n - bits))) & mask;
  let counter = 0n;
  const compress = (block: Buffer, length: number, last: boolean) => {
    counter += BigInt(length);
    const m = Array.from({ length: 16 }, (_, i) => block.readBigUInt64LE(i * 8));
    const v = [...h, ...iv]; v[12] ^= counter; if (last) v[14] ^= mask;
    const mix = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
      v[a] = (v[a] + v[b] + x) & mask; v[d] = rotate(v[d] ^ v[a], 32n);
      v[c] = (v[c] + v[d]) & mask; v[b] = rotate(v[b] ^ v[c], 24n);
      v[a] = (v[a] + v[b] + y) & mask; v[d] = rotate(v[d] ^ v[a], 16n);
      v[c] = (v[c] + v[d]) & mask; v[b] = rotate(v[b] ^ v[c], 63n);
    };
    for (let round = 0; round < 12; round++) {
      const s = sigma[round % 10];
      mix(0,4,8,12,m[s[0]],m[s[1]]); mix(1,5,9,13,m[s[2]],m[s[3]]); mix(2,6,10,14,m[s[4]],m[s[5]]); mix(3,7,11,15,m[s[6]],m[s[7]]);
      mix(0,5,10,15,m[s[8]],m[s[9]]); mix(1,6,11,12,m[s[10]],m[s[11]]); mix(2,7,8,13,m[s[12]],m[s[13]]); mix(3,4,9,14,m[s[14]],m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  };
  const block = Buffer.alloc(128); key.copy(block);
  compress(block, 128, !bytes.length);
  for (let offset = 0; offset < bytes.length; offset += 128) {
    block.fill(0); const length = Math.min(128, bytes.length - offset); bytes.copy(block, 0, offset, offset + length);
    compress(block, length, offset + length === bytes.length);
  }
  block.fill(0);
  const digest = Buffer.alloc(32); for (let i = 0; i < 4; i++) digest.writeBigUInt64LE(h[i], i * 8);
  h.fill(0n); return digest;
}

export function playerProtocolFromSalt(salt: Buffer): PlayerGameProtocol {
  if (salt.length < 8) throw new Error(failure);
  const seed = Buffer.from(salt.subarray(0, 8)), names = new Map<string, string>();
  return { userAgent(api, userId) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,79}Api$/.test(api) || !Number.isSafeInteger(userId) || userId <= 0 || userId >= 0xffffffff) throw new Error("游戏请求标识或玩家身份无效，未发送。");
    let prefix = names.get(api);
    if (!prefix) { prefix = pbkdf2Sync(api, seed, 64, 16, "sha1").toString("hex").toUpperCase(); names.set(api, prefix); }
    return `${prefix}#${userId}`;
  } };
}

// Only trusted, already-shipped parser libraries are loaded. Mono.Cecil reads
// IL as data; Assembly-CSharp.dll is never loaded or executed. Resources stay
// in this child process and an in-memory pipe, and never reach the renderer.
const extractionScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$assembly = $null; $manager = $null
try {
  [Reflection.Assembly]::LoadFrom((Join-Path $env:OGK_PROTOCOL_LIB 'Mono.Cecil.dll')) | Out-Null
  [Reflection.Assembly]::LoadFrom((Join-Path $env:OGK_PROTOCOL_LIB 'AssetsTools.NET.dll')) | Out-Null
  $assembly = [Mono.Cecil.AssemblyDefinition]::ReadAssembly((Join-Path $env:OGK_PROTOCOL_ROOT 'mu3_Data/Managed/Assembly-CSharp.dll'))
  $system = @($assembly.MainModule.Types | Where-Object FullName -eq 'MU3.Sys.System')
  if ($system.Count -ne 1) { throw 'unsupported' }
  $crypto = @($assembly.MainModule.Types | Where-Object FullName -eq 'MU3.Cryptography')
  if ($crypto.Count -ne 1) { throw 'unsupported' }
  $scramble = @($crypto[0].Methods | Where-Object { $_.Name -eq 'scramble' -and $_.Parameters.Count -eq 3 })
  $salted = @($crypto[0].Methods | Where-Object { $_.Name -eq 'scramble' -and $_.Parameters.Count -eq 1 })
  if ($scramble.Count -ne 1 -or $salted.Count -ne 1) { throw 'unsupported' }
  if (($scramble[0].Body.Instructions.OpCode.Name -join ' ') -cne 'ldarg.1 ldarg.2 ldarg.3 newobj stloc.0 ldloc.0 ldc.i4.s callvirt stloc.1 ldloc.1 call ldstr ldsfld callvirt ret' -or $scramble[0].Body.Instructions[3].Operand.DeclaringType.FullName -cne 'System.Security.Cryptography.Rfc2898DeriveBytes' -or $scramble[0].Body.Instructions[6].Operand -ne 16 -or $scramble[0].Body.Instructions[11].Operand -cne '-') { throw 'unsupported' }
  if (($salted[0].Body.Instructions.OpCode.Name -join ' ') -cne 'ldarg.0 ldarg.1 ldarg.0 ldfld ldc.i4.0 callvirt stloc.0 ldloca.s ldfld ldc.i4.s callvirt ret' -or $salted[0].Body.Instructions[8].Operand.Name -cne 'digestSalt_' -or $salted[0].Body.Instructions[9].Operand -ne 64) { throw 'unsupported' }
  $load = @($system[0].Methods | Where-Object Name -eq 'loadResources')
  $cctor = @($system[0].Methods | Where-Object Name -eq '.cctor')
  if ($load.Count -ne 1 -or $cctor.Count -ne 1) { throw 'unsupported' }
  $loads = @($load[0].Body.Instructions | Where-Object { $_.OpCode.Code -eq 'Ldstr' })
  $digests = @($load[0].Body.Instructions | Where-Object { $_.Operand -is [Mono.Cecil.MethodReference] -and $_.Operand.FullName -eq 'System.Void MU3.Cryptography::calcDigest(System.Byte[],System.Byte[],System.Int32,System.Byte[])' })
  if ($loads.Count -ne 3 -or $digests.Count -ne 3 -or $load[0].Body.Instructions[0].Operand.Name -ne 'keyIvDigestFixed') { throw 'unsupported' }
  $target = @($cctor[0].Body.Instructions | Where-Object { $_.OpCode.Code -eq 'Stsfld' -and $_.Operand.Name -eq 'keyIvDigestFixed' })
  if ($target.Count -ne 1 -or $target[0].Previous.OpCode.Code -ne 'Call' -or $target[0].Previous.Operand.Name -ne 'InitializeArray' -or $target[0].Previous.Previous.OpCode.Code -ne 'Ldtoken') { throw 'unsupported' }
  $key = $target[0].Previous.Previous.Operand.Resolve().InitialValue
  if ($key.Length -ne 32) { throw 'unsupported' }
  $resourcePath = [string]$loads[2].Operand
  $wanted = [IO.Path]::GetFileName($resourcePath)
  if ([string]::IsNullOrEmpty($wanted)) { throw 'unsupported' }
  $manager = New-Object AssetsTools.NET.Extra.AssetsManager
  $globals = $manager.LoadAssetsFile((Join-Path $env:OGK_PROTOCOL_ROOT 'mu3_Data/globalgamemanagers'), $false)
  $manager.LoadClassPackage((Join-Path $env:OGK_PROTOCOL_LIB 'tools/unity/classdata.tpk')) | Out-Null
  $manager.LoadClassDatabaseFromPackage($globals.file.Metadata.UnityVersion) | Out-Null
  $maps = @($globals.file.GetAssetsOfType([AssetsTools.NET.Extra.AssetClassID]::ResourceManager))
  if ($maps.Count -ne 1) { throw 'unsupported' }
  $map = $manager.GetBaseField($globals, $maps[0])
  $references = @($map['m_Container']['Array'].Children | Where-Object { $_['first'].AsString -ceq $resourcePath })
  if ($references.Count -ne 1) { throw 'unsupported' }
  $fileId = $references[0]['second']['m_FileID'].AsInt
  $pathId = $references[0]['second']['m_PathID'].AsLong
  if ($fileId -le 0 -or $fileId -gt $globals.file.Metadata.Externals.Count -or $globals.file.Metadata.Externals[$fileId - 1].PathName -cne 'resources.assets') { throw 'unsupported' }
  $assets = $manager.LoadAssetsFile((Join-Path $env:OGK_PROTOCOL_ROOT 'mu3_Data/resources.assets'), $false)
  $reader = $assets.file.Reader
  $found = $null
  foreach ($info in $assets.file.GetAssetsOfType([AssetsTools.NET.Extra.AssetClassID]::TextAsset)) {
    if ($info.PathId -ne $pathId) { continue }
    if ($info.ByteSize -lt 8 -or $info.ByteSize -gt 1048576) { continue }
    $start = $info.GetAbsoluteByteOffset($assets.file)
    $reader.Position = $start
    $nameLength = $reader.ReadInt32()
    if ($nameLength -lt 0 -or $nameLength -gt 512 -or $nameLength + 8 -gt $info.ByteSize) { throw 'invalid asset' }
    $name = [Text.Encoding]::UTF8.GetString($reader.ReadBytes($nameLength)); $reader.Align()
    if ($name -cne $wanted) { throw 'invalid asset' }
    $length = $reader.ReadInt32()
    if ($length -le 0 -or $length -gt 1048576 -or $reader.Position + $length -gt $start + $info.ByteSize -or $null -ne $found) { throw 'invalid asset' }
    $found = $reader.ReadBytes($length)
  }
  if ($null -eq $found) { throw 'missing asset' }
  [Console]::Out.Write((@{key=[Convert]::ToBase64String($key);resource=[Convert]::ToBase64String($found)} | ConvertTo-Json -Compress))
} catch { [Console]::Error.Write('Protocol metadata unavailable'); exit 1 }
finally { if ($null -ne $manager) { $manager.UnloadAll($true) }; if ($null -ne $assembly) { $assembly.Dispose() } }
`;

async function parserDirectory(): Promise<string> {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = resources ? [path.join(resources, "api")] : [];
  for (const base of [path.resolve(__dirname, "../../../OGKToolBox.Api/bin"), path.resolve(__dirname, "../../OGKToolBox.Api/bin")])
    for (const configuration of ["Debug", "Release"]) for (const framework of ["net10.0", "net8.0"])
      candidates.push(path.join(base, configuration, framework), path.join(base, configuration, framework, "publish"));
  for (const candidate of candidates) {
    try { await fs.access(path.join(candidate, "Mono.Cecil.dll")); await fs.access(path.join(candidate, "AssetsTools.NET.dll")); await fs.access(path.join(candidate, "tools/unity/classdata.tpk")); return candidate; } catch { /* Try another trusted application build location. */ }
  }
  throw new Error(failure);
}

export async function playerGameProtocol(root: string, signal?: AbortSignal): Promise<PlayerGameProtocol> {
  if (signal?.aborted) throw new Error("已取消上传，本地合并成绩保留。");
  try {
    for (const [relative, maximum] of [["mu3_Data/Managed/Assembly-CSharp.dll", 32 * 1024 * 1024], ["mu3_Data/resources.assets", 128 * 1024 * 1024], ["mu3_Data/globalgamemanagers", 16 * 1024 * 1024]] as const) {
      const info = await fs.lstat(path.join(root, relative)); if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error(failure);
    }
    const library = await parserDirectory();
    const output = await new Promise<Buffer>((resolve, reject) => {
      const executable = path.join(process.env.WINDIR ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
      const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(extractionScript, "utf16le").toString("base64")], {
        windowsHide: true, signal, env: { ...process.env, OGK_PROTOCOL_ROOT: path.resolve(root), OGK_PROTOCOL_LIB: library }, stdio: ["ignore", "pipe", "pipe"]
      });
      const chunks: Buffer[] = []; let size = 0;
      const timer = setTimeout(() => { child.kill(); reject(new Error(failure)); }, 15000);
      child.stdout.on("data", (bytes: Buffer) => { size += bytes.length; if (size > 2 * 1024 * 1024) { child.kill(); reject(new Error(failure)); } else chunks.push(bytes); });
      child.stderr.resume();
      child.on("error", () => reject(new Error(failure)));
      child.on("close", code => { clearTimeout(timer); if (code === 0) resolve(Buffer.concat(chunks)); else reject(new Error(failure)); chunks.forEach(bytes => bytes.fill(0)); });
    });
    let key: Buffer | undefined, resource: Buffer | undefined, salt: Buffer | undefined;
    try {
      const parsed = JSON.parse(output.toString("utf8"));
      if (typeof parsed.key !== "string" || typeof parsed.resource !== "string") throw new Error(failure);
      key = Buffer.from(parsed.key, "base64"); resource = Buffer.from(parsed.resource, "base64");
      if (key.length !== 32 || !resource.length || resource.length > 1048576) throw new Error(failure);
      salt = playerProtocolDigest(resource, key);
      return playerProtocolFromSalt(salt);
    } finally { output.fill(0); key?.fill(0); resource?.fill(0); salt?.fill(0); }
  } catch { throw new Error(signal?.aborted ? "已取消上传，本地合并成绩保留。" : failure); }
}
