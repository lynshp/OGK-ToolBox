import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { saveOwnerKey, validScope, type SaveScope } from "./player-identity";
import type { BestMergeMetadata } from "../src/player-best-merge";
import { saveFingerprint } from "./player-save-fingerprint";
import { itemKey, playerItemNames } from "./player-item-catalog";
import { localPlayerDifficulty } from "./player-difficulty";

export type SaveScore = { musicId: number; difficulty: number; techScore: number; techScoreRank?: number; platinumScoreStar?: number; battleScore?: number; platinumScore?: number; playCount?: number; maxComboCount?: number; maxOverKill?: number; maxTeamOverKill?: number; battleScoreRank?: number; clearStatus?: number; fullCombo: boolean; fullBell: boolean; allBreak: boolean };
export type RecentPlay = { musicId: number; difficulty?: number; playedAt: string; techScore?: number };
export type SaveItem = { itemKind: number; itemId: number; name?: string; stock?: number; isValid?: boolean };
export type SaveInventory = { version: 1; cardCount?: number; items: SaveItem[]; itemsRecorded: boolean };
export type SaveSummary = { edit?: import("../src/player-save-editor-models").PlayerSaveEditMetadata; localPlayerId?: string; ratingVersion?: 1; newPlayerRating?: number; recentPlays?: RecentPlay[]; recentPlaysRecorded?: boolean; unchanged?: boolean; ignored?: boolean; sequence?: number; serverId?: string; serverLabel?: string; bestMerge?: BestMergeMetadata; ownerKeys?: string[]; captureIds?: string[]; latestCapture?: { id: string; at: string }; scope?: SaveScope; ownerKey?: string; id: string; source: "json" | "game" | "direct"; sessionId?: string; updatedAt: string; playerName: string; scores: SaveScore[]; collections: { name: string; count: number }[]; inventory: SaveInventory; warnings: string[] };
export type CaptureEvent = { api: string; request: Record<string, unknown>; response: Record<string, unknown>; at: string; connection?: { baseUrl: string; encryptVersion: number; userAgent: string } };
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const flag = (value: unknown) => value === true || value === 1;
export function playerSaveEditMetadata(value: unknown): SaveSummary["edit"] {
  if (value === undefined) return undefined;
  const validId = (id: unknown) => typeof id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(id);
  const integer = (n: unknown, max = 2147483647) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= max;
  const fail = () => { throw new Error("修改存档字段无效，原存档保留。"); };
  if (!record(value) || value.version !== 1 || !validId(value.parentId) || !validId(value.playerId)
      || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
      || !Array.isArray(value.resources) || value.resources.length > 50000 || !Array.isArray(value.scores) || value.scores.length > 50000) return fail();
  const resources = value.resources.map((row: unknown) => {
    if (!record(row) || typeof row.key !== "string" || !/^(?:data:(?:point|jewelCount|medalCount|shizukuCount)|item:(?:4|9|11|12|13|14|20):\d{1,10}|(?:chapter|story):\d{1,10})$/.test(row.key) || !integer(row.value)) return fail();
    return { key: row.key, value: row.value as number };
  });
  const scores = value.scores.map((row: unknown) => {
    if (!record(row) || !integer(row.musicId) || !integer(row.difficulty, 4) || !integer(row.techScore, 1010000)
        || !integer(row.platinumScore) || !integer(row.battleScore) || [row.fullCombo, row.fullBell, row.allBreak].some(flag => typeof flag !== "boolean")) return fail();
    const extra: Record<string, number> = {};
    for (const field of ["playCount", "maxComboCount", "maxOverKill", "maxTeamOverKill", "battleScoreRank", "clearStatus"]) if (row[field] !== undefined) {
      if (!integer(row[field], field === "battleScoreRank" ? 11 : field === "clearStatus" ? 1 : 2147483647) || field === "playCount" && row[field] < 1) return fail();
      extra[field] = row[field];
    }
    return { ...extra, musicId: row.musicId as number, difficulty: row.difficulty as number, techScore: row.techScore as number,
      platinumScore: row.platinumScore as number, battleScore: row.battleScore as number,
      fullCombo: row.fullCombo as boolean, fullBell: row.fullBell as boolean, allBreak: row.allBreak as boolean };
  });
  if (new Set(resources.map(row => row.key)).size !== resources.length || new Set(scores.map(row => `${row.musicId}:${row.difficulty}`)).size !== scores.length) return fail();
  return { version: 1, parentId: value.parentId, playerId: value.playerId, createdAt: value.createdAt, resources, scores };
}
export const saveLimit = 64 * 1024 * 1024;
export const bestMergeFormat = "ogk-toolbox-player-best";

export function safeServerLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 260 || /[\s/@?#\\]/.test(value)) return undefined;
  try {
    const url = new URL(`http://${value}`);
    return !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash ? url.host : undefined;
  } catch { return undefined; }
}
export function serverLabelFromRaw(raw: unknown): string | undefined {
  if (!record(raw)) return undefined;
  if (record(raw.summary) && (record(raw.raw) || Array.isArray(raw.raw))) return safeServerLabel(raw.summary.serverLabel) ?? serverLabelFromRaw(raw.raw);
  if (raw.format === bestMergeFormat) return safeServerLabel(raw.serverLabel);
  if (!Array.isArray(raw.events)) return undefined;
  const hosts = new Set<string>();
  for (const event of raw.events) {
    if (typeof event?.connection?.baseUrl !== "string") continue;
    try {
      const url = new URL(event.connection.baseUrl);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
      hosts.add(url.host);
    } catch { return undefined; }
  }
  return hosts.size === 1 ? [...hosts][0] : undefined;
}

// This format contains one canonical player snapshot and provenance identifiers,
// never the source servers' raw responses. Do not walk provenance as player data.
function summarizeBestMerge(raw: Record<string, any>, source: SaveSummary["source"], id: string): SaveSummary {
  const fail = () => { throw new Error("合并存档字段无效，原有存档未改动。"); };
  const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const optionalInteger = (value: unknown) => value === undefined || integer(value);
  const validId = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);
  const player = raw.player, merge = raw.bestMerge;
  if (raw.version !== 1 || !record(player) || !record(merge) || !validScope(raw.scope)
      || typeof player.playerName !== "string" || player.playerName.length > 80 || !Array.isArray(player.scores)
      || player.scores.length > 500000 || !validId(merge.targetId) || !Array.isArray(merge.sourceIds)
      || !merge.sourceIds.length || merge.sourceIds.length > 500 || merge.sourceIds.some((value: unknown) => !validId(value))
      || new Set(merge.sourceIds).size !== merge.sourceIds.length || merge.version !== 1
      || typeof merge.createdAt !== "string" || !Number.isFinite(Date.parse(merge.createdAt))) fail();
  const scores = player.scores.map((row: any) => {
    if (!record(row) || !integer(row.musicId) || !integer(row.difficulty) || row.difficulty > 4 || !integer(row.techScore) || row.techScore > 1010000
        || !optionalInteger(row.techScoreRank) || row.techScoreRank > 12 || !optionalInteger(row.platinumScoreStar) || row.platinumScoreStar > 6
        || !optionalInteger(row.platinumScore) || !optionalInteger(row.battleScore) || !optionalInteger(row.playCount)
        || [row.fullCombo, row.fullBell, row.allBreak].some(value => typeof value !== "boolean")) fail();
    return { musicId: row.musicId, difficulty: row.difficulty, techScore: row.techScore,
      techScoreRank: row.techScoreRank, platinumScoreStar: row.platinumScoreStar, platinumScore: row.platinumScore,
      battleScore: row.battleScore, playCount: row.playCount, maxComboCount: row.maxComboCount, maxOverKill: row.maxOverKill, maxTeamOverKill: row.maxTeamOverKill, battleScoreRank: row.battleScoreRank, clearStatus: row.clearStatus, isFullCombo: row.fullCombo, isFullBell: row.fullBell, isAllBreake: row.allBreak };
  });
  const inventory = player.inventory;
  if (!record(inventory) || inventory.version !== 1 || !optionalInteger(inventory.cardCount) || typeof inventory.itemsRecorded !== "boolean"
      || !Array.isArray(inventory.items) || inventory.items.length > 500000) fail();
  const items: SaveItem[] = inventory.items.map((row: any) => {
    if (!record(row) || !integer(row.itemKind) || !integer(row.itemId) || !optionalInteger(row.stock)
        || row.isValid !== undefined && typeof row.isValid !== "boolean" || row.name !== undefined && (typeof row.name !== "string" || row.name.length > 200)) fail();
    return { itemKind: row.itemKind, itemId: row.itemId, stock: row.stock, isValid: row.isValid, name: row.name };
  });
  if (!Array.isArray(player.collections) || player.collections.length > 500000 || player.collections.some((row: any) => !record(row) || typeof row.name !== "string" || row.name.length > 100 || !integer(row.count))
      || typeof player.recentPlaysRecorded !== "boolean" || !Array.isArray(player.recentPlays) || player.recentPlays.length > 100
      || player.recentPlays.some((row: any) => !record(row) || !integer(row.musicId) || !optionalInteger(row.difficulty) || row.difficulty > 4
        || typeof row.playedAt !== "string" || !Number.isFinite(Date.parse(row.playedAt)) || !optionalInteger(row.techScore) || row.techScore > 1010000)
      || !Array.isArray(player.warnings) || player.warnings.length > 100 || player.warnings.some((value: unknown) => typeof value !== "string" || value.length > 2000)
      || !Array.isArray(merge.sources) || merge.sources.length !== merge.sourceIds.length
      || merge.sources.some((row: any) => !record(row) || !validId(row.id) || !merge.sourceIds.includes(row.id) || !/^[a-f0-9]{64}$/.test(row.serverId)
        || typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt)) || row.serverLabel !== undefined && !safeServerLabel(row.serverLabel))
      || new Set(merge.sources.map((row: any) => row.id)).size !== merge.sourceIds.length) fail();
  const result = summarizeSave({ userData: { userName: player.playerName }, userMusicDetailList: scores }, source, id);
  result.inventory = { version: 1, cardCount: inventory.cardCount, itemsRecorded: inventory.itemsRecorded, items };
  result.collections = player.collections.map((row: any) => ({ name: row.name, count: row.count }));
  result.recentPlays = player.recentPlays.map((row: any) => ({ musicId: row.musicId, difficulty: row.difficulty, playedAt: row.playedAt, techScore: row.techScore }));
  result.recentPlaysRecorded = player.recentPlaysRecorded;
  result.warnings = [...new Set<string>([...player.warnings, "本地合并最佳成绩；资源、卡片与最近记录沿用目标存档。"] )];
  result.bestMerge = { version: 1, targetId: merge.targetId, sourceIds: [...merge.sourceIds], createdAt: merge.createdAt,
    sources: merge.sources.map((row: any) => ({ id: row.id, serverId: row.serverId, serverLabel: safeServerLabel(row.serverLabel), updatedAt: row.updatedAt })) };
  result.serverLabel = safeServerLabel(raw.serverLabel);
  return result;
}

// Accept known score shapes, never mistake a song catalog or an arbitrary JSON for a save.
export function summarizeSave(raw: unknown, source: SaveSummary["source"], id: string = randomUUID()): SaveSummary {
  if (!record(raw) && !Array.isArray(raw)) throw new Error("存档必须是 JSON 对象或成绩数组。");
  let payload: unknown = raw, wrapperDepth = 0;
  while (record(payload) && record(payload.summary) && Array.isArray(payload.summary.scores)) {
    if (++wrapperDepth > 24 || (!record(payload.raw) && !Array.isArray(payload.raw))) throw new Error("存档原始内容无效或嵌套过深，原存档保留。");
    payload = payload.raw;
  }
  if (record(payload) && payload.format === bestMergeFormat) return { ...summarizeBestMerge(payload, source, id), edit: playerSaveEditMetadata(payload.saveEdit) };
  const scores = new Map<string, SaveScore>();
  const collections = new Map<string, number>();
  const items = new Map<string, SaveItem>(), cards = new Set<number>();
  let itemsRecorded = false, cardsRecorded = false, invalidInventory = false;
  const integer = (value: unknown): number | undefined => {
    const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : number(value);
    return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const warnings: string[] = [];
  if (!Array.isArray(raw) && Array.isArray(raw.captureWarnings)) warnings.push(...raw.captureWarnings.filter((item: unknown): item is string => typeof item === "string").slice(0, 30));
  let playerName = "未命名玩家", visited = 0, recognized = false;
  const recent = new Map<string, RecentPlay>();
  let recentPlaysRecorded = false, newPlayerRating: number | undefined;
  const playTime = (date: unknown): number | undefined => {
    const time = typeof date === "number" ? date * (date < 1e12 ? 1000 : 1) : typeof date === "string" ? Date.parse(date) : NaN;
    return Number.isFinite(time) && time > 0 && time <= 8640000000000000 ? time : undefined;
  };
  const addRecent = (music: unknown, date: unknown, level?: unknown, score?: unknown) => {
    const musicId = integer(music), exportedLevel = integer(level), difficulty = exportedLevel === undefined ? undefined : localPlayerDifficulty(exportedLevel), techScore = integer(score);
    const time = playTime(date);
    if (musicId === undefined || time === undefined || (level !== undefined && (difficulty === undefined || difficulty > 4))) return;
    const playedAt = new Date(time).toISOString();
    recent.set(`${musicId}:${difficulty ?? ""}:${playedAt}`, { musicId, difficulty, playedAt, techScore: techScore !== undefined && techScore <= 1010000 ? techScore : undefined });
  };
  const owners = new Set<string>();
  const addOwner = (userId: unknown) => {
    if (typeof userId === "number" || typeof userId === "string") owners.add(String(userId));
    if (owners.size > 1) throw new Error("文件包含多位玩家，请分别导出和导入，避免成绩混合。");
  };
  const walk = (value: unknown, depth: number, key = "", parentKind?: number, responseOwned = false) => {
    if (++visited > 500000 || depth > 24) throw new Error("存档结构过大或嵌套过深。");
    if (Array.isArray(value)) {
      if (/^(user)?playlogs?(list|s)?$/i.test(key)) {
        recentPlaysRecorded = true; recognized = true;
        for (const row of value) if (record(row)) {
          if (!responseOwned) addOwner(row.userId);
          const date = [row.userPlayDate, row.playDate, row.playedAt].find(date => playTime(date) !== undefined);
          addRecent(row.musicId, date, row.level ?? row.difficulty, row.techScore ?? row.technicalScore);
        }
        return;
      }
      if (/^(user)?(card|character|item|chapter|story|music|musicdetail|option|deck|trophy)(list|s)?$/i.test(key)) {
        collections.set(key, (collections.get(key) ?? 0) + value.length); recognized = true;
      }
      if (/^(user)?(itemlist|items)$/i.test(key)) {
        itemsRecorded = true;
        for (const row of value) {
          if (!record(row)) { invalidInventory = true; continue; }
          const itemKind = integer(row.itemKind) ?? parentKind, itemId = integer(row.itemId);
          if (itemKind === undefined || itemId === undefined) { invalidInventory = true; continue; }
          const stock = integer(row.stock ?? row.quantity ?? row.count);
          if (stock === undefined && (row.stock ?? row.quantity ?? row.count) !== undefined) invalidInventory = true;
          const isValid = typeof row.isValid === "boolean" ? row.isValid : row.isValid === 0 ? false : row.isValid === 1 ? true : undefined;
          const name = typeof (row.itemName ?? row.name) === "string" ? String(row.itemName ?? row.name).trim().slice(0, 200) : undefined;
          const previous = items.get(itemKey(itemKind, itemId));
          // Repeated pages describe the same holding; never add the stock twice.
          items.set(itemKey(itemKind, itemId), { itemKind, itemId, stock: stock ?? previous?.stock, name: name || previous?.name, isValid: isValid ?? previous?.isValid });
        }
      }
      if (/^(user)?(cardlist|cards)$/i.test(key)) {
        cardsRecorded = true;
        for (const row of value) {
          const id = record(row) ? integer(row.cardId) : undefined;
          if (id !== undefined) cards.add(id); else invalidInventory = true;
        }
      }
      value.forEach(item => walk(item, depth + 1, "", undefined, responseOwned)); return;
    }
    if (!record(value)) return;
    // A toolbox export contains both a derived summary and its original data.
    if (record(value.summary) && Array.isArray(value.summary.scores) && (record(value.raw) || Array.isArray(value.raw))) { walk(value.raw, depth + 1); return; }
    if (!responseOwned && allReadApis.includes(value.api) && record(value.request) && record(value.response)) {
      const userId = value.request.userId;
      if (!Number.isSafeInteger(userId) || userId <= 0 || value.response.userId !== userId) throw new Error("存档响应的玩家身份不匹配。");
      addOwner(userId);
      if (value.api === "GetUserActivityApi") {
        if (value.request.kind === 2 && value.response.kind === 2 && Array.isArray(value.response.userActivityList)) {
          recentPlaysRecorded = true; recognized = true;
          for (const row of value.response.userActivityList) if (record(row) && row.kind === 2) addRecent(row.id, row.sortNumber);
        }
        return;
      }
      // The protocol envelope owns this payload. Some servers include extra row-level
      // userId metadata absent from the game's UserMusicDetail schema.
      walk(value.response, depth + 1, "response", undefined, true);
      return;
    }
    if (key === "userData" || typeof value.userName === "string") {
      newPlayerRating = integer(value.newPlayerRating) ?? newPlayerRating;
      for (const [field, itemKind, name] of [["point", 6, "金币"], ["jewelCount", 5, "通用珠"], ["medalCount", 18, "勋章"], ["shizukuCount", 21, "雫"]] as const) {
        const stock = integer(value[field]);
        if (stock !== undefined) items.set(itemKey(itemKind, 0), { itemKind, itemId: 0, name, stock });
      }
    }
    if (!responseOwned) addOwner(value.userId);
    if (typeof value.userName === "string") { playerName = value.userName.slice(0, 80); recognized = true; }
    // Game responses and MuNET exports use LUNATIC level 10; local charts use index 4.
    // Keep the original raw record for export and normalize only the display model.
    const musicId = number(value.musicId), exportedLevel = number(value.level ?? value.difficulty), difficulty = exportedLevel === undefined ? undefined : localPlayerDifficulty(exportedLevel);
    const techScore = number(value.techScoreMax ?? value.techScore ?? value.technicalScore);
    if (musicId !== undefined && difficulty !== undefined && techScore !== undefined) {
      if (!Number.isInteger(musicId) || musicId < 0 || !Number.isInteger(difficulty) || difficulty < 0 || difficulty > 4 || !Number.isInteger(techScore) || techScore < 0 || techScore > 1019999) {
        throw new Error("成绩字段无效：请检查曲目 ID、难度和技术分数。");
      }
      recognized = true;
      // Full-score repetition uses a raw counter up to 1,019,999 in game 1.50;
      // the visible technical maximum remains 1,010,000.
      const rank = integer(value.techScoreRank), stars = integer(value.platinumScoreStar);
      const item: SaveScore = { musicId, difficulty, techScore: Math.min(techScore, 1010000), techScoreRank: rank !== undefined && rank <= 12 ? rank : undefined, platinumScoreStar: stars !== undefined && stars <= 6 ? stars : undefined, battleScore: number(value.battleScoreMax ?? value.battleScore), platinumScore: number(value.platinumScoreMax ?? value.platinumScore), playCount: number(value.playCount), maxComboCount: integer(value.maxComboCount), maxOverKill: integer(value.maxOverKill), maxTeamOverKill: integer(value.maxTeamOverKill), battleScoreRank: integer(value.battleScoreRank), clearStatus: integer(value.clearStatus), fullCombo: flag(value.isFullCombo), fullBell: flag(value.isFullBell), allBreak: flag(value.isAllBreake ?? value.isAllBreak) };
      const scoreKey = `${musicId}:${difficulty}`, previous = scores.get(scoreKey);
      if (!previous) scores.set(scoreKey, item);
      else scores.set(scoreKey, { ...item, techScore: Math.max(previous.techScore, item.techScore), techScoreRank: max(previous.techScoreRank, item.techScoreRank), platinumScoreStar: max(previous.platinumScoreStar, item.platinumScoreStar), battleScore: max(previous.battleScore, item.battleScore), platinumScore: max(previous.platinumScore, item.platinumScore), playCount: max(previous.playCount, item.playCount), maxComboCount: max(previous.maxComboCount, item.maxComboCount), maxOverKill: max(previous.maxOverKill, item.maxOverKill), maxTeamOverKill: max(previous.maxTeamOverKill, item.maxTeamOverKill), battleScoreRank: max(previous.battleScoreRank, item.battleScoreRank), clearStatus: max(previous.clearStatus, item.clearStatus), fullCombo: previous.fullCombo || item.fullCombo, fullBell: previous.fullBell || item.fullBell, allBreak: previous.allBreak || item.allBreak });
      return;
    }
    for (const [childKey, child] of Object.entries(value)) {
      if (childKey === "request" || childKey === "connection" || childKey === "saveEdit" || /rival/i.test(childKey)) continue;
      if (childKey === "userData" && record(child)) recognized = true;
      walk(child, depth + 1, childKey, integer(value.itemKind), responseOwned);
    }
  };
  walk(raw, 0);
  if (!recognized) throw new Error("未识别出音击玩家或成绩字段，原有存档未改动。");
  if (!scores.size) warnings.push("此文件没有可识别的成绩记录；不代表玩家没有成绩。");
  if (invalidInventory) warnings.push("部分道具或卡片字段无效，已保留可识别记录；缺失数量显示为 —。");
  warnings.push(source === "json" ? "仅展示文件中提供的数据；未验证服务器存档是否完整。" : "仅包含已成功读取的数据；不代表完整游玩历史或可直接回服的备份。");
  return { edit: playerSaveEditMetadata(record(payload) ? payload.saveEdit : undefined), ratingVersion: 1, newPlayerRating: record(payload) && payload.saveEdit ? undefined : newPlayerRating, recentPlays: [...recent.values()].sort((a, b) => b.playedAt.localeCompare(a.playedAt)).slice(0, 100), recentPlaysRecorded, id, source, updatedAt: new Date().toISOString(), playerName, scores: [...scores.values()].sort((a, b) => a.musicId - b.musicId || a.difficulty - b.difficulty), collections: [...collections].map(([name, count]) => ({ name, count })), inventory: { version: 1, cardCount: cardsRecorded ? cards.size : undefined, items: [...items.values()].sort((a, b) => a.itemKind - b.itemKind || a.itemId - b.itemId), itemsRecorded }, warnings };
}
function max(a?: number, b?: number) { return a === undefined ? b : b === undefined ? a : Math.max(a, b); }
export function parseSave(text: string): unknown {
  if (Buffer.byteLength(text) > saveLimit) throw new Error("JSON 存档不能超过 64 MB。");
  try { return JSON.parse(text.replace(/^\uFEFF/, "")); } catch { throw new Error("文件不是有效的 JSON，原有存档未改动。"); }
}
export async function readSave(file: string) {
  if ((await fs.stat(file)).size > saveLimit) throw new Error("JSON 存档不能超过 64 MB。");
  return parseSave(await fs.readFile(file, "utf8"));
}
export function saveDirectory(root: string) { return path.join(root, "Tools", "OGKToolBox", "player-data"); }
const archiveJobs = new Map<string, Promise<unknown>>();
export async function archiveSerial<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(root).toLowerCase(), prior = archiveJobs.get(key) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(action); archiveJobs.set(key, next);
  try { return await next; } finally { if (archiveJobs.get(key) === next) archiveJobs.delete(key); }
}
async function deletedCaptures(root: string): Promise<string[]> {
  const file = path.join(saveDirectory(root), "deleted-captures.json");
  try {
    if ((await fs.stat(file)).size > 1024 * 1024) throw new Error();
    const ids = JSON.parse(await fs.readFile(file, "utf8"));
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !/^game-[a-f0-9]{32}$/.test(id))) throw new Error();
    return ids;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("删除记录无法读取，请检查本地存档目录。");
  }
}
export async function isCaptureDeleted(root: string, session: string): Promise<boolean> {
  if (!/^[a-f0-9]{32}$/.test(session)) throw new Error("采集会话无效。");
  return archiveSerial(root, async () => (await deletedCaptures(root)).includes(`game-${session}`));
}
export async function persistSave(root: string, raw: unknown, source: SaveSummary["source"], id: string = randomUUID(), scope?: SaveScope, serverId?: string, resolveScope?: () => Promise<SaveScope>): Promise<SaveSummary> {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("存档编号无效。");
  const summary = summarizeSave(raw, source, id);
  summary.serverLabel = serverLabelFromRaw(raw) ?? summary.serverLabel;
  summary.scope = scope; summary.serverId = scope?.serverId ?? serverId; summary.ownerKey = saveOwnerKey(raw);
  summary.ownerKeys = summary.ownerKey ? [summary.ownerKey] : [];
  summary.captureIds = source === "game" && /^game-[a-f0-9]{32}$/.test(id) ? [id] : [];
  if (source !== "json" && record(raw) && typeof raw.sessionId === "string" && /^[a-f0-9]{32}$/.test(raw.sessionId)) summary.sessionId = raw.sessionId;
  const settledCapture = source === "game" && record(raw) && summary.sessionId && raw.settlementSessionId === summary.sessionId;
  if (settledCapture) summary.captureIds = [...new Set([...summary.captureIds!, `game-${summary.sessionId}`])];
  if (source === "game" && record(raw) && Array.isArray(raw.events)) {
    const dates = raw.events.map(event => record(event) && typeof event.at === "string" ? Date.parse(event.at) : NaN).filter(Number.isFinite);
    if (dates.length) summary.updatedAt = new Date(Math.max(...dates)).toISOString();
    // A session alias may arrive before its pages. Only an actual, complete
    // game read advances the selection revision; polling never supplies time.
    if ((id === `game-${summary.sessionId}` || settledCapture) && /^game-[a-f0-9]{32}$/.test(id)
      && dates.length === raw.events.length && raw.events.length > 0
      && raw.events.every(event => record(event) && typeof event.api === "string" && record(event.request) && record(event.response))
      && captureWarnings(raw.events).length === 0) summary.latestCapture = { id, at: summary.updatedAt };
  }
  return archiveSerial(root, async () => {
    // Suppress the entire deleted capture session, including after restart or new pages arriving.
    if (source === "game" && (await deletedCaptures(root)).some(deleted => deleted === id || settledCapture && deleted === `game-${summary.sessionId}`)) return { ...summary, ignored: true };
    // Owned capture callers hold the profiles queue before this archives queue.
    // Resolve/add the player only after checking deletion under the same lock
    // that commits the archive, so deletion cannot race into profile creation.
    if (resolveScope) {
      if (source !== "game") throw new Error("仅游戏采集可自动归属玩家。");
      scope = await resolveScope();
      if (!validScope(scope)) throw new Error("采集存档归属无效。");
      summary.scope = scope; summary.serverId = scope.serverId;
    }
    const dir = path.join(saveDirectory(root), "archives"); await fs.mkdir(dir, { recursive: true });
    const fingerprint = saveFingerprint(raw);
    if (source !== "json") {
      const names = (await fs.readdir(dir)).filter(name => /^[a-zA-Z0-9-]{1,80}\.json$/.test(name));
      let previous: { summary: SaveSummary; raw: unknown; fingerprint?: string } | undefined;
      let previousFile = "", unassignedCaptureFile = "", maxSequence = 0;
      for (const name of names) {
        const stored = await readSave(path.join(dir, name)) as typeof previous;
        if (!stored?.summary) continue;
        const candidate = stored.summary;
        // A late ownership sidecar can make this same session identical to a
        // scoped archive. Retire its earlier unassigned copy after preserving
        // the session alias on the canonical archive; never tombstone it.
        if (source === "game" && scope && candidate.source === "game" && candidate.id === id && !candidate.scope
          && (candidate.captureIds ?? [id]).every(captureId => captureId === id)) unassignedCaptureFile = path.join(dir, name);
        maxSequence = Math.max(maxSequence, candidate.sequence ?? 0);
        const sameGroup = scope ? candidate.scope?.serverId === scope.serverId && candidate.scope.cardId === scope.cardId
          : !candidate.scope && !!summary.ownerKey && (candidate.ownerKey ?? saveOwnerKey(stored.raw)) === summary.ownerKey;
        // Local edits remain export history. A real read must retain its own
        // provenance even when the server now returns those exact edited values.
        if (sameGroup && !candidate.edit && (!previous || (candidate.updatedAt > previous.summary.updatedAt || candidate.updatedAt === previous.summary.updatedAt && (candidate.sequence ?? 0) > (previous.summary.sequence ?? 0)))) { previous = stored; previousFile = path.join(dir, name); }
      }
      if (previous && (previous.fingerprint ?? saveFingerprint(previous.raw)) === fingerprint) {
        const old = previous.summary;
        const ownerKeys = [...new Set([...(old.ownerKeys ?? (old.ownerKey ? [old.ownerKey] : [])), ...summary.ownerKeys!])];
        const captureIds = [...new Set([...(old.captureIds ?? (/^game-[a-f0-9]{32}$/.test(old.id) ? [old.id] : [])), ...summary.captureIds!])];
        const oldCaptureTime = old.latestCapture && /^game-[a-f0-9]{32}$/.test(old.latestCapture.id) ? Date.parse(old.latestCapture.at) : NaN;
        const latestCapture = summary.latestCapture && (!Number.isFinite(oldCaptureTime) || Date.parse(summary.latestCapture.at) > oldCaptureTime)
          ? summary.latestCapture : old.latestCapture;
        // A new connection is useful evidence, but is not a new player snapshot or timestamp.
        if (unassignedCaptureFile || latestCapture !== old.latestCapture || ownerKeys.length !== (old.ownerKeys ?? (old.ownerKey ? [old.ownerKey] : [])).length || captureIds.length !== (old.captureIds ?? (/^game-[a-f0-9]{32}$/.test(old.id) ? [old.id] : [])).length) {
          const retained = { ...old, ownerKeys, captureIds, latestCapture };
          const temp = `${previousFile}.${randomUUID()}.tmp`;
          await fs.writeFile(temp, JSON.stringify({ summary: retained, raw: previous.raw, fingerprint }), { encoding: "utf8", flag: "wx" });
          await fs.rename(temp, previousFile);
          if (unassignedCaptureFile) await fs.unlink(unassignedCaptureFile);
          return { ...retained, unchanged: true };
        }
        return { ...old, unchanged: true };
      }
      summary.sequence = maxSequence + 1;
    }
    const target = path.join(dir, `${id}.json`), temp = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ summary, raw, fingerprint }), { encoding: "utf8", flag: "wx" });
    await fs.rename(temp, target);
    return summary;
  });
}
export async function deletePlayerArchives(root: string, ids: string[]): Promise<void> {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id))) throw new Error("请选择有效存档。");
  await archiveSerial(root, async () => {
    const dir = path.join(saveDirectory(root), "archives");
    for (const id of ids) {
      const stat = await fs.lstat(path.join(dir, `${id}.json`)).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error("存档记录已变化，请刷新后重试。");
    }
    const deleted = new Set(await deletedCaptures(root));
    for (const id of ids) {
      const stored = await readSave(path.join(dir, `${id}.json`)) as { summary?: SaveSummary };
      for (const captureId of [id, ...(stored.summary?.captureIds ?? [])]) if (/^game-[a-f0-9]{32}$/.test(captureId)) deleted.add(captureId);
    }
    const file = path.join(saveDirectory(root), "deleted-captures.json"), temp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify([...deleted]), { encoding: "utf8", flag: "wx" }); await fs.rename(temp, file);
    for (const id of ids) await fs.unlink(path.join(dir, `${id}.json`));
  });
}
export async function listSaves(root: string): Promise<SaveSummary[]> {
  const dir = path.join(saveDirectory(root), "archives");
  const names = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  const results: SaveSummary[] = [];
  for (const name of names.filter(name => /^[a-zA-Z0-9-]{1,80}\.json$/.test(name))) {
    const saved = await readSave(path.join(dir, name)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (record(saved) && record(saved.summary)) {
      const summary = saved.summary as SaveSummary;
      summary.serverLabel = safeServerLabel(summary.serverLabel) ?? serverLabelFromRaw(saved.raw);
      summary.ownerKey ??= saveOwnerKey(saved.raw);
      // Upgrade existing archives in memory only: keep IDs, timestamps, sessions and original files.
      if ((summary.inventory?.version !== 1 || summary.recentPlaysRecorded === undefined || summary.ratingVersion !== 1) && (record(saved.raw) || Array.isArray(saved.raw))) {
        const derived = summarizeSave(saved.raw, summary.source, summary.id);
        summary.inventory = derived.inventory;
        summary.recentPlays = derived.recentPlays; summary.recentPlaysRecorded = derived.recentPlaysRecorded;
        summary.scores = derived.scores; summary.newPlayerRating = derived.newPlayerRating; summary.ratingVersion = 1;
      }
      results.push(summary);
    }
  }
  if (results.some(save => save.inventory?.items.length)) {
    const names = await playerItemNames(root);
    for (const save of results) if (save.inventory) save.inventory.items = save.inventory.items.map(item => ({ ...item, name: names.get(itemKey(item.itemKind, item.itemId)) ?? item.name }));
  }
  return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || (b.sequence ?? 0) - (a.sequence ?? 0));
}

export const readApis = ["GetUserDataApi", "GetUserMusicApi", "GetUserCardApi", "GetUserCharacterApi", "GetUserItemApi", "GetUserOptionApi"] as const;
export const optionalReadApis = ["GetUserActivityApi"] as const;
export const editorReadApis = ["GetUserChapterApi", "GetUserStoryApi", "GetUserPreviewApi", "GetUserRecentRatingApi", "GetUserRatinglogApi"] as const;
export const allReadApis = [...readApis, ...optionalReadApis, ...editorReadApis];
export const captureStreamKey = (event: CaptureEvent) => `${event.api}:${event.request.kind ?? ""}:${event.request.nextIndex ?? "single"}`;
export function firstPage(event: CaptureEvent): number {
  return event.api === "GetUserItemApi" ? Math.floor(Number(event.request.nextIndex) / 10000000000) * 10000000000 : 0;
}
export function captureWarnings(events: CaptureEvent[]): string[] {
  const warnings: string[] = [];
  for (const api of readApis) {
    const pages = events.filter(event => event.api === api);
    if (!pages.length) { warnings.push(`${api.replace("GetUser", "").replace("Api", "")}：尚未读取。`); continue; }
    if (pages.some(page => "nextIndex" in page.response)) for (const start of new Set(pages.map(firstPage))) {
      let cursor = start; const seen = new Set<number>(); let complete = false;
      while (!seen.has(cursor)) {
        seen.add(cursor);
        const page = pages.find(page => page.request.nextIndex === cursor);
        if (!page) break;
        const next = number(page.response.nextIndex);
        if (next !== undefined && next <= 0) { complete = true; break; }
        if (next === undefined) break;
        cursor = next;
      }
      if (!complete) warnings.push(`${api.replace("GetUser", "").replace("Api", "")}${start ? `（类别 ${start / 10000000000}）` : ""}：分页未收齐。`);
    }
  }
  return warnings;
}
