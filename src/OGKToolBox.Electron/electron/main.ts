import { app, BrowserWindow, dialog, ipcMain, screen, shell } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { BackendManager } from "./backend-manager";
import { windowLayout } from "./window-layout";
import { ControllerHub } from "./controller-hub";
import { fastGithubManager } from "./fastgithub-manager";
import { ensurePackageDataConfig, packageExtractRoot } from "./package-extractor";
import { UpdateManager } from "./update-manager";

type Installation = { installationId: string; displayName: string };
type Page<T> = { items: T[]; total: number; offset: number; limit: number };
type Summary = {
  installationId: string; musicCount: number; cardCount: number; characterCount: number;
  resourceCount: number; diagnosticCount: number; gameVersion: string; lastScanAt?: string;
};
type ScanStatus = {
  id: string;
  state: "Pending" | "Running" | "Completed" | "Failed" | "Cancelled";
  phase: string;
  completed: number;
  total: number;
  currentItem?: string | null;
  percent: number;
  overallCompleted: number;
  overallTotal: number;
  overallPercent: number;
  error?: string;
};
type Token = { type: "music" | "card" | "resource"; id: string; visual?: string };
type GameLaunchOptions = { width: number; height: number; fullscreen: boolean };
type ThumbnailPriority = "visible" | "prefetch";
type ThumbnailTask = {
  key: string; priority: ThumbnailPriority; run: (signal: AbortSignal) => Promise<Buffer>;
  controller: AbortController; started: boolean; complete: boolean; subscribers: number;
  resolve: (value: Buffer) => void; reject: (reason?: unknown) => void; promise: Promise<Buffer>;
};
type PackageDownloadKind = "option" | "mod";
type PackageDownloadPhase = "downloading" | "verifying" | "extracting" | "installing" | "completed" | "cancelled" | "error";
type PackageProgress = {
  downloadId: string;
  kind: PackageDownloadKind;
  id: string;
  phase: PackageDownloadPhase;
  received: number;
  total: number;
  percent: number;
  speed: number;
  message?: string;
  error?: string;
};
const packageExtractionTimeoutMs = 15 * 60_000;
type HddSetupInspection = {
  root: string;
  segatools: { installed: boolean; hasIni: boolean; missing: string[] };
  icf: { installed: boolean; missing: string[] };
  bepinex: { directoryExists: boolean; preloaderExists: boolean };
};
const hddSegatoolsTopLevel = [
  "amfs", "appdata", "DEVICE", "mu3_Data", "option", "amdaemon.exe", "config_client.json",
  "config_server.json", "inject.exe", "mu3.exe", "mu3.ini", "mu3hook.dll", "segatools.ini", "start.bat"
] as const;

const backend = new BackendManager();
const controllerManager = new ControllerHub();
const packageManifestUrl =
  "https://raw.githubusercontent.com/lynshp/OptionPackage/main/manifest.json";
// Option packages and Mods are published together in the 1.5_Options Release.
// Keep the download target independent from a stale/mistyped manifest release value.
const packageRelease = "option";
const modReleaseTags = ["option_260818", "option"] as const;
const packageDownloadControllers = new Map<string, AbortController>();
const updateManager = new UpdateManager({
  stopSidecar: () => backend.stop(),
  stopController: () => controllerManager.stop(),
  beginInstallQuit: () => { quitting = true; },
  getWindow: () => mainWindow
});
const installations = new Map<string, Installation>();
const chartSoundFiles = new Set([
  "se_tap.wav", "se_extap.wav", "se_wall.wav", "se_exwall.wav", "se_hold.wav", "se_hold_end.wav",
  "se_flick.wav", "se_cr_flick.wav", "se_bell.wav", "se_beam_notice.wav", "se_beam_shot.wav"
]);
const chartImageFiles = new Set([
  "mu3_nt_tap_00.png", "mu3_nt_tap_02.png", "mu3_nt_extap_00.png", "mu3_nt_extap_02.png",
  "mu3_nt_hold_00.png", "mu3_nt_hold_02.png", "mu3_nt_flicktap_00.png"
]);
let mainWindow: BrowserWindow | undefined;
let quitting = false;

function hddSetupResourcePath(...parts: string[]): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "hdd-setup")
    : path.resolve(__dirname, "../../resources/hdd-setup");
  return path.join(base, ...parts);
}

async function requireSetupRoot(root: string): Promise<string> {
  if (typeof root !== "string" || !root.trim()) throw new Error("未选择游戏目录。");
  const target = path.resolve(root);
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw new Error("所选游戏目录不存在。");
  return target;
}

async function inspectHddSetup(root: string): Promise<HddSetupInspection> {
  const target = await requireSetupRoot(root);
  const segatoolsSource = hddSetupResourcePath("segatools");
  await fs.access(segatoolsSource);
  const missing: string[] = [];
  for (const name of hddSegatoolsTopLevel) if (!await pathExists(path.join(target, name))) missing.push(name);
  const missingIcf: string[] = [];
  for (const name of ["ICF1", "ICF2"]) if (!await pathExists(path.join(target, "amfs", name))) missingIcf.push(name);
  const bepinexDirectory = path.join(target, "BepInEx");
  return {
    root: target,
    segatools: { installed: missing.length === 0, hasIni: await pathExists(path.join(target, "segatools.ini")), missing },
    icf: { installed: missingIcf.length === 0, missing: missingIcf },
    bepinex: {
      directoryExists: await pathExists(bepinexDirectory),
      preloaderExists: await pathExists(path.join(bepinexDirectory, "core", "BepInEx.Preloader.dll"))
    }
  };
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("in-process-gpu");
app.commandLine.appendSwitch("use-angle", "swiftshader");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const thumbnailMemoryCache = new Map<string, Buffer>();
const thumbnailInFlight = new Map<string, ThumbnailTask>();
const thumbnailRequests = new Map<string, AbortController>();
const librarySectionRequests = new Map<string, AbortController>();
const visibleThumbnailQueue: ThumbnailTask[] = [];
const prefetchThumbnailQueue: ThumbnailTask[] = [];
let activeThumbnailRequests = 0;
// Two workers keep visible rows responsive without the severe AssetsTools.NET
// contention and working-set spike measured with four concurrent ONGEKI decoders.
const thumbnailConcurrency = 2;
const thumbnailCacheCapacity = 256;

function pumpThumbnailQueue(): void {
  while (activeThumbnailRequests < thumbnailConcurrency) {
    const task = visibleThumbnailQueue.shift() ?? prefetchThumbnailQueue.shift();
    if (!task) return;
    if (task.complete || task.controller.signal.aborted) continue;
    task.started = true;
    activeThumbnailRequests++;
    void task.run(task.controller.signal).then(value => {
      task.complete = true;
      task.resolve(value);
    }, error => {
      task.complete = true;
      task.reject(error);
    }).finally(() => {
      if (thumbnailInFlight.get(task.key) === task) thumbnailInFlight.delete(task.key);
      activeThumbnailRequests--;
      pumpThumbnailQueue();
    });
  }
}

function promoteThumbnail(task: ThumbnailTask): void {
  if (task.priority === "visible") return;
  const index = prefetchThumbnailQueue.indexOf(task);
  if (index < 0) return;
  prefetchThumbnailQueue.splice(index, 1);
  task.priority = "visible";
  visibleThumbnailQueue.push(task);
}

function scheduleThumbnail(key: string, priority: ThumbnailPriority, run: (signal: AbortSignal) => Promise<Buffer>): ThumbnailTask {
  const existing = thumbnailInFlight.get(key);
  if (existing) {
    if (priority === "visible") promoteThumbnail(existing);
    return existing;
  }

  let task!: ThumbnailTask;
  const promise = new Promise<Buffer>((resolve, reject) => {
    task = { key, priority, run, resolve, reject, promise: undefined!, controller: new AbortController(),
      started: false, complete: false, subscribers: 0 };
  });
  task.promise = promise;
  thumbnailInFlight.set(key, task);
  (priority === "visible" ? visibleThumbnailQueue : prefetchThumbnailQueue).push(task);
  pumpThumbnailQueue();
  return task;
}

function abandonThumbnail(task: ThumbnailTask): void {
  if (task.complete || task.subscribers > 0) return;
  if (!task.started) {
    const queue = task.priority === "visible" ? visibleThumbnailQueue : prefetchThumbnailQueue;
    const index = queue.indexOf(task);
    if (index >= 0) queue.splice(index, 1);
    task.complete = true;
    if (thumbnailInFlight.get(task.key) === task) thumbnailInFlight.delete(task.key);
    task.reject(new DOMException("Thumbnail request cancelled", "AbortError"));
    return;
  }
  task.controller.abort();
  if (thumbnailInFlight.get(task.key) === task) thumbnailInFlight.delete(task.key);
}

function awaitThumbnail(task: ThumbnailTask, signal: AbortSignal): Promise<Buffer> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<Buffer>((resolve, reject) => {
    let released = false;
    task.subscribers++;
    const release = () => {
      if (released) return;
      released = true;
      task.subscribers--;
      abandonThumbnail(task);
    };
    const abort = () => {
      release();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    task.promise.then(value => { signal.removeEventListener("abort", abort); release(); resolve(value); }, error => {
      signal.removeEventListener("abort", abort); release(); reject(error);
    });
  });
}

function rememberThumbnail(key: string, value: Buffer): Buffer {
  thumbnailMemoryCache.delete(key);
  thumbnailMemoryCache.set(key, value);
  while (thumbnailMemoryCache.size > thumbnailCacheCapacity) {
    const oldest = thumbnailMemoryCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    thumbnailMemoryCache.delete(oldest);
  }
  return value;
}

function cachedThumbnail(root: string, value: string, maxSize: number, priority: ThumbnailPriority, signal: AbortSignal): Promise<Buffer> {
  const key = `${normalizeRoot(root)}\u001f${value}\u001f${maxSize}`;
  const cached = thumbnailMemoryCache.get(key);
  if (cached) {
    thumbnailMemoryCache.delete(key);
    thumbnailMemoryCache.set(key, cached);
    return Promise.resolve(cached);
  }
  return awaitThumbnail(scheduleThumbnail(key, priority, async requestSignal =>
    rememberThumbnail(key, await imageEndpoint(root, value, maxSize, requestSignal))), signal);
}

function normalizeRoot(root: string): string { return path.resolve(root).toLocaleLowerCase(); }

async function installation(root: string): Promise<Installation> {
  const key = normalizeRoot(String(root ?? ""));
  const cached = installations.get(key);
  if (cached) return cached;
  const registered = await backend.request<Installation>("/api/installations", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rootPath: root })
  });
  installations.set(key, registered);
  return registered;
}

async function queryAll<T>(installationId: string, kind: string, signal?: AbortSignal): Promise<T[]> {
  const result: T[] = [];
  const pageSize = 5000;
  for (let offset = 0; ; offset += pageSize) {
    const page = await backend.request<Page<T>>(
      `/api/installations/${encodeURIComponent(installationId)}/library/${kind}?offset=${offset}&limit=${pageSize}`,
      { signal });
    result.push(...page.items);
    if (result.length >= page.total || page.items.length === 0) return result;
  }
}

function resourceToken(token: Token): string {
  return `ogk://${token.type}/${encodeURIComponent(token.id)}${token.visual ? `/${token.visual}` : ""}`;
}

function readToken(value: string): Token {
  const parsed = new URL(value);
  if (parsed.protocol !== "ogk:") throw new Error("资源标识无效。");
  const type = parsed.hostname as Token["type"];
  if (!["music", "card", "resource"].includes(type)) throw new Error("资源类型无效。");
  const parts = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (!parts[0]) throw new Error("资源标识无效。");
  return { type, id: parts[0], visual: parts[1] };
}

async function snapshot(root: string) {
  const summary = await librarySummary(root);
  return {
    summary,
    music: [], cards: [], characters: [], resources: [], diagnostics: []
  };
}

async function librarySummary(root: string): Promise<Summary & { gameRoot: string }> {
  const registered = await installation(root);
  const id = encodeURIComponent(registered.installationId);
  // Restoring a large index also deserializes its snapshot and checks Option data.
  // It is disk work, so the normal five-second IPC request budget is too short.
  const summary = await backend.request<Summary>(`/api/installations/${id}/summary`, {}, 120_000);
  return { ...summary, gameRoot: root };
}

async function optionPackages(root: string) {
  const registered = await installation(root);
  return backend.request<any>(`/api/installations/${encodeURIComponent(registered.installationId)}/option-packages`);
}

async function optionDirectorySize(directoryPath: string): Promise<number> {
  let total = 0;
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try { entries = await fs.readdir(directoryPath, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>; }
  catch { return 0; }
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    try {
      if (entry.isDirectory()) total += await optionDirectorySize(entryPath);
      else if (entry.isFile()) total += (await fs.stat(entryPath)).size;
    } catch { /* Files can disappear while a game installer is updating the folder. */ }
  }
  return total;
}

function updatePackageRoots(root: string) {
  return [path.resolve(root, "option"), path.resolve(root, "mu3_Data", "StreamingAssets", "GameData")];
}

async function optionDirectoryIndex(root: string) {
  const roots = updatePackageRoots(root);
  const directoryPaths: string[] = [];
  const packages: Array<{name:string;directoryPath:string;size:number}> = [];
  for (const directoryPath of roots) {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true }).catch(() => null);
    if (!entries) continue;
    directoryPaths.push(directoryPath);
    for (const entry of entries) {
      if (!entry.isDirectory() || /^A000$/i.test(entry.name)) continue;
      if (directoryPath !== roots[0] && !/^A[a-z\d]{3}$/i.test(entry.name)) continue;
      const packagePath = path.join(directoryPath, entry.name);
      packages.push({ name: entry.name, directoryPath: packagePath, size: await optionDirectorySize(packagePath) });
    }
  }
  packages.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
  return { directoryPath: roots[0], directoryPaths, exists: directoryPaths.length > 0, packages };
}
type PackageVersion = { major: number; minor: number; release: number };
type RemoteOptionPackage = {
  id: string; version: PackageVersion; cardMakerVersion?: PackageVersion; asset: string;
  size: number; sha256: string; fileCount?: number; required?: boolean; release?: string;
};
type RemoteMod = {
  id: string; displayName: string; chineseName?: string; description?: string; version: string; kind: string; asset: string;
  size: number; sha256: string; installPath: string; category?: string; gameVersion?: string; requiresRestart?: boolean; release?: string;
};
type PackageManifestPayload = {
  schemaVersion: number; repository: string; release: string;
  gameVersion?: { major: number; minor: number };
  optionPackages: RemoteOptionPackage[]; mods: RemoteMod[]; sourceUrl: string; checkedAt: string;
};

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function packageVersion(value: unknown): PackageVersion {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { major: integer(source.major), minor: integer(source.minor), release: integer(source.release) };
}

type GithubReleaseAsset = { name: string; size: number; sha256?: string };
type GithubReleaseSnapshot = { tag: string; publishedAt: number; assets: Map<string, GithubReleaseAsset> };

function releaseSha256(value: unknown): string | undefined {
  const hash = text(value).replace(/^sha256:/i, "").toLowerCase();
  return /^[a-f\d]{64}$/.test(hash) ? hash : undefined;
}

async function githubReleaseSnapshot(repository: string, tag: string): Promise<GithubReleaseSnapshot> {
  const [owner, name] = repository.split("/");
  const response = await fastGithubManager.fetch(
    `https://api.github.com/repos/${owner}/${name}/releases/tags/${encodeURIComponent(tag)}`,
    { headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, cache: "no-store" }
  );
  if (!response.ok) throw new Error(`读取 GitHub Release ${tag} 失败（${response.status}）。`);
  const payload = await response.json() as Record<string, unknown>;
  if (!Array.isArray(payload.assets)) throw new Error(`GitHub Release ${tag} 格式无效。`);
  const assets = new Map<string, GithubReleaseAsset>();
  for (const item of payload.assets) {
    if (!item || typeof item !== "object") continue;
    const asset = item as Record<string, unknown>;
    const assetName = text(asset.name);
    if (!assetName) continue;
    assets.set(assetName.toLowerCase(), {
      name: assetName,
      size: integer(asset.size),
      sha256: releaseSha256(asset.digest)
    });
  }
  const parsedPublishedAt = Date.parse(text(payload.published_at));
  return { tag, publishedAt: Number.isFinite(parsedPublishedAt) ? parsedPublishedAt : 0, assets };
}

async function mergeModReleaseAssets(repository: string, mods: RemoteMod[], fallbackRelease: string): Promise<RemoteMod[]> {
  const releases = (await Promise.all(modReleaseTags.map(async tag => {
    try { return await githubReleaseSnapshot(repository, tag); }
    catch { return null; }
  }))).filter((item): item is GithubReleaseSnapshot => item !== null);
  if (releases.length === 0) return mods.map(mod => ({ ...mod, release: fallbackRelease }));

  const ordered = [...releases].sort((left, right) => right.publishedAt - left.publishedAt || right.tag.localeCompare(left.tag));
  const merged = new Map<string, RemoteMod>();
  for (const mod of mods) {
    const candidates = ordered
      .map(release => ({ release, asset: release.assets.get(mod.asset.toLowerCase()) }))
      .filter((item): item is { release: GithubReleaseSnapshot; asset: GithubReleaseAsset } => item.asset !== undefined);
    const selected = candidates[0];
    merged.set(mod.id.toLowerCase(), {
      ...mod,
      release: selected?.release.tag ?? fallbackRelease,
      size: selected?.asset.size || mod.size,
      sha256: selected?.asset.sha256 ?? mod.sha256
    });
  }

  for (const release of ordered) {
    for (const asset of release.assets.values()) {
      if (!/\.mm\.dll$/i.test(asset.name)) continue;
      const id = asset.name.replace(/^Assembly-CSharp\./i, "").replace(/\.mm\.dll$/i, "");
      if (!id || merged.has(id.toLowerCase())) continue;
      merged.set(id.toLowerCase(), {
        id, displayName: id, version: "未知", kind: "MonoMod", asset: asset.name,
        size: asset.size, sha256: asset.sha256 ?? "", installPath: "BepInEx/monomod",
        requiresRestart: true, release: release.tag
      });
    }
  }
  return [...merged.values()];
}

async function packageManifestPayload(value: unknown): Promise<PackageManifestPayload> {
  if (!value || typeof value !== "object") throw new Error("GitHub 更新清单格式无效。");
  const source = value as Record<string, unknown>;
  if (integer(source.schemaVersion) < 1 || !text(source.repository) || !text(source.release))
    throw new Error("GitHub 更新清单缺少必要信息。");
  if (!Array.isArray(source.optionPackages) || !Array.isArray(source.mods))
    throw new Error("GitHub 更新清单缺少更新包或 Mod 列表。");
  const repository = text(source.repository);
  const manifestRelease = text(source.release);
  const options = source.optionPackages;
  const mods = source.mods;
  const parsedMods = mods.flatMap<RemoteMod>(item => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    const id = text(entry.id);
    const asset = text(entry.asset);
    if (!id || !asset) return [];
    return [{
      id, displayName: text(entry.displayName, id), chineseName: text(entry.chineseName) || undefined,
      description: text(entry.description) || undefined, version: text(entry.version),
      kind: text(entry.kind), asset, size: integer(entry.size), sha256: text(entry.sha256),
      installPath: text(entry.installPath), category: text(entry.category), gameVersion: text(entry.gameVersion),
      requiresRestart: entry.requiresRestart === true, release: manifestRelease
    }];
  });
  return {
    schemaVersion: integer(source.schemaVersion),
    repository,
    release: packageRelease,
    gameVersion: source.gameVersion && typeof source.gameVersion === "object"
      ? { major: integer((source.gameVersion as Record<string, unknown>).major), minor: integer((source.gameVersion as Record<string, unknown>).minor) }
      : undefined,
    optionPackages: options.flatMap<RemoteOptionPackage>(item => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      const id = text(entry.id);
      const asset = text(entry.asset);
      if (!id || !asset) return [];
      return [{
        id, version: packageVersion(entry.version),
        cardMakerVersion: entry.cardMakerVersion ? packageVersion(entry.cardMakerVersion) : undefined,
        asset, size: integer(entry.size), sha256: text(entry.sha256),
        fileCount: integer(entry.fileCount), required: entry.required === true, release: packageRelease
      }];
    }),
    mods: await mergeModReleaseAssets(repository, parsedMods, manifestRelease),
    sourceUrl: packageManifestUrl,
    checkedAt: new Date().toISOString()
  };
}

async function packageManifest() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fastGithubManager.fetch(packageManifestUrl, {
      headers: { Accept: "application/json" }, signal: controller.signal, cache: "no-store"
    });
    if (!response.ok) throw new Error(`GitHub 更新清单请求失败（${response.status}）。`);
    return packageManifestPayload(await response.json());
  }
  catch (error) {
    if (controller.signal.aborted) throw new Error("连接 GitHub 更新仓库超时，请检查网络后重试。");
    throw error instanceof Error ? error : new Error("读取 GitHub 更新清单失败。");
  }
  finally { clearTimeout(timeout); }
}

type PackageDownloadRequest = {
  downloadId: string;
  kind: PackageDownloadKind;
  id: string;
  root: string;
};

function packageDownloadKey(sender: { id: number }, downloadId: string): string {
  return `${sender.id}:${downloadId}`;
}

function emitPackageProgress(sender: { isDestroyed(): boolean; send(channel: string, value: PackageProgress): void }, progress: PackageProgress): void {
  if (!sender.isDestroyed()) sender.send("packages:progress", progress);
}

function packageAssetUrl(manifest: PackageManifestPayload, asset: string, release = manifest.release): string {
  const parts = manifest.repository.split("/");
  if (parts.length !== 2 || parts.some(part => !/^[a-z\d_.-]+$/i.test(part)))
    throw new Error("GitHub 仓库地址无效。");
  if (!asset || asset.includes("/") || asset.includes("\\")) throw new Error("更新资产文件名无效。");
  if (!release || !/^[a-z\d_.-]+$/i.test(release)) throw new Error("GitHub Release 名称无效。");
  return `https://github.com/${parts[0]}/${parts[1]}/releases/download/${encodeURIComponent(release)}/${encodeURIComponent(asset)}`;
}

async function pathExists(value: string): Promise<boolean> {
  return fs.stat(value).then(() => true, () => false);
}

const packageCleanupTimeoutMs = 30_000;
const packageFilesystemOperationTimeoutMs = 60_000;

class PackageFilesystemOperationInterrupted extends Error {
  readonly operationMayStillBeRunning = true;
  constructor(message: string, readonly operationSettled: Promise<unknown>) {
    super(message);
  }
}

async function packageFilesystemOperation<T>(
  startOperation: () => Promise<T>,
  controller: AbortController,
  description: string
): Promise<T> {
  if (controller.signal.aborted) throw new Error("下载已取消。");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let removeAbortListener: (() => void) | undefined;
  let settleOperation!: () => void;
  const operationSettled = new Promise<void>(resolve => { settleOperation = resolve; });
  const guardedOperation = startOperation().then(
    value => { settled = true; settleOperation(); removeAbortListener?.(); return value; },
    error => { settled = true; settleOperation(); removeAbortListener?.(); throw error; }
  );
  const interruption = new Promise<never>((_, reject) => {
    const interrupt = () => {
      if (settled) return;
      reject(new PackageFilesystemOperationInterrupted("下载已取消。", operationSettled));
    };
    controller.signal.addEventListener("abort", interrupt, { once: true });
    removeAbortListener = () => controller.signal.removeEventListener("abort", interrupt);
    timer = setTimeout(() => {
      if (!settled) reject(new PackageFilesystemOperationInterrupted(`${description}超时，请关闭占用该目录的程序后重试。`, operationSettled));
    }, packageFilesystemOperationTimeoutMs);
  });
  try {
    return await Promise.race([guardedOperation, interruption]);
  }
  finally {
    if (timer) clearTimeout(timer);
    removeAbortListener?.();
  }
}

/**
 * Windows may keep a file in an old update package open for a while (for
 * example, an antivirus scanner can still be inspecting it). Cleanup must
 * never keep an otherwise successful installation in the "installing" state.
 */
async function removePackagePathBestEffort(target: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fs.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 }),
      new Promise<void>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("更新包清理超时。")), packageCleanupTimeoutMs);
      })
    ]);
  } catch {
    // A leftover random backup/staging directory is harmless and can be
    // removed on a later run. It must not make the installation fail.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function packagePathExists(value: string, controller: AbortController): Promise<boolean> {
  return packageFilesystemOperation(
    () => fs.stat(value).then(stat => stat.isDirectory(), error => {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw error;
    }),
    controller,
    "检查更新包目录"
  );
}

function assertChildPath(parent: string, child: string, message: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(message);
}

async function downloadPackageAsset(
  sender: { isDestroyed(): boolean; send(channel: string, value: PackageProgress): void },
  request: PackageDownloadRequest,
  manifest: PackageManifestPayload,
  entry: RemoteOptionPackage | RemoteMod,
  controller: AbortController,
  tempPath: string
): Promise<void> {
  const totalFromManifest = entry.size > 0 ? entry.size : 0;
  const response = await fastGithubManager.fetch(packageAssetUrl(manifest, entry.asset, entry.release), {
    headers: { Accept: "application/octet-stream" }, signal: controller.signal
  });
  if (!response.ok) throw new Error(`GitHub 下载失败（${response.status}）。`);
  if (!response.body) throw new Error("GitHub 没有返回下载内容。");

  const total = Number(response.headers.get("content-length")) || totalFromManifest;
  const startedAt = Date.now();
  let received = 0;
  let lastReportAt = 0;
  const hash = createHash("sha256");
  const handle = await fs.open(tempPath, "w");
  const report = (phase: PackageDownloadPhase, message?: string) => {
    const elapsed = Math.max(1, Date.now() - startedAt) / 1000;
    const speed = received / elapsed;
    emitPackageProgress(sender, {
      downloadId: request.downloadId, kind: request.kind, id: request.id, phase,
      received, total, percent: total > 0 ? phase === "downloading"
        ? Math.min(99, received / total * 100)
        : phase === "completed" ? 100 : 96 : 0, speed, message
    });
  };
  report("downloading");
  try {
    const reader = response.body.getReader();
    while (true) {
      if (controller.signal.aborted) throw new Error("下载已取消。");
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!chunk.value?.length) continue;
      const bytes = Buffer.from(chunk.value);
      await handle.write(bytes);
      hash.update(bytes);
      received += bytes.length;
      const now = Date.now();
      if (now - lastReportAt >= 100 || (total > 0 && received >= total)) {
        lastReportAt = now;
        report("downloading");
      }
      // GitHub supplies Content-Length. Do not wait on a delayed final stream
      // marker or a proxy that never resolves reader.cancel() after all bytes
      // arrive. The file is complete and can be verified immediately.
      if (total > 0 && received >= total) {
        void reader.cancel().catch(() => undefined);
        break;
      }
    }
  }
  finally { await handle.close(); }

  const expected = String(entry.sha256 ?? "").trim().toLowerCase();
  const actual = hash.digest("hex").toLowerCase();
  report("verifying", "正在校验 SHA-256…");
  if (!expected || !/^[a-f\d]{64}$/.test(expected)) throw new Error("更新清单缺少有效的 SHA-256 校验值。");
  if (actual !== expected) throw new Error(`文件校验失败：${entry.asset} 的 SHA-256 与更新清单不一致（期望 ${expected}，实际 ${actual}）。`);
}

async function expandZip(zipPath: string, destination: string, controller: AbortController): Promise<void> {
  const scriptPath = path.join(app.getPath("temp"), `ogk-expand-${randomUUID()}.ps1`);
  const script = [
    "param([string]$ZipPath, [string]$DestinationPath)",
    "$ErrorActionPreference = 'Stop'",
    "Expand-Archive -LiteralPath $ZipPath -DestinationPath $DestinationPath -Force"
  ].join("\r\n");
  await fs.writeFile(scriptPath, script, "utf8");
  try {
    if (controller.signal.aborted) throw new Error("下载已取消。");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, zipPath, destination], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let errorOutput = "";
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        child.kill();
        finish(new Error("下载已取消。"));
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        controller.signal.removeEventListener("abort", onAbort);
        if (error) reject(error); else resolve();
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => {
        child.kill();
        finish(new Error("解压超时，请检查压缩包或磁盘空间后重试。"));
      }, packageExtractionTimeoutMs);
      child.stderr?.on("data", value => { errorOutput += value.toString(); });
      child.once("error", error => finish(error));
      child.once("close", code => code === 0 ? finish() : finish(new Error(errorOutput.trim() || `解压失败（${code ?? "unknown"}）。`)));
    });
  }
  finally { await fs.rm(scriptPath, { force: true }); }
}

async function replaceDirectory(source: string, target: string, controller: AbortController): Promise<void> {
  const backup = `${target}.ogk-backup-${randomUUID()}`;
  let backupCreated = false;
  let installed = false;
  try {
    if (await packagePathExists(target, controller)) {
      await packageFilesystemOperation(() => fs.rename(target, backup), controller, "移动旧更新包");
      backupCreated = true;
    }
    await packageFilesystemOperation(() => fs.rename(source, target), controller, "安装更新包目录");
    installed = true;
    // Do not block completion on deleting the previous package. On Windows
    // this can be delayed by another process holding one of its files.
    if (backupCreated) void removePackagePathBestEffort(backup);
  }
  catch (error) {
    if (error instanceof PackageFilesystemOperationInterrupted) {
      void error.operationSettled.then(async () => {
        const targetPresent = await pathExists(target);
        const backupPresent = await pathExists(backup);
        if (!targetPresent && backupCreated && backupPresent) await fs.rename(backup, target).catch(() => undefined);
        else if (targetPresent && backupPresent) void removePackagePathBestEffort(backup);
      });
      throw error;
    }
    if (installed) await fs.rm(target, { recursive: true, force: true });
    if (backupCreated && !await pathExists(target)) await fs.rename(backup, target).catch(() => undefined);
    throw error;
  }
}

async function replaceFile(source: string, target: string, controller: AbortController): Promise<void> {
  const backup = `${target}.ogk-backup-${randomUUID()}`;
  let backupCreated = false;
  let installed = false;
  try {
    if (await packagePathExists(target, controller)) {
      await packageFilesystemOperation(() => fs.rename(target, backup), controller, "移动旧 Mod");
      backupCreated = true;
    }
    await packageFilesystemOperation(() => fs.rename(source, target), controller, "安装 Mod");
    installed = true;
    if (backupCreated) void removePackagePathBestEffort(backup);
  }
  catch (error) {
    if (error instanceof PackageFilesystemOperationInterrupted) {
      void error.operationSettled.then(async () => {
        const targetPresent = await pathExists(target);
        const backupPresent = await pathExists(backup);
        if (!targetPresent && backupCreated && backupPresent) await fs.rename(backup, target).catch(() => undefined);
        else if (targetPresent && backupPresent) void removePackagePathBestEffort(backup);
      });
      throw error;
    }
    if (installed) await fs.rm(target, { force: true });
    if (backupCreated && !await pathExists(target)) await fs.rename(backup, target).catch(() => undefined);
    throw error;
  }
}

async function gameRootPath(value: unknown): Promise<string> {
  const root = path.resolve(String(value ?? "").trim());
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("游戏目录不存在，无法安装更新。");
  return root;
}

async function installDownloadedPackage(
  sender: { isDestroyed(): boolean; send(channel: string, value: PackageProgress): void },
  request: PackageDownloadRequest,
  entry: RemoteOptionPackage | RemoteMod,
  assetPath: string,
  controller: AbortController
): Promise<{ kind: PackageDownloadKind; id: string; path: string }> {
  const total = entry.size > 0 ? entry.size : 0;
  const progress = (phase: PackageDownloadPhase, message: string, targetPath?: string) => emitPackageProgress(sender, {
    downloadId: request.downloadId, kind: request.kind, id: request.id, phase,
    received: total, total, percent: phase === "completed" ? 100 : phase === "extracting" ? 96 : 98, speed: 0,
    message: targetPath ? `${message}：${targetPath}` : message
  });
  progress("installing", "正在确认安装目录…");
  const root = await gameRootPath(request.root);
  if (controller.signal.aborted) throw new Error("下载已取消。");

  if (request.kind === "option") {
    if (!/^A[a-z\d]{3}$/i.test(request.id) || /^A000$/i.test(request.id)) throw new Error("Option 更新包编号无效。");
    const roots = updatePackageRoots(root);
    const existing = await Promise.all(roots.map(directory => fs.stat(path.join(directory, request.id)).then(stat => stat.isDirectory()).catch(() => false)));
    const optionRoot = roots[existing.findIndex(Boolean)] ?? roots[0];
    assertChildPath(root, optionRoot, "Option 安装目录无效。");
    await fs.mkdir(optionRoot, { recursive: true });
    const target = path.join(optionRoot, request.id);
    const targetExists = await fs.stat(target).then(stat => stat.isDirectory()).catch(() => false);
    if (!targetExists) {
      await fs.mkdir(target, { recursive: true });
      let directInstallCompleted = false;
      try {
        progress("extracting", "正在解压 Option…", target);
        await expandZip(assetPath, target, controller);
        if (controller.signal.aborted) throw new Error("下载已取消。");
        const extractedRoot = await packageExtractRoot(target, request.id);
        assertChildPath(optionRoot, extractedRoot, "ZIP 解压目录无效。");
        if (extractedRoot !== target) {
          // Archives with an outer Axxx folder need one final normalization;
          // direct-content archives are already in their final directory.
          const normalized = path.join(optionRoot, `.${request.id}.ogk-normalized-${randomUUID()}`);
          await packageFilesystemOperation(() => fs.rename(extractedRoot, normalized), controller, "整理更新包目录");
          await fs.rm(target, { recursive: true, force: true });
          await packageFilesystemOperation(() => fs.rename(normalized, target), controller, "完成更新包安装");
        }
        await ensurePackageDataConfig(target, (entry as RemoteOptionPackage).version);
        progress("completed", "Option 安装完成", target);
        directInstallCompleted = true;
        return { kind: request.kind, id: request.id, path: target };
      }
      finally {
        if (!directInstallCompleted) void removePackagePathBestEffort(target);
      }
    }
    const staging = path.join(optionRoot, `.${request.id}.ogk-staging-${randomUUID()}`);
    await fs.mkdir(staging, { recursive: true });
    let pendingFilesystemOperation: Promise<unknown> | undefined;
    try {
      progress("extracting", "正在解压 Option…");
      await expandZip(assetPath, staging, controller);
      if (controller.signal.aborted) throw new Error("下载已取消。");
      const source = await packageExtractRoot(staging, request.id);
      assertChildPath(optionRoot, source, "ZIP 解压目录无效。");
      await ensurePackageDataConfig(source, (entry as RemoteOptionPackage).version);
      progress("installing", "正在安装 Option 目录…", target);
      await replaceDirectory(source, target, controller);
      progress("completed", "Option 安装完成", target);
      return { kind: request.kind, id: request.id, path: target };
    }
    catch (error) {
      if (error instanceof PackageFilesystemOperationInterrupted) pendingFilesystemOperation = error.operationSettled;
      throw error;
    }
    finally {
      void (pendingFilesystemOperation
        ? pendingFilesystemOperation.then(() => removePackagePathBestEffort(staging))
        : removePackagePathBestEffort(staging));
    }
  }

  const assetName = path.basename(entry.asset);
  if (assetName !== entry.asset || !/\.dll$/i.test(assetName)) throw new Error("Mod 资产文件名无效。");
  const modRoot = path.resolve(root, "BepInEx", "monomod");
  assertChildPath(root, modRoot, "Mod 安装目录无效。");
  await fs.mkdir(modRoot, { recursive: true });
  const target = path.join(modRoot, assetName);
  const staging = path.join(modRoot, `.${assetName}.ogk-staging-${randomUUID()}.dll`);
  progress("installing", "正在安装 Mod…", target);
  let pendingFilesystemOperation: Promise<unknown> | undefined;
  try {
    if (controller.signal.aborted) throw new Error("下载已取消。");
    await fs.copyFile(assetPath, staging);
    await replaceFile(staging, target, controller);
  }
  catch (error) {
    if (error instanceof PackageFilesystemOperationInterrupted) pendingFilesystemOperation = error.operationSettled;
    throw error;
  }
  finally {
    void (pendingFilesystemOperation
      ? pendingFilesystemOperation.then(() => removePackagePathBestEffort(staging))
      : removePackagePathBestEffort(staging));
  }
  progress("completed", "Mod 安装完成", target);
  return { kind: request.kind, id: request.id, path: target };
}

async function downloadAndInstallPackage(
  sender: { id: number; isDestroyed(): boolean; send(channel: string, value: PackageProgress): void },
  request: PackageDownloadRequest
): Promise<{ kind: PackageDownloadKind; id: string; path: string }> {
  const downloadId = String(request.downloadId ?? "").trim();
  if (!/^[a-z\d_.:-]{1,120}$/i.test(downloadId)) throw new Error("下载任务编号无效。");
  if (request.kind !== "option" && request.kind !== "mod") throw new Error("下载类型无效。");
  const id = String(request.id ?? "").trim();
  const manifest = await packageManifest();
  const entry = request.kind === "option"
    ? manifest.optionPackages.find(item => item.id.toLowerCase() === id.toLowerCase())
    : manifest.mods.find(item => item.id.toLowerCase() === id.toLowerCase());
  if (!entry) throw new Error("更新清单中没有找到这个资产。");

  const key = packageDownloadKey(sender, downloadId);
  if (packageDownloadControllers.has(key)) throw new Error("这个下载任务已经在进行中。");
  const controller = new AbortController();
  packageDownloadControllers.set(key, controller);
  const tempPath = path.join(app.getPath("temp"), `ogk-package-${request.kind}-${randomUUID()}${request.kind === "option" ? ".zip" : ".dll"}`);
  try {
    await fs.mkdir(path.dirname(tempPath), { recursive: true });
    await downloadPackageAsset(sender, request, manifest, entry, controller, tempPath);
    const result = await installDownloadedPackage(sender, request, entry, tempPath, controller);
    return result;
  }
  catch (error) {
    const cancelled = controller.signal.aborted;
    const message = cancelled ? "下载已取消。" : error instanceof Error ? error.message : "下载或安装失败。";
    emitPackageProgress(sender, {
      downloadId, kind: request.kind, id, phase: cancelled ? "cancelled" : "error", received: 0,
      total: entry.size > 0 ? entry.size : 0, percent: 0, speed: 0, error: message, message
    });
    throw new Error(message);
  }
  finally {
    packageDownloadControllers.delete(key);
    void removePackagePathBestEffort(tempPath);
  }
}

async function deleteOptionPackage(root: string, directoryPath: string): Promise<boolean> {
  const gameRoot = path.resolve(String(root ?? ""));
  const allowedRoots = updatePackageRoots(gameRoot);
  const target = path.resolve(String(directoryPath ?? ""));
  const optionRoot = allowedRoots.find(directory => path.dirname(target).toLowerCase() === directory.toLowerCase());
  if (!optionRoot || /^A000$/i.test(path.basename(target)) || (optionRoot === allowedRoots[1] && !/^A[a-z\d]{3}$/i.test(path.basename(target))))
    throw new Error("只能删除 option 或 GameData 下的更新包目录，不能删除 A000。");
  const relative = path.relative(optionRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("更新包目录路径无效。");
  const targetStat = await fs.stat(target).catch(() => null);
  if (!targetStat?.isDirectory()) throw new Error("更新包目录不存在或不是文件夹。");
  await fs.rm(target, { recursive: true, force: false });
  return true;
}

async function librarySection(root: string, kind: string, signal?: AbortSignal) {
  if (!["music", "cards", "characters", "resources", "diagnostics"].includes(kind))
    throw new Error("不支持的资源库分区。");
  const registered = await installation(root);
  const items = await queryAll<any>(registered.installationId, kind, signal);
  if (kind === "music") return items.map(item => ({
      ...item, id: item.numericId, origin: { packageId: item.packageId },
      jacket: item.hasJacket ? { bundlePath: resourceToken({ type: "music", id: item.id }) } : undefined,
      audio: item.hasAudio ? resourceToken({ type: "music", id: item.id }) : undefined,
      charts: item.charts.map((chart: any) => ({ ...chart, filePath: chart.id }))
    }));
  if (kind === "cards") return items.map(item => ({
      ...item, id: item.numericId, origin: { packageId: item.packageId },
      image: item.hasImage ? { bundlePath: resourceToken({ type: "card", id: item.id, visual: "card" }) } : undefined,
      characterImage: item.hasCharacterImage ? { bundlePath: resourceToken({ type: "card", id: item.id, visual: "character" }) } : undefined,
      fullIllustration: item.hasFullIllustration ? { bundlePath: resourceToken({ type: "card", id: item.id, visual: "full" }) } : undefined,
      icon: item.hasIcon ? { bundlePath: resourceToken({ type: "card", id: item.id, visual: "icon" }) } : undefined
    }));
  if (kind === "characters") return items.map(item => ({
    ...item, id: item.numericId, origin: { packageId: item.packageId }
  }));
  if (kind === "resources") return items.map(item => ({
      ...item, bundlePath: resourceToken({ type: "resource", id: item.id }), origin: { packageId: item.packageId }
    }));
  if (kind === "diagnostics") return items.map(item => ({ ...item, sourcePath: item.source }));
  return [];
}

async function resourcePage(root: string, offset: number, limit: number, search: string) {
  const registered = await installation(root);
  const query = new URLSearchParams({
    offset: String(Math.max(0, offset)),
    limit: String(Math.min(200, Math.max(1, limit)))
  });
  if (search.trim()) query.set("q", search.trim());
  const page = await backend.request<Page<any>>(
    `/api/installations/${encodeURIComponent(registered.installationId)}/library/resources?${query}`);
  return {
    ...page,
    items: page.items.map(item => ({
      ...item,
      bundlePath: resourceToken({ type: "resource", id: item.id }),
      origin: { packageId: item.packageId }
    }))
  };
}

async function scan(root: string, onProgress?: (status: ScanStatus) => void) {
  const registered = await installation(root);
  const publish = (status: ScanStatus) => onProgress?.(status);
  let status = await backend.request<ScanStatus>(`/api/installations/${encodeURIComponent(registered.installationId)}/scans`, { method: "POST" });
  publish(status);
  while (status.state === "Pending" || status.state === "Running") {
    await new Promise(resolve => setTimeout(resolve, 250));
    status = await backend.request<ScanStatus>(`/api/scans/${encodeURIComponent(status.id)}`);
    publish(status);
  }
  if (status.state !== "Completed") throw new Error(status.error ?? `扫描未完成（${status.state}）。`);
  thumbnailMemoryCache.clear();
  return snapshot(root);
}

async function configuration(root: string) {
  const registered = await installation(root);
  const value = await backend.request<any>(`/api/installations/${encodeURIComponent(registered.installationId)}/configuration`);
  return {
    ...value,
    files: value.files.map((file: any) => ({
      ...file,
      lastWriteText: file.lastWriteTime ? new Date(file.lastWriteTime).toLocaleString() : "—"
    })),
    mods: value.mods.map((mod: any) => ({
      ...mod, nameText: mod.chineseName || mod.name, kindText: mod.kind,
      statusText: mod.isEnabled ? "已启用" : "已停用", lastWriteText: new Date(mod.lastWriteTime).toLocaleString()
    }))
  };
}

function imageEndpoint(root: string, value: string, maxSize: number, signal?: AbortSignal): Promise<Buffer> {
  return installation(root).then(registered => {
    const token = readToken(value);
    const base = `/api/installations/${encodeURIComponent(registered.installationId)}`;
    const endpoint = token.type === "music" ? `${base}/music/${encodeURIComponent(token.id)}/thumbnail`
      : token.type === "card" ? `${base}/cards/${encodeURIComponent(token.id)}/thumbnail?visual=${encodeURIComponent(token.visual ?? "card")}`
      : `${base}/resources/${encodeURIComponent(token.id)}/thumbnail`;
    return backend.bytes(`${endpoint}${endpoint.includes("?") ? "&" : "?"}maxSize=${maxSize}`, signal);
  });
}

function dataUrl(bytes: Buffer, mime = "image/png"): string { return `data:${mime};base64,${bytes.toString("base64")}`; }
function chartAssetDirectory(): string {
  return app.isPackaged ? path.join(process.resourcesPath, "chart") : path.join(__dirname, "../../assets/chart");
}

function createWindow(): void {
  const devServerUrl = process.env.OGK_DEV_URL ?? "http://127.0.0.1:5173";
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  mainWindow = new BrowserWindow({
    ...windowLayout(display.workArea), frame: false, transparent: true,
    roundedCorners: true, hasShadow: true, backgroundColor: '#00000000', autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, app.isPackaged ? "../../dist/toolbox-icon.png" : "../../public/toolbox-icon.png"),
    // Chromium's renderer sandbox cannot initialize in some Windows desktop environments.
    // Keep the preload boundary and disable Node integration while allowing the renderer to start.
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  const window = mainWindow;
  window.once("ready-to-show", () => window.show());
  // Windows reports rotation and DPI/work-area changes through this event.
  // Follow only this window's display; unrelated monitors must not resize it.
  const adaptDisplay = (_event: Electron.Event, changed: Electron.Display) => {
    if (window.isDestroyed() || screen.getDisplayMatching(window.getBounds()).id !== changed.id) return;
    const { minWidth, minHeight, ...bounds } = windowLayout(changed.workArea);
    window.setMinimumSize(minWidth, minHeight);
    if (window.isMaximized() || window.isFullScreen()) return;
    window.setBounds(bounds);
  };
  screen.on("display-metrics-changed", adaptDisplay);
  window.once("closed", () => screen.removeListener("display-metrics-changed", adaptDisplay));
  const releaseControllerKeys = () => { void controllerManager.releaseAllIfRunning().catch(() => {}); };
  mainWindow.on("maximize", () => mainWindow?.webContents.send("window:state-changed", true));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("window:state-changed", false));
  mainWindow.on("blur", releaseControllerKeys);
  mainWindow.on("closed", () => { releaseControllerKeys(); mainWindow = undefined; });
  mainWindow.webContents.on("render-process-gone", releaseControllerKeys);
  mainWindow.webContents.on("did-start-loading", releaseControllerKeys);
  mainWindow.webContents.once("destroyed", releaseControllerKeys);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame || validatedUrl.startsWith("data:")) return;
    const detail = `${errorDescription} (${errorCode})`.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
    void mainWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>OGKToolBox</title><body style="margin:0;display:grid;min-height:100vh;place-items:center;background:#f7f8fa;color:#1f2937;font-family:Segoe UI,Microsoft YaHei UI,sans-serif"><main style="width:min(520px,calc(100vw - 48px));text-align:center"><strong style="color:#d94c1b;font-size:14px">OGKToolBox</strong><h1 style="margin:16px 0 8px;font-size:24px">无法加载界面</h1><p style="margin:0;color:#667085;font-size:13px">开发服务器没有响应。请关闭窗口后重新运行启动测试.cmd。</p><p style="margin:12px 0 0;color:#667085;font-size:12px">${detail}</p></main></body></html>`)}`);
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    releaseControllerKeys();
    const allowed = app.isPackaged ? url.startsWith("file:") : url.startsWith(devServerUrl);
    if (!allowed) event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => { mainWindow?.show(); mainWindow?.focus(); });
  if (app.isPackaged) void mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  else void mainWindow.loadURL(devServerUrl);
}

ipcMain.handle("dialog:game-directory", async () => {
  const result = await dialog.showOpenDialog({ title: "选择游戏 package 目录", properties: ["openDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle("library:scan", (event, root: string) => scan(root, status => {
  if (!event.sender.isDestroyed()) event.sender.send("library:scan-progress", { root, ...status });
}));
ipcMain.handle("library:summary", (_event, root: string) => librarySummary(root));
ipcMain.handle("library:option-packages", (_event, root: string) => optionPackages(root));
ipcMain.handle("library:option-directory-index", (_event, root: string) => optionDirectoryIndex(root));
ipcMain.handle("packages:manifest", () => packageManifest());
ipcMain.handle("packages:download", (event, request: PackageDownloadRequest) =>
  downloadAndInstallPackage(event.sender, request));
ipcMain.on("packages:cancel", (event, downloadId: string) => {
  const id = String(downloadId ?? "").trim();
  if (id) packageDownloadControllers.get(packageDownloadKey(event.sender, id))?.abort();
});
ipcMain.handle("library:delete-option-package", (_event, request: { root: string; directoryPath: string }) =>
  deleteOptionPackage(request?.root, request?.directoryPath));
ipcMain.handle("dialog:open-option-directory", async (_event, root: string, directoryPath?: string) => {
  const roots = updatePackageRoots(String(root ?? ""));
  const optionExists = (await fs.stat(roots[0]).catch(() => null))?.isDirectory();
  const target = directoryPath ? path.resolve(directoryPath) : optionExists ? roots[0] : roots[1];
  if (!roots.some(base => target.toLowerCase() === base.toLowerCase() || path.dirname(target).toLowerCase() === base.toLowerCase()))
    throw new Error("更新包目录路径无效。");
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return true;
});
ipcMain.handle("library:cached-scan", async (_event, root: string) => {
  const value = await snapshot(root);
  return value.summary.lastScanAt ? value : null;
});
ipcMain.handle("library:section", async (_event, root: string, kind: string, requestId?: string) => {
  const controller = new AbortController();
  if (requestId) librarySectionRequests.set(requestId, controller);
  try {
    return await librarySection(root, kind, controller.signal);
  }
  finally {
    if (requestId && librarySectionRequests.get(requestId) === controller)
      librarySectionRequests.delete(requestId);
  }
});
function normalizeGameLaunchOptions(value?: Partial<GameLaunchOptions>): GameLaunchOptions {
  const clampDimension = (input: unknown, fallback: number) => {
    const parsed = Number(input);
    return Number.isInteger(parsed) ? Math.max(320, Math.min(8192, parsed)) : fallback;
  };
  return {
    width: clampDimension(value?.width, 1080),
    height: clampDimension(value?.height, 1920),
    fullscreen: value?.fullscreen !== false
  };
}
function launcherScript(options?: Partial<GameLaunchOptions>): string {
  const normalized = normalizeGameLaunchOptions(options);
  return `@echo off\r\npushd %~dp0\r\n\r\nstart "AM Daemon" /min inject -d -k mu3hook.dll amdaemon.exe -f -c config_common.json config_server.json config_client.json\r\ninject -d -k mu3hook.dll mu3 -screen-fullscreen ${normalized.fullscreen ? 1 : 0} -popupwindow -screen-width ${normalized.width} -screen-height ${normalized.height}\r\ntaskkill /f /im amdaemon.exe > nul 2>&1\r\n\r\necho.\r\necho Game processes have terminated\r\npause\r\n`;
}
async function prepareGameLauncher(root: string, options?: Partial<GameLaunchOptions>): Promise<{ launcher: string; fileName: string }> {
  const requestedRoot = String(root ?? "").trim();
  if (!requestedRoot) throw new Error("请先选择游戏目录。");
  const gameRoot = path.resolve(requestedRoot);
  const launcher = path.join(gameRoot, "OGKToolBox-Launch.bat");
  await fs.writeFile(launcher, launcherScript(options), "ascii");
  return { launcher, fileName: path.basename(launcher) };
}
ipcMain.handle("game:prepare-launcher", (_event, root: string, options?: Partial<GameLaunchOptions>) =>
  prepareGameLauncher(root, options).then(({ fileName }) => ({ fileName })));
ipcMain.handle("game:launch", async (_event, root: string, options?: Partial<GameLaunchOptions>) => {
  const { launcher, fileName } = await prepareGameLauncher(root, options);
  const launchError = await shell.openPath(launcher);
  if (launchError) throw new Error(`启动脚本失败：${launchError}`);
  return { fileName };
});
ipcMain.on("library:section:cancel", (_event, requestId: string) => {
  librarySectionRequests.get(requestId)?.abort();
});
ipcMain.handle("library:resource-page", (_event, root: string, request: { offset?: number; limit?: number; search?: string }) =>
  resourcePage(root, request?.offset ?? 0, request?.limit ?? 100, request?.search ?? ""));
ipcMain.handle("configuration:inspect", (_event, root: string) => configuration(root));
ipcMain.handle("configuration:preview", async (_event, request: any) => {
  const registered = await installation(request.gameRoot);
  return backend.request(`/api/installations/${encodeURIComponent(registered.installationId)}/configuration/${encodeURIComponent(request.kind)}/preview`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ baselineHash: request.baselineHash, edits: request.edits })
  });
});
const gameProcessNames = ["mu3", "amdaemon", "inject"] as const;
async function commandOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let output = "";
    child.stdout?.on("data", value => { output += value.toString(); });
    child.once("error", reject);
    child.once("close", () => resolve(output));
  });
}
async function runningGameProcesses(): Promise<string[]> {
  const output = await commandOutput("tasklist.exe", ["/FO", "CSV", "/NH"]);
  const processNames = new Set(
    output.split(/\r?\n/).map(line => line.match(/^\s*"?([^",]+\.exe)"?/i)?.[1].toLowerCase()).filter((name): name is string => Boolean(name))
  );
  return gameProcessNames.filter(name => processNames.has(`${name}.exe`));
}
async function confirmGameStopped(event: Electron.IpcMainInvokeEvent): Promise<void> {
  const running = await runningGameProcesses();
  if (!running.length) return;
  const options = {
    type: "warning" as const, buttons: ["取消", "关闭游戏并继续"], defaultId: 1, cancelId: 0,
    title: "需要关闭游戏",
    message: "游戏正在运行，无法修改配置或 Mod。",
    detail: `将关闭：${running.map(name => `${name}.exe`).join("、")}，然后继续执行修改。`
  };
  const window = BrowserWindow.fromWebContents(event.sender);
  const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  if (result.response !== 1) throw new Error("已取消修改。");
  await Promise.all(running.map(name => commandOutput("taskkill.exe", ["/F", "/IM", `${name}.exe`])));
}
async function requireGameStopped(): Promise<void> {
  const running = await runningGameProcesses();
  if (running.length) throw new Error(`游戏仍在运行：${running.map(name => `${name}.exe`).join("、")}。`);
}
ipcMain.handle("game:running-processes", () => runningGameProcesses());
ipcMain.handle("game:stop-processes", async () => {
  const running = await runningGameProcesses();
  await Promise.all(running.map(name => commandOutput("taskkill.exe", ["/F", "/IM", `${name}.exe`])));
});
ipcMain.handle("configuration:save", async (_event, request: any) => {
  await requireGameStopped();
  const registered = await installation(request.gameRoot);
  return backend.request(`/api/installations/${encodeURIComponent(registered.installationId)}/configuration/save`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewToken: request.preview?.token })
  });
});
ipcMain.handle("configuration:install-controller-io", async (_event, root: string) => {
  if (typeof root !== "string" || !root.trim()) throw new Error("未选择游戏目录。");
  const targetDirectory = path.resolve(root);
  await fs.access(path.join(targetDirectory, "segatools.ini"));
  const source = app.isPackaged
    ? path.join(process.resourcesPath, "NYAGEKI_IO.dll")
    : path.resolve(__dirname, "../../resources/NYAGEKI_IO.dll");
  const target = path.join(targetDirectory, "NYAGEKI_IO.dll");
  await fs.access(source);
  try {
    await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
    return { path: target, installed: true };
  } catch (error: any) {
    if (error?.code === "EEXIST") return { path: target, installed: false };
    throw error;
  }
});
ipcMain.handle("hdd-setup:inspect", (_event, root: string) => inspectHddSetup(root));
ipcMain.handle("hdd-setup:install-segatools", async (_event, root: string) => {
  const target = await requireSetupRoot(root);
  await fs.cp(hddSetupResourcePath("segatools"), target, { recursive: true, force: true });
  await Promise.all(["amfs", "appdata", "option"].map(name => fs.mkdir(path.join(target, name), { recursive: true })));
  return inspectHddSetup(target);
});
ipcMain.handle("hdd-setup:install-icf", async (_event, root: string, overwrite = false) => {
  const target = await requireSetupRoot(root);
  const amfs = path.join(target, "amfs");
  await fs.mkdir(amfs, { recursive: true });
  for (const name of ["ICF1", "ICF2"]) {
    const destination = path.join(amfs, name);
    if (overwrite || !await pathExists(destination)) await fs.copyFile(hddSetupResourcePath("icf", name), destination);
  }
  return inspectHddSetup(target);
});
ipcMain.handle("hdd-setup:install-bepinex", async (_event, root: string) => {
  const target = await requireSetupRoot(root);
  await fs.cp(hddSetupResourcePath("mod", "BepInEx"), path.join(target, "BepInEx"), { recursive: true, force: true });
  return inspectHddSetup(target);
});
ipcMain.handle("hdd-setup:choose-mu3io", async (event, root: string) => {
  const targetDirectory = await requireSetupRoot(root);
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = { title: "选择 MU3IO DLL", properties: ["openFile"], filters: [{ name: "DLL", extensions: ["dll"] }] };
  const selection = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  if (selection.canceled || !selection.filePaths[0]) return { canceled: true };
  const source = path.resolve(selection.filePaths[0]);
  const fileName = path.basename(source);
  const target = path.join(targetDirectory, fileName);
  if (source.toLowerCase() !== target.toLowerCase() && await pathExists(target)) {
    const prompt = {
      type: "warning" as const, buttons: ["取消", "覆盖"], defaultId: 1, cancelId: 0,
      title: "覆盖同名 DLL？", message: `${fileName} 已存在。`, detail: "覆盖后将把 Segatools 的 MU3IO 路径设置为此文件。"
    };
    const result = owner ? await dialog.showMessageBox(owner, prompt) : await dialog.showMessageBox(prompt);
    if (result.response !== 1) return { canceled: true };
  }
  if (source.toLowerCase() !== target.toLowerCase()) await fs.copyFile(source, target);
  return { canceled: false, fileName, path: target };
});
ipcMain.handle("hdd-setup:open-portal", (_event, service: string) => {
  const urls: Record<string, string> = {
    rinnet: "https://portal.naominet.live/",
    munet: "https://portal.mumur.net/",
    nageki: "https://next.nageki-net.com/"
  };
  const url = urls[service];
  if (!url) throw new Error("未知的服务器网站。");
  return shell.openExternal(url);
});
ipcMain.handle("configuration:segatools-backups", async (_event, root: string) => {
  const registered = await installation(root);
  const values = await backend.request<any[]>(`/api/installations/${encodeURIComponent(registered.installationId)}/configuration/SegaTools/backups`);
  return values.map(item => ({ ...item, name: item.id }));
});
ipcMain.handle("configuration:segatools-backup", async (_event, root: string) => {
  const registered = await installation(root);
  const values = await backend.request<any[]>(`/api/installations/${encodeURIComponent(registered.installationId)}/configuration/SegaTools/backups`);
  return values.map(item => ({ ...item, name: item.id }));
});
ipcMain.handle("configuration:restore-segatools-backup", async (_event, request: any) => {
  const registered = await installation(request.gameRoot);
  return backend.request(`/api/installations/${encodeURIComponent(registered.installationId)}/configuration/backups/${encodeURIComponent(request.name)}/restore`, { method: "POST" });
});
ipcMain.handle("configuration:segatools-dlls", async (_event, root: string) => {
  const registered = await installation(root);
  return backend.request(`/api/installations/${encodeURIComponent(registered.installationId)}/configuration/io-dlls`);
});
ipcMain.handle("mods:toggle", async (event, request: any) => {
  await confirmGameStopped(event);
  const registered = await installation(request.gameRoot);
  const configuration = await backend.request<any>(
    `/api/installations/${encodeURIComponent(registered.installationId)}/configuration`);
  const mod = configuration.mods.find((item: any) => item.name === request.mod?.name && item.kind === request.mod?.kind);
  if (!mod) throw new Error("Mod 已变更或不再可用，请重新读取配置后重试。");
  return backend.request(`/api/installations/${encodeURIComponent(registered.installationId)}/mods/${encodeURIComponent(mod.id)}/state`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !mod.isEnabled })
  });
});
ipcMain.handle("resource:thumbnail", async (_event, value: string, cache?: { gameRoot?: string },
  priority?: ThumbnailPriority, requestId?: string) => {
  if (!cache?.gameRoot) return null;
  const controller = new AbortController();
  if (requestId) thumbnailRequests.set(requestId, controller);
  try {
    const image = await cachedThumbnail(cache.gameRoot, value, 320,
      priority === "visible" ? "visible" : "prefetch", controller.signal);
    return dataUrl(image);
  }
  catch (error) {
    if (controller.signal.aborted) return null;
    throw error;
  }
  finally {
    if (requestId && thumbnailRequests.get(requestId) === controller)
      thumbnailRequests.delete(requestId);
  }
});
ipcMain.on("resource:thumbnail:cancel", (_event, requestId: string) => {
  thumbnailRequests.get(requestId)?.abort();
});
ipcMain.handle("resource:original", async (_event, value: string, root?: string) => {
  const selectedRoot = root ?? [...installations.keys()][0];
  return selectedRoot ? dataUrl(await imageEndpoint(selectedRoot, value, 2048)) : null;
});
ipcMain.handle("chart:preview", async (_event, chartId: string, root?: string) => {
  const registered = await installation(root ?? [...installations.keys()][0]);
  return backend.request(`/api/installations/${encodeURIComponent(registered.installationId)}/charts/${encodeURIComponent(chartId)}/preview`);
});
ipcMain.handle("chart:audio", async (_event, value: string, root?: string) => {
  const registered = await installation(root ?? [...installations.keys()][0]);
  const token = readToken(value);
  return backend.bytes(`/api/installations/${encodeURIComponent(registered.installationId)}/music/${encodeURIComponent(token.id)}/audio`);
});
ipcMain.handle("chart:effect-textures", async (_event, root: string) => {
  const registered = await installation(root);
  return backend.request(`/api/installations/${encodeURIComponent(registered.installationId)}/chart-effect-textures`);
});
ipcMain.handle("characters:expressions", async (_event, request: any) => {
  const registered = await installation(request.gameRoot);
  const values = await backend.request<any[]>(`/api/installations/${encodeURIComponent(registered.installationId)}/characters/${request.modelId}/expressions`);
  return values.map(item => ({ ...item, bundlePath: item.id, spritePathId: item.id, bundleKey: item.bundleKey }));
});
ipcMain.handle("characters:expression-preview", async (_event, request: any, root?: string) => {
  const registered = await installation(root ?? [...installations.keys()][0]);
  return dataUrl(await backend.bytes(`/api/installations/${encodeURIComponent(registered.installationId)}/expressions/${encodeURIComponent(request.spritePathId)}`), "image/png");
});
ipcMain.handle("chart:sound", (_event, fileName: string) => {
  if (!chartSoundFiles.has(fileName)) throw new Error("请求的谱面音效不可用。");
  return fs.readFile(path.join(chartAssetDirectory(), fileName));
});
ipcMain.handle("chart:image", (_event, fileName: string) => {
  if (!chartImageFiles.has(fileName)) throw new Error("请求的谱面图片不可用。");
  return fs.readFile(path.join(chartAssetDirectory(), fileName));
});
ipcMain.handle("export:save", async (_event, request: { root: string; kind: string; itemId?: string }) => {
  const registered = await installation(request.root);
  const downloaded = await backend.download(`/api/installations/${encodeURIComponent(registered.installationId)}/exports/${encodeURIComponent(request.kind)}/${encodeURIComponent(request.itemId || "_")}`);
  const destination = await dialog.showSaveDialog({ defaultPath: downloaded.fileName });
  if (destination.canceled || !destination.filePath) return false;
  await fs.writeFile(destination.filePath, downloaded.bytes);
  return true;
});
ipcMain.handle("app:set-ui-scale", (event, requested: number) => {
  const supported = [1, 1.25, 1.5, 1.75, 2];
  const scale = supported.reduce((nearest, value) => Math.abs(value - Number(requested)) < Math.abs(nearest - Number(requested)) ? value : nearest, 1);
  event.sender.setZoomFactor(scale);
  return scale;
});
ipcMain.handle("window:minimize", event => BrowserWindow.fromWebContents(event.sender)?.minimize());
ipcMain.handle("window:toggle-maximize", event => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return false;
  window.isMaximized() ? window.unmaximize() : window.maximize();
  return window.isMaximized();
});
ipcMain.handle("window:close", event => BrowserWindow.fromWebContents(event.sender)?.close());
ipcMain.handle("window:is-maximized", event => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false);

ipcMain.handle("controller:snapshot", () => controllerManager.getSnapshot());
ipcMain.handle("controller:status", () => controllerManager.getStatus());
ipcMain.on("controller:subscribe", event => {
  const sendSnapshot = (snapshot: unknown) => { if (!event.sender.isDestroyed()) event.sender.send("controller:snapshot", snapshot); };
  const sendStatus = (status: unknown) => { if (!event.sender.isDestroyed()) event.sender.send("controller:status", status); };
  const removeSnapshot = controllerManager.onSnapshot(sendSnapshot);
  const removeStatus = controllerManager.onStatus(sendStatus);
  event.sender.once("destroyed", () => { removeSnapshot(); removeStatus(); });
});
ipcMain.handle("controller:rescan", () => controllerManager.rescan());
ipcMain.handle("controller:retry-sync", () => controllerManager.retrySync());
ipcMain.handle("controller:restart", () => controllerManager.restart());
ipcMain.handle("controller:release-all", () => controllerManager.releaseAll());
ipcMain.handle("controller:virtual-key", (_event, key: string, pressed: boolean) => controllerManager.setVirtualKey(key, pressed));
ipcMain.handle("controller:mode", (_event, keyboardMouse: boolean) => controllerManager.setMode(keyboardMouse));
ipcMain.handle("controller:input-mode", (_event, mode: number) => controllerManager.setInputMode(mode));
ipcMain.handle("controller:brightness", (_event, brightness: number) => controllerManager.setBrightness(brightness));
ipcMain.handle("controller:custom-color", (_event, red: number, green: number, blue: number) => controllerManager.setCustomColor(red, green, blue));
ipcMain.handle("controller:pico-lighting", (_event, request: any) => controllerManager.setPicoLighting(request));
ipcMain.handle("controller:hall", (_event, request: any) => controllerManager.setHall(request));
ipcMain.handle("controller:hall-calibration", (_event, action: string) => controllerManager.hallCalibration(action));
ipcMain.handle("controller:hall-query", () => controllerManager.hallQuery());
ipcMain.handle("controller:device-query", () => controllerManager.deviceQuery());
ipcMain.handle("controller:lever", (_event, request: any) => controllerManager.setLever(request));
ipcMain.handle("controller:lever-calibration", (_event, action: string) => controllerManager.leverCalibration(action));
ipcMain.handle("controller:bootloader", () => controllerManager.bootloader());

app.whenReady().then(async () => {
  await backend.start();
  createWindow();
  void controllerManager.start().catch(error => console.error("[controller]", error));
  await updateManager.start();
}).catch(error => {
  dialog.showErrorBox("OGK ToolBox 启动失败", error instanceof Error ? error.message : String(error));
  app.quit();
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", event => {
  if (updateManager.isInstalling || quitting) return;
  event.preventDefault();
  quitting = true;
  void Promise.all([controllerManager.stop(), backend.stop(), updateManager.stop()]).finally(() => app.quit());
});
