import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { randomInt } from "node:crypto";
import { deflateSync, inflateSync, gunzipSync } from "node:zlib";
import { discoverPlayerServer, lookupPlayerCard, playerReadRequests, validatePlayerConnection } from "./player-bootstrap";
import { readGameApi, refreshFromRequests } from "./player-capture";
import { mergePlayerBest, requirePlayerScope, scopedPlayerSaves } from "./player-profiles";
import { readSave, saveDirectory, type CaptureEvent, type SaveScore, type SaveSummary } from "./player-save";
import { playerBestPlatinumMaxima } from "./player-best-metadata";
import { playerBestTechnicalRank, playerBestPlatinumRank } from "../src/player-best-merge";
import { playerGameProtocol, type PlayerGameProtocol } from "./player-game-protocol";
import { localPlayerDifficulty, serverPlayerDifficulty } from "./player-difficulty";
import { beginPlayerUpload } from "./player-upload-jobs";
import { PlayerUploadError, playerUploadResponseDiagnostic, type PlayerUploadDiagnostic } from "./player-upload-diagnostics";
import { requirePlayerScoreUpload } from "./player-upload-policy";
export { playerBestTechnicalRank, playerBestPlatinumRank } from "../src/player-best-merge";

type MusicDetail = {
  musicId: number; level: number; playCount: number; techScoreMax: number; techScoreRank: number;
  battleScoreMax: number; battleScoreRank: number; platinumScoreMax: number; platinumScoreStar: number;
  maxComboCount: number; maxOverKill: number; maxTeamOverKill: number; isFullBell: boolean;
  isFullCombo: boolean; isAllBreake: boolean; isLock: boolean; clearStatus: number; isStoryWatched: boolean;
};
export type PlayerBestUploadResult = { save: SaveSummary; uploadedCharts: number };
export type PlayerUpsertRequest = { userId: number; regionId: number; placeId: number; clientId: string; accessCode: string; upsertUserAll: Record<string, unknown> };
type UploadRequest = PlayerUpsertRequest;
type Services = {
  discover: typeof discoverPlayerServer; lookup: typeof lookupPlayerCard; read: typeof readGameApi;
  write: (baseUrl: string, request: UploadRequest, signal?: AbortSignal, userAgent?: string) => Promise<void>;
  protocol?: (root: string, signal?: AbortSignal) => Promise<PlayerGameProtocol>;
};
const numberFields = ["musicId", "level", "playCount", "techScoreMax", "techScoreRank", "battleScoreMax", "battleScoreRank", "platinumScoreMax", "platinumScoreStar", "maxComboCount", "maxOverKill", "maxTeamOverKill", "clearStatus"] as const;
const booleanFields = ["isFullBell", "isFullCombo", "isAllBreake", "isLock", "isStoryWatched"] as const;
const scoreFields = ["techScoreMax", "techScoreRank", "battleScoreMax", "platinumScoreMax", "platinumScoreStar", "isFullBell", "isFullCombo", "isAllBreake"] as const;
const key = (row: { musicId: number; level: number }) => `${row.musicId}:${row.level}`;
function cancel(signal?: AbortSignal) { if (signal?.aborted) throw new Error("已取消上传，本地合并成绩保留；已发送的成绩请重新获取确认。"); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

// Independent protocol adapter. The ordinary read adapter remains read-only.
// The music-only delta is a MuNET compatibility path, not the full game save
// contract. Its caller applies the configured-host policy before any network use.
export function writePlayerBestApi(baseUrl: string, request: UploadRequest, signal?: AbortSignal, userAgent?: string): Promise<void> {
  return writePlayerGameApi(baseUrl, "UpsertUserAllApi", request, [1], signal, userAgent);
}

function writePlayerGameApi(baseUrl: string, api: "UpsertUserAllApi", request: UploadRequest, successCodes: readonly (number | string)[], signal?: AbortSignal, userAgent?: string): Promise<void> {
  if (signal?.aborted) throw new PlayerUploadError({ stage: "transport", category: "cancelled" });
  let base: URL;
  try { base = new URL(baseUrl); } catch { return Promise.reject(new Error("游戏 API 地址无效。")); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || !base.pathname.endsWith("/")) return Promise.reject(new Error("游戏 API 地址无效。"));
  if (!Number.isSafeInteger(request.userId) || request.userId <= 0 || request.userId >= 0xffffffff || typeof userAgent !== "string" || !new RegExp(`^[0-9A-F]{32}#${request.userId}$`).test(userAgent)) return Promise.reject(new Error("游戏存档上传请求标识无效，未发送；本地存档保留。"));
  const body = deflateSync(Buffer.from(JSON.stringify({ ...request, nonce_: randomInt(0, 2147483647) })));
  if (body.length > 1024 * 1024) return Promise.reject(new Error("存档上传请求过大。"));
  const privateValues = [String(request.userId), request.accessCode, request.clientId, baseUrl, userAgent, userAgent.split("#")[0], ...base.pathname.split("/").filter(part => part.length >= 6)].filter((value): value is string => typeof value === "string");
  let inspected = 0;
  const rememberPrivateValues = (value: unknown, depth = 0) => {
    if (++inspected > 2048 || depth > 6) return;
    if (typeof value === "string") { if (value.length >= 6 && value.length <= 4096) privateValues.push(value); }
    else if (Array.isArray(value)) value.slice(0, 100).forEach(item => rememberPrivateValues(item, depth + 1));
    else if (record(value)) Object.values(value).slice(0, 200).forEach(item => rememberPrivateValues(item, depth + 1));
  };
  rememberPrivateValues(request.upsertUserAll);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0, settled = false, status: number | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (diagnostic?: PlayerUploadDiagnostic) => {
      if (settled) return;
      settled = true; if (deadline) clearTimeout(deadline);
      chunks.forEach(chunk => chunk.fill(0)); chunks.length = 0; body.fill(0);
      if (diagnostic) { reject(new PlayerUploadError(diagnostic)); req.destroy(); }
      else resolve();
    };
    const req = (base.protocol === "https:" ? https : http).request(new URL(api, base), { method: "POST", signal, headers: { "Content-Type": "application/json", "charset": "UTF-8", "Content-Encoding": "deflate", "User-Agent": userAgent, "Content-Length": body.length, "Connection": "close" } }, response => {
      status = response.statusCode;
      const stage = status === 200 ? "protocol" : "http";
      if (Number(response.headers["content-length"]) > 65536) { response.resume(); finish({ stage, category: "response_too_large", status }); return; }
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > 65536) { finish({ stage, category: "response_too_large", status }); response.destroy(); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.on("error", () => finish({ stage, category: signal?.aborted ? "cancelled" : "response_interrupted", status }));
      response.on("aborted", () => finish({ stage, category: signal?.aborted ? "cancelled" : "response_interrupted", status }));
      response.on("close", () => { if (!response.complete) finish({ stage, category: signal?.aborted ? "cancelled" : "response_interrupted", status }); });
      response.on("end", () => {
        if (settled) return;
        const wire = Buffer.concat(chunks); let decoded: Buffer | undefined;
        try {
          const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
          if (encoding === "deflate") decoded = inflateSync(wire, { maxOutputLength: 65536 });
          else if (encoding === "gzip") decoded = gunzipSync(wire, { maxOutputLength: 65536 });
          else if (!encoding || encoding === "identity") decoded = wire;
          else { finish({ stage, category: "invalid_response", status }); return; }
          let result: unknown;
          try { result = JSON.parse(decoded.toString("utf8")); } catch { /* HTML and plain text are deliberately not diagnostic input. */ }
          if (status !== 200) { finish(playerUploadResponseDiagnostic(status ?? 502, result, response.headers, privateValues)); return; }
          if (!record(result)) { finish({ stage, category: "invalid_response", status }); return; }
          if ((typeof result.returnCode !== "number" && typeof result.returnCode !== "string") || !successCodes.includes(result.returnCode)) {
            const diagnostic = playerUploadResponseDiagnostic(200, result, response.headers, privateValues);
            finish(result.returnCode === undefined ? { ...diagnostic, category: "missing_field", fields: ["returnCode"] } : diagnostic); return;
          }
          if (result.userId !== undefined && result.userId !== request.userId) { finish({ stage, category: "identity_mismatch", status, fields: ["userId"] }); return; }
          const name = api.slice(0, -3), responseNames = [api, name, name[0].toLowerCase() + name.slice(1)];
          if (result.apiName !== undefined && !responseNames.includes(String(result.apiName))) { finish({ stage, category: "invalid_response", status, fields: ["apiName"] }); return; }
          finish();
        } catch (error) {
          finish({ stage, category: record(error) && error.code === "ERR_BUFFER_TOO_LARGE" ? "response_too_large" : "invalid_response", status });
        } finally { wire.fill(0); decoded?.fill(0); }
      });
    });
    const timedOut = () => finish({ stage: "transport", category: signal?.aborted ? "cancelled" : "timeout", status });
    deadline = setTimeout(timedOut, 15000);
    req.setTimeout(15000, timedOut);
    req.on("error", () => finish({ stage: "transport", category: signal?.aborted ? "cancelled" : "transport_failure", status }));
    req.end(body);
  });
}

function detail(value: unknown): MusicDetail {
  if (!record(value)) throw new Error("服务器成绩明细无效，未上传。");
  const row = {} as MusicDetail;
  for (const field of numberFields) {
    const item = value[field] ?? 0;
    if (!Number.isSafeInteger(item) || Number(item) < 0 || Number(item) > 2147483647) throw new Error("服务器成绩字段无效，未上传。");
    (row[field] as number) = Number(item);
  }
  for (const field of booleanFields) {
    const item = value[field] ?? false;
    if (typeof item !== "boolean" && item !== 0 && item !== 1) throw new Error("服务器成绩标记无效，未上传。");
    row[field] = item === true || item === 1;
  }
  // Remote LUNATIC is protocol level 10. All comparison keys use chart index 4.
  row.level = localPlayerDifficulty(row.level);
  if (!Number.isSafeInteger(value.musicId) || !Number.isSafeInteger(value.level) || row.level > 4 || row.techScoreMax > 1019999 || row.techScoreRank > 12 || row.platinumScoreStar > 6) throw new Error("服务器曲目、难度或分数无效，未上传。");
  return row;
}
function validateScore(score: SaveScore) {
  if (!score || !Number.isSafeInteger(score.musicId) || score.musicId < 0 || score.musicId > 2147483647 || !Number.isSafeInteger(score.difficulty) || score.difficulty < 0 || score.difficulty > 4 || !Number.isSafeInteger(score.techScore) || score.techScore < 0 || score.techScore > 1010000) throw new Error("本地最佳成绩字段无效，未上传。");
  for (const [field, limit] of [["techScoreRank", 12], ["platinumScoreStar", 6], ["battleScore", 2147483647], ["platinumScore", 2147483647]] as const) if (score[field] !== undefined && (!Number.isSafeInteger(score[field]) || score[field]! < 0 || score[field]! > limit)) throw new Error("本地最佳成绩字段无效，未上传。");
  if ([score.fullBell, score.fullCombo, score.allBreak].some(value => typeof value !== "boolean")) throw new Error("本地最佳成绩标记无效，未上传。");
}
function musicRows(events: CaptureEvent[], userId: number): Map<string, MusicDetail> {
  const rows = new Map<string, MusicDetail>();
  for (const event of events.filter(event => event.api === "GetUserMusicApi")) {
    if (event.request.userId !== userId || event.response.userId !== userId || !Array.isArray(event.response.userMusicList)) throw new Error("服务器成绩玩家身份不匹配，未上传。");
    // PacketGetUserMusic uses response.length to iterate music groups; each
    // UserMusic.length separately counts its difficulty details. Neither is a
    // total across all pages. Reject explicit truncation before creating deltas.
    if (event.response.length !== undefined && (!Number.isSafeInteger(event.response.length) || event.response.length !== event.response.userMusicList.length)) throw new Error("服务器成绩分页的乐曲数量不一致，未上传。");
    for (const group of event.response.userMusicList) {
      if (!record(group) || !Array.isArray(group.userMusicDetailList)) throw new Error("服务器成绩分组无效，未上传。");
      if (group.length !== undefined && (!Number.isSafeInteger(group.length) || group.length !== group.userMusicDetailList.length)) throw new Error("服务器成绩分组的谱面数量不一致，未上传。");
      for (const raw of group.userMusicDetailList) {
        const row = detail(raw), id = key(row);
        if (rows.has(id)) throw new Error("服务器分页含重复谱面，未上传。");
        rows.set(id, row);
      }
    }
  }
  return rows;
}
async function archiveEvents(root: string, id: string) {
  const file = path.join(saveDirectory(root), "archives", `${id}.json`);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("存档记录已变化，请重新选择。");
  const stored = await readSave(file) as { raw?: { events?: CaptureEvent[] } };
  if (!Array.isArray(stored.raw?.events)) throw new Error("服务器读取存档缺少原始响应，未上传。");
  return stored.raw.events;
}
export function playerBestDelta(scores: SaveScore[], remote: Map<string, MusicDetail>, platinumMaxima = new Map<string, number>()) {
  const changes: MusicDetail[] = [], isNew: string[] = [];
  if (!Array.isArray(scores) || scores.length > 50000) throw new Error("本地最佳成绩列表无效，未上传。");
  const seen = new Set<string>();
  for (const score of scores) {
    validateScore(score);
    const id = `${score.musicId}:${score.difficulty}`;
    if (seen.has(id)) throw new Error("本地最佳成绩包含重复谱面，未上传。");
    seen.add(id);
    const old = remote.get(id), row = old ? { ...old } : detail({ musicId: score.musicId, level: score.difficulty });
    if (!old && score.techScore === 0 && !(score.battleScore ?? 0) && !(score.platinumScore ?? 0) && !(score.platinumScoreStar ?? 0) && !score.fullBell && !score.fullCombo && !score.allBreak) continue;
    row.techScoreMax = Math.max(row.techScoreMax, score.techScore);
    row.techScoreRank = Math.max(row.techScoreRank, score.techScoreRank ?? playerBestTechnicalRank(score.techScore));
    row.battleScoreMax = Math.max(row.battleScoreMax, score.battleScore ?? 0);
    row.platinumScoreMax = Math.max(row.platinumScoreMax, score.platinumScore ?? 0);
    const maximum = platinumMaxima.get(id);
    const stars = score.platinumScoreStar ?? (score.platinumScore !== undefined && maximum !== undefined ? playerBestPlatinumRank(score.platinumScore, maximum) : 0);
    row.platinumScoreStar = Math.max(row.platinumScoreStar, stars);
    row.isFullBell ||= score.fullBell; row.isFullCombo ||= score.fullCombo; row.isAllBreake ||= score.allBreak;
    if (!old || scoreFields.some(field => row[field] !== old[field])) { changes.push(row); isNew.push(old ? "0" : "1"); }
  }
  return { changes, isNew: isNew.join("") };
}
function contains(actual: MusicDetail | undefined, expected: MusicDetail) {
  return !!actual && scoreFields.every(field => typeof expected[field] === "boolean" ? !expected[field] || actual[field] === true : Number(actual[field]) >= Number(expected[field]));
}

export async function uploadPlayerBest(root: string, saveId: string, cardId: string, serverId: string, signal?: AbortSignal, services: Services = { discover: discoverPlayerServer, lookup: lookupPlayerCard, read: readGameApi, write: writePlayerBestApi }): Promise<PlayerBestUploadResult> {
  if (typeof saveId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(saveId)) throw new Error("请选择有效存档。");
  const release = beginPlayerUpload(root);
  let sent = 0;
  try {
    cancel(signal);
    const { config, scope } = await requirePlayerScope(root, cardId, serverId);
    requirePlayerScoreUpload(config.server);
    const assertTarget = async () => {
      cancel(signal);
      const current = await requirePlayerScope(root, cardId, serverId);
      requirePlayerScoreUpload(current.config.server);
      if (JSON.stringify(current.config) !== JSON.stringify(config)) throw new Error("服务器连接或卡号配置已变化，请重新同步。");
    };
    const local = (await scopedPlayerSaves(root)).find(save => save.id === saveId);
    if (!local || local.scope?.cardId !== cardId || local.scope.serverId !== serverId) throw new Error("存档不属于当前服务器和卡号，未上传。");
    // Fail before network discovery if an imported/edited local archive is invalid.
    playerBestDelta(local.scores, new Map());
    const platinumMaxima = await playerBestPlatinumMaxima(root, local.scores, signal);
    const connection = validatePlayerConnection(config);
    const protocol = await (services.protocol ?? playerGameProtocol)(root, signal);
    await assertTarget();
    const discovered = await services.discover(config, signal, { omitUserAgent: true });
    await assertTarget();
    const userId = await services.lookup(config, discovered.placeId, signal);
    if (!Number.isSafeInteger(userId) || userId <= 0 || userId >= 0xffffffff) throw new Error("目标服务器玩家身份无效，未上传。");
    const seeds = playerReadRequests(discovered.baseUrl, userId, protocol.userAgent);
    // Full fresh read is a durable, separate pre-upload backup of the target.
    await assertTarget();
    const backup = await refreshFromRequests(root, seeds, signal, services.read, undefined, scope);
    let remote = musicRows(await archiveEvents(root, backup.id), userId);
    const firstDelta = playerBestDelta(local.scores, remote, platinumMaxima);
    if (!firstDelta.changes.length) return { save: backup.id === local.id ? local : await mergePlayerBest(root, local.id, [backup.id], cardId, serverId), uploadedCharts: 0 };
    const expected = new Map(remote);
    firstDelta.changes.forEach(row => expected.set(key(row), row));
    // Keep requests small, and recheck config before every write. No implicit retry:
    // a dropped response may mean the server already applied part of the upload.
    for (let offset = 0; offset < firstDelta.changes.length; offset += 100) {
      await assertTarget();
      const rows = firstDelta.changes.slice(offset, offset + 100);
      const protocolRows = rows.map(row => ({ ...row, level: serverPlayerDifficulty(row.level) }));
      await services.write(discovered.baseUrl, { userId, regionId: 0, placeId: discovered.placeId, clientId: connection.keychipShort, accessCode: connection.accessCode, upsertUserAll: { userMusicDetailList: protocolRows, isNewMusicDetailList: firstDelta.isNew.slice(offset, offset + 100) } }, signal, protocol.userAgent("UpsertUserAllApi", userId));
      sent += rows.length;
    }
    await assertTarget();
    const verified = await refreshFromRequests(root, seeds, signal, services.read, undefined, scope);
    await assertTarget();
    remote = musicRows(await archiveEvents(root, verified.id), userId);
    const missing = [...expected.values()].filter(row => !contains(remote.get(key(row)), row)).length;
    if (missing) throw new Error(`服务器回读仍有 ${missing} 张谱面未同步，可能不支持成绩上传；本地合并成绩保留。`);
    // Keep the user's combined local view; fold in any higher target scores found
    // during validation. The separate server read retains its actual server rating.
    const combined = verified.id === local.id ? local : await mergePlayerBest(root, local.id, [verified.id], cardId, serverId);
    return { save: combined, uploadedCharts: firstDelta.changes.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "成绩上传失败。";
    if (sent && !/回读|已发送|部分/.test(message)) throw new Error(`已发送 ${sent} 张谱面，后续未完成。${message} 本地合并成绩保留，可重新同步确认。`);
    throw error;
  } finally { release(); }
}
