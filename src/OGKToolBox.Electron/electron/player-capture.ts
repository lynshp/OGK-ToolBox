import type { SaveScope } from "./player-identity";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { deflateSync, inflateSync, gunzipSync } from "node:zlib";
import { randomInt } from "node:crypto";
import { captureWarnings, firstPage, persistSave, allReadApis, captureStreamKey, readSave, saveDirectory, saveLimit, type CaptureEvent } from "./player-save";

const seen = new Map<string, string>();
const syncJobs = new Map<string, Promise<void>>();
const payloadKeys: Record<string, string> = { GetUserDataApi: "userData", GetUserMusicApi: "userMusicList", GetUserCardApi: "userCardList", GetUserCharacterApi: "userCharacterList", GetUserItemApi: "userItemList", GetUserOptionApi: "userOption", GetUserActivityApi: "userActivityList" };
function validatePayload(api: string, response: Record<string, unknown>) {
  const field = payloadKeys[api], payload = response[field];
  const valid = field.endsWith("List") ? Array.isArray(payload) : !!payload && typeof payload === "object" && !Array.isArray(payload);
  if (!valid) throw new Error(`${api} 响应缺少有效存档字段，原存档保留。`);
}
export async function captureState(root: string) {
  const dir = saveDirectory(root);
  const enabled = await fs.stat(path.join(dir, "capture.enabled")).then(() => true, () => false);
  const installed = await fs.stat(path.join(root, "BepInEx", "plugins", "OGKToolBox.PlayerCapture.dll")).then(() => true, () => false);
  const statusFile = path.join(dir, "capture-status.txt");
  const statusTime = await fs.stat(statusFile).then(value => value.mtimeMs, () => 0);
  let status = (await fs.readFile(statusFile, "utf8").catch(() => "")).replace(/^\uFEFF/, "").trim();
  // A previous run must not appear connected after the game exits or crashes.
  if (["initializing", "ready", "capturing"].includes(status) && Date.now() - statusTime > 20000) status = "inactive";
  const captures = await sessions(root);
  return { enabled, installed, status, sessions: captures.length, canRefresh: captures.length > 0 };
}
async function sessions(root: string) {
  const dir = path.join(saveDirectory(root), "captures");
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  return entries.filter(entry => entry.isDirectory() && /^[a-f0-9]{32}$/.test(entry.name)).map(entry => entry.name);
}
export async function captureEvents(root: string, session: string): Promise<CaptureEvent[]> {
  if (!/^[a-f0-9]{32}$/.test(session)) throw new Error("采集会话无效。");
  const dir = path.join(saveDirectory(root), "captures", session);
  const names = (await fs.readdir(dir)).filter(name => /^\d{6}\.json$/.test(name)).sort();
  if (names.length > 2000) throw new Error("采集会话超过大小限制。");
  let size = 0;
  const events: CaptureEvent[] = [];
  let player: unknown;
  for (const name of names) {
    size += (await fs.stat(path.join(dir, name))).size;
    if (size > saveLimit) throw new Error("采集会话超过 64 MB。");
    const event = await readSave(path.join(dir, name)) as CaptureEvent;
    if (!allReadApis.includes(event.api as typeof allReadApis[number]) || !event.request || !event.response || typeof event.at !== "string") throw new Error("采集记录格式无效。");
    const userId = event.request.userId;
    if (!Number.isSafeInteger(userId) || Number(userId) <= 0 || event.response.userId !== userId) throw new Error("采集响应的玩家身份不匹配。");
    validatePayload(event.api, event.response);
    if (event.api === "GetUserActivityApi" && event.response.kind !== event.request.kind) throw new Error("采集记录的活动类别不匹配。");
    if (player !== undefined && userId !== player) throw new Error("采集会话包含不同玩家，已拒绝混合存档。");
    player = userId; events.push(event);
  }
  // A retry replaces the same page, rather than duplicating resources.
  return [...new Map(events.map(event => [captureStreamKey(event), event])).values()];
}
export function syncCaptures(root: string): Promise<void> {
  const key = path.resolve(root).toLowerCase();
  const running = syncJobs.get(key);
  if (running) return running;
  const job = syncCapturesCore(root).finally(() => syncJobs.delete(key));
  syncJobs.set(key, job); return job;
}
async function syncCapturesCore(root: string) {
  for (const session of await sessions(root)) {
    const dir = path.join(saveDirectory(root), "captures", session);
    const files = (await fs.readdir(dir)).filter(name => /^\d{6}\.json$/.test(name)).sort();
    const fingerprint = files.join(",");
    if (!files.length || seen.get(dir) === fingerprint) continue;
    const events = await captureEvents(root, session);
    if (!events.length) continue;
    const raw = { format: "ogk-player-save-v1", sessionId: session, events, captureWarnings: captureWarnings(events) };
    await persistSave(root, raw, "game", `game-${session}`);
    seen.set(dir, fingerprint);
  }
}
export async function setCapture(root: string, enabled: boolean, bundledPlugin: string) {
  const dir = saveDirectory(root); await fs.mkdir(dir, { recursive: true });
  const marker = path.join(dir, "capture.enabled");
  if (!enabled) { await fs.rm(marker, { force: true }); return captureState(root); }
  if (!(await fs.stat(path.join(root, "BepInEx", "core", "BepInEx.dll")).catch(() => null))) throw new Error("请先通过 HDD 设置安装 BepInEx，并确认游戏已启用 Mod 加载。");
  if (!(await fs.stat(bundledPlugin).catch(() => null))) throw new Error("此构建缺少游戏采集模块，请重新构建采集模块。");
  const target = path.join(root, "BepInEx", "plugins", "OGKToolBox.PlayerCapture.dll");
  await fs.mkdir(path.dirname(target), { recursive: true });
  const existing = await fs.readFile(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  const incoming = await fs.readFile(bundledPlugin);
  if (existing && !existing.equals(incoming)) await fs.copyFile(target, `${target}.${Date.now()}.bak`);
  await fs.writeFile(target, incoming);
  await fs.rm(path.join(dir, "capture-status.txt"), { force: true });
  await fs.writeFile(marker, "1", "utf8");
  return captureState(root);
}

// Whitelisted read requests from game capture or authenticated address/card discovery.
// No login/upsert, keychip guessing, or certificate validation overrides.
export function readGameApi(event: CaptureEvent, request: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const connection = event.connection;
  if (!connection || connection.encryptVersion !== 0) return Promise.reject(new Error("此会话未提供可用的明文协议连接信息；请使用随游戏采集。不会自动关闭协议加密。"));
  if (!allReadApis.includes(event.api as typeof allReadApis[number])) return Promise.reject(new Error("不允许调用非读取接口。"));
  const base = new URL(connection.baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || !base.pathname.endsWith("/")) return Promise.reject(new Error("游戏 API 地址无效。"));
  const url = new URL(event.api, base);
  if (!connection.userAgent || /[\r\n]/.test(connection.userAgent)) return Promise.reject(new Error("游戏请求标识无效。"));
  const body = deflateSync(Buffer.from(JSON.stringify({ ...request, nonce_: randomInt(0, 2147483647) })));
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(url, { method: "POST", signal, headers: { "Content-Type": "application/json", "Content-Encoding": "deflate", "User-Agent": connection.userAgent, "Content-Length": body.length, "Connection": "close" } }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`游戏服务器返回 HTTP ${response.statusCode}；可能需要有效游戏会话。原存档保留。`)); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 8 * 1024 * 1024) { response.destroy(new Error("服务器响应过大。")); return; } chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", () => {
        try {
          let bytes = Buffer.concat(chunks); const encoding = response.headers["content-encoding"];
          if (encoding === "deflate") bytes = inflateSync(bytes, { maxOutputLength: 8 * 1024 * 1024 });
          else if (encoding === "gzip") bytes = gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 });
          else if (encoding && encoding !== "identity") throw new Error();
          const data = JSON.parse(bytes.toString("utf8"));
          if (!data || Array.isArray(data) || typeof data !== "object" || data.userId !== request.userId) throw new Error();
          validatePayload(event.api, data);
          if (event.api === "GetUserActivityApi" && data.kind !== request.kind) throw new Error();
          resolve(data);
        } catch { reject(new Error("服务器响应无法解析或玩家身份不匹配；可能需要其他协议版本。原存档保留。")); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error("游戏服务器读取超时。")));
    req.on("error", error => reject(signal?.aborted ? new Error("已取消刷新，原存档保留。") : new Error(`无法读取游戏服务器：${(error as NodeJS.ErrnoException).code ?? "连接失败"}`)));
    req.end(body);
  });
}
export async function refreshFromGame(root: string, session: string, signal?: AbortSignal, call = readGameApi, scope?: SaveScope) {
  const seeds = await captureEvents(root, session);
  if (!seeds.length) throw new Error("请先启用随游戏采集并完成一次刷卡登录，以识别当前玩家和游戏 API 地址。");
  return refreshFromRequests(root, seeds, signal, call, session, scope);
}
export async function refreshFromRequests(root: string, seeds: CaptureEvent[], signal?: AbortSignal, call = readGameApi, sessionId?: string, scope?: SaveScope) {
  if (!seeds.length) throw new Error("没有可用的存档读取请求。");
  const events: CaptureEvent[] = [];
  const streams = [...new Map(seeds.map(event => [`${event.api}:${event.request.kind ?? ""}:${firstPage(event)}`, event])).values()];
  for (const seed of streams) {
    const paged = "nextIndex" in seed.request;
    let cursor = firstPage(seed); const visited = new Set<number>();
    for (let page = 0; ; page++) {
      if (signal?.aborted) throw new Error("已取消刷新，原存档保留。");
      if (page >= 500 || visited.has(cursor)) throw new Error("服务器分页没有结束，已停止刷新，原存档保留。");
      visited.add(cursor);
      const request = { ...seed.request, ...(paged ? { nextIndex: cursor, maxCount: 100 } : {}) };
      let response: Record<string, unknown>;
      try { response = await call(seed, request, signal); }
      catch (error) {
        // Older servers may not implement activity reads; keep the core save usable.
        if (seed.api === "GetUserActivityApi" && !signal?.aborted && /HTTP (404|405|501)\b/.test((error as Error).message)) break;
        throw error;
      }
      events.push({ ...seed, request, response, at: new Date().toISOString() });
      if (Buffer.byteLength(JSON.stringify(events)) > saveLimit) throw new Error("服务器存档超过 64 MB，已停止刷新。");
      if (!paged) break;
      if (!Number.isSafeInteger(response.nextIndex)) throw new Error("服务器分页字段无效，原存档保留。");
      if (Number(response.nextIndex) <= 0) break;
      cursor = Number(response.nextIndex);
    }
  }
  if (signal?.aborted) throw new Error("已取消刷新，原存档保留。");
  return persistSave(root, { format: "ogk-player-save-v1", ...(sessionId ? { sessionId } : {}), events, captureWarnings: captureWarnings(events) }, "direct", undefined, scope);
}
