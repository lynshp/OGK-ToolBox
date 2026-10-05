import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { validateCapturedPlayerIdentity, type CapturedPlayerIdentity } from "./machine-profiles";
import { captureWarnings, readSave, saveDirectory, type CaptureEvent } from "./player-save";

type Row = Record<string, any>;
type Settlement = { id: string; sessionId?: string; at: string; identity: CapturedPlayerIdentity; baseUrl: string; body: Row };
const record = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const idPattern = /^[a-f0-9]{32}$/;
function endpoint(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid endpoint");
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid endpoint");
  return url.href.replace(/\/$/, "");
}

/** Read only the Mod's successful, identity-bound wire observations. Never replay them. */
export async function capturedSettlements(root: string): Promise<Settlement[]> {
  const dir = path.join(saveDirectory(root), "upsert-observations");
  const names = (await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; }))
    .filter(name => /^[a-f0-9]{32}\.json$/.test(name)).sort();
  if (names.length > 4096) throw new Error("结算采集数量超过限制。");
  const result: Settlement[] = [];
  let size = 0;
  for (const name of names) {
    const file = path.join(dir, name), stat = await fs.lstat(file);
    size += stat.size;
    if (size > 64 * 1024 * 1024) throw new Error("结算采集超过 64 MB。");
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 18 * 1024 * 1024) continue;
    try {
      const value = await readSave(file);
      if (!record(value) || value.version !== 1 || value.api !== "UpsertUserAllApi" || value.returnCode !== 1
          || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) || !idPattern.test(value.loginGeneration)
          || value.sessionId !== undefined && !idPattern.test(value.sessionId)
          || typeof value.serializedRequest !== "string" || typeof value.serializedResponse !== "string") continue;
      const accepted = value.source === "game-transport-success-response" && value.observationPath === "net-http-request-completed"
        && value.acceptance === "transport-success-return-code" && typeof value.compressionRequested === "boolean"
        || value.source === "game-serialized-accepted-save" && ["query-hooks", "net-http-request-query-response"].includes(value.observationPath)
        && value.acceptance === "game-query-set-response";
      if (!accepted) continue;
      const identity = validateCapturedPlayerIdentity(value.identity);
      const machine = validateCapturedPlayerIdentity({ ...value.identity, machine: value.machine }).machine;
      const request = JSON.parse(value.serializedRequest), response = JSON.parse(value.serializedResponse);
      if (!record(request) || !record(response) || response.returnCode !== 1 || response.userId !== undefined && response.userId !== identity.userId
          || request.userId !== identity.userId || request.accessCode !== identity.accessCode || request.clientId?.toUpperCase() !== identity.clientId
          || !record(request.upsertUserAll) || !isDeepStrictEqual(machine, identity.machine)) continue;
      result.push({ id: name.slice(0, -5), sessionId: value.sessionId, at: value.at, identity, baseUrl: endpoint(value.connection?.baseUrl), body: request.upsertUserAll });
    } catch { /* Incomplete or invalid observations never advance an archive. */ }
  }
  return result.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}

export type SettlementCapture = { session: string; identity?: CapturedPlayerIdentity; events: CaptureEvent[] };
export function settlementsForCapture(capture: SettlementCapture, captures: SettlementCapture[], observations: Settlement[]): Settlement[] {
  if (!capture.identity || captureWarnings(capture.events).length) return [];
  const compatible = (candidate: SettlementCapture, observation: Settlement) => !!candidate.identity
    && isDeepStrictEqual(candidate.identity, observation.identity) && candidate.events.length > 0
    && candidate.events.every(event => event.request.userId === observation.identity.userId && event.response.userId === observation.identity.userId
      && Number.isFinite(Date.parse(event.at))
      && event.connection && endpoint(event.connection.baseUrl) === observation.baseUrl);
  return observations.filter(observation => {
    try {
      if (!compatible(capture, observation)) return false;
      if (capture.events.some(event => Date.parse(event.at) > Date.parse(observation.at))) return false;
      if (observation.sessionId) return observation.sessionId === capture.session;
      // 1.0.11 observations did not carry a session ID. Attribute only to the
      // unique latest preceding login with the same card, client and endpoint.
      const start = (candidate: SettlementCapture) => Math.min(...candidate.events.map(event => Date.parse(event.at)));
      const candidates = captures.filter(candidate => compatible(candidate, observation) && start(candidate) <= Date.parse(observation.at));
      candidates.sort((a, b) => start(b) - start(a));
      return candidates[0]?.session === capture.session && (candidates.length === 1 || start(candidates[0]) > start(candidates[1]));
    } catch { return false; }
  });
}

const listRules = [
  ["GetUserCardApi", "userCardList", ["cardId"]],
  ["GetUserCharacterApi", "userCharacterList", ["characterId"]],
  ["GetUserItemApi", "userItemList", ["itemKind", "itemId"]],
  ["GetUserChapterApi", "userChapterList", ["chapterId"]],
  ["GetUserStoryApi", "userStoryList", ["storyId"]],
  ["GetUserRatinglogApi", "userRatinglogList", ["dataVersion"]],
] as const;

/** Upsert lists are deltas, not full inventories. Overlay by their protocol keys. */
export function applyCapturedSettlements(capture: SettlementCapture, observations: Settlement[]) {
  let events = structuredClone(capture.events);
  let last: Settlement | undefined;
  for (const observation of observations) {
    const next = structuredClone(events), body = observation.body, userId = observation.identity.userId;
    const fail = () => { throw new Error("结算采集字段无效，原存档保留。"); };
    for (const [api, field] of [["GetUserDataApi", "userData"], ["GetUserOptionApi", "userOption"]]) {
      const rows = body[field];
      if (!Array.isArray(rows) || rows.length !== 1 || !record(rows[0])) fail();
      const event = next.find(event => event.api === api);
      if (!event) fail();
      event!.response[field] = { ...(event!.response[field] as Row), ...rows[0] };
    }
    for (const [api, field, keys] of listRules) {
      const changes = body[field];
      if (changes === undefined) continue;
      if (!Array.isArray(changes) || changes.some(row => !record(row) || keys.some(key => key === "dataVersion" ? typeof row[key] !== "string" || !/^\d+(?:\.\d+){1,3}$/.test(row[key]) : !Number.isSafeInteger(row[key]) || row[key] < 0))) fail();
      const flags = body[`isNew${field.slice(4)}`];
      if (typeof flags !== "string" || flags.length !== changes.length || /[^01]/.test(flags)) fail();
      const key = (row: Row, event?: CaptureEvent) => keys.map(key => key === "itemKind" ? row[key] ?? event?.response.itemKind ?? Math.floor(Number(event?.request.nextIndex) / 10000000000) : row[key]).join(":");
      if (new Set(changes.map((row: Row) => key(row))).size !== changes.length) fail();
      for (const row of changes) {
        const pages = next.filter(event => event.api === api);
        let found = false;
        for (const page of pages) {
          const rows = page.response[field];
          if (!Array.isArray(rows)) fail();
          const index = (rows as Row[]).findIndex(old => key(old, page) === key(row));
          if (index >= 0) { (rows as Row[])[index] = { ...(rows as Row[])[index], ...row }; found = true; break; }
        }
        if (!found) {
          let page = pages.find(event => api !== "GetUserItemApi" || (event.response.itemKind ?? Math.floor(Number(event.request.nextIndex) / 10000000000)) === row.itemKind);
          if (!page) {
            const request = { userId, ...(api === "GetUserItemApi" ? { nextIndex: row.itemKind * 10000000000 } : {}) };
            page = { api, at: observation.at, request, response: { userId, length: 0, nextIndex: 0, [field]: [] }, connection: next[0].connection };
            next.push(page);
          }
          (page.response[field] as Row[]).push({ ...row });
          page.response.length = (page.response[field] as Row[]).length;
        }
      }
    }
    const music = body.userMusicDetailList;
    if (!Array.isArray(music) || typeof body.isNewMusicDetailList !== "string" || !/^[01]*$/.test(body.isNewMusicDetailList) || body.isNewMusicDetailList.length !== music.length) fail();
    const seen = new Set<string>();
    for (const row of music) {
      if (!record(row) || !Number.isSafeInteger(row.musicId) || row.musicId < 0 || ![0, 1, 2, 3, 10].includes(row.level)) fail();
      const key = `${row.musicId}:${row.level}`; if (seen.has(key)) fail(); seen.add(key);
      const pages = next.filter(event => event.api === "GetUserMusicApi");
      let group: Row | undefined;
      for (const page of pages) {
        if (!Array.isArray(page.response.userMusicList)) fail();
        group = (page.response.userMusicList as Row[]).find(group => group.musicId === row.musicId || group.userMusicDetailList?.some((old: Row) => old.musicId === row.musicId));
        if (group) break;
      }
      if (!group) {
        if (!pages.length) fail();
        group = { musicId: row.musicId, length: 0, userMusicDetailList: [] };
        (pages[0].response.userMusicList as Row[]).push(group);
        pages[0].response.length = (pages[0].response.userMusicList as Row[]).length;
      }
      const rows = group.userMusicDetailList;
      if (!Array.isArray(rows)) fail();
      const index = rows.findIndex((old: Row) => old.level === row.level);
      if (index < 0) rows.push({ ...row }); else rows[index] = { ...rows[index], ...row };
      group.length = rows.length;
    }
    if (body.userRecentRatingList !== undefined) {
      if (!Array.isArray(body.userRecentRatingList) || body.userRecentRatingList.some((row: unknown) => !record(row))) fail();
      let page = next.find(event => event.api === "GetUserRecentRatingApi");
      if (!page) { page = { api: "GetUserRecentRatingApi", request: { userId }, response: {}, at: observation.at, connection: next[0].connection }; next.push(page); }
      page.response = { userId, length: body.userRecentRatingList.length, userRecentRatingList: body.userRecentRatingList };
    }
    if (body.userActivityList !== undefined) {
      if (!Array.isArray(body.userActivityList) || body.userActivityList.length > 25 || body.userActivityList.some((row: unknown) => !record(row)
          || ![0, 1, 2].includes(row.kind) || ["id", "sortNumber", "param1", "param2", "param3", "param4"].some(field => !Number.isSafeInteger(row[field])))) fail();
      for (const kind of [1, 2]) {
        const rows = body.userActivityList.filter((row: unknown) => record(row) && row.kind === kind);
        let page = next.find(event => event.api === "GetUserActivityApi" && event.request.kind === kind);
        if (!page) { page = { api: "GetUserActivityApi", request: { userId, kind }, response: {}, at: observation.at, connection: next[0].connection }; next.push(page); }
        page.response = { userId, kind, length: rows.length, userActivityList: rows };
      }
    }
    // All retained pages now describe one materialized post-save snapshot.
    events = next.map(event => ({ ...event, at: observation.at })); last = observation;
  }
  if (!last) return undefined;
  const revision = createHash("sha256").update(`${capture.session}:${last.id}`).digest("hex").slice(0, 32);
  return { id: `game-${revision}`, raw: { format: "ogk-player-save-v1", sessionId: capture.session, settlementSessionId: capture.session,
    settlementIds: observations.map(value => value.id), events, captureWarnings: captureWarnings(events) } };
}
