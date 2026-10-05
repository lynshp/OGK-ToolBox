import fs from "node:fs/promises";
import path from "node:path";
import { bestMergeFormat, playerSaveEditMetadata, readSave, saveDirectory, summarizeSave, type SaveScore, type SaveSummary } from "./player-save";
import { compatibleGameDataPaths, directories, playerItemNames, readXml, textContent } from "./player-item-catalog";
import { localPlayerDifficulty, serverPlayerDifficulty } from "./player-difficulty";
import { validScope } from "./player-identity";
import { playerBestPlatinumRank, playerBestTechnicalRank } from "../src/player-best-merge";
import type { EditorResource, PlayerSaveEditMetadata, PlayerSaveEditorPatch, PlayerSaveEditorState } from "../src/player-save-editor-models";

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);
const chartKey = (value: { musicId: number; difficulty: number }) => `${value.musicId}:${value.difficulty}`;
const intMax = 2147483647;
const dataResources = [
  { field: "point", kind: 6, name: "金币", max: 999999999 },
  { field: "jewelCount", kind: 5, name: "通用珠", max: 99999 },
  { field: "medalCount", kind: 18, name: "勋章", max: 999999 },
  { field: "shizukuCount", kind: 21, name: "雫", max: 999999 }
] as const;
// Verified against the local 1.50 game's item implementations. Gift holdings and
// battle scores have no fixed gameplay cap; their protocol fields are signed Int32.
const itemResources = new Map<number, { category: string; max: number; binary?: boolean }>([
  [4, { category: "突破道具 · 作品/稀有度券", max: 9999 }], [9, { category: "礼物 · 待领取奖励", max: intMax }],
  [11, { category: "抽卡券", max: 99 }], [12, { category: "开花券", max: 9999 }],
  [13, { category: "强化道具", max: 9999 }], [14, { category: "亲密度道具", max: 9999 }],
  [20, { category: "解锁道具", max: 1, binary: true }]
]);
type Catalog = { items: Map<string, string>; chapters: Map<number, string>; stories: Map<number, string>; charts: PlayerSaveEditorState["scoreConstraints"] };
type Holdings = { data: Map<string, number>; items: Map<string, { stock?: number; isValid?: boolean; name?: string }>; chapters: Map<number, number>; stories: Map<number, number> };
const block = (xml: string, name: string) => xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1] ?? "";
const xmlInteger = (xml: string, name: string) => { const value = block(xml, name).trim(); return /^\d+$/.test(value) && integer(Number(value)) ? Number(value) : undefined; };
function payload(raw: unknown): unknown {
  if (record(raw) && record(raw.summary) && Array.isArray(raw.summary.scores) && (record(raw.raw) || Array.isArray(raw.raw))) return payload(raw.raw);
  return raw;
}
function readStock(value: unknown): number | undefined {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return integer(parsed) ? parsed : undefined;
}
function traverse(raw: unknown, visit: (value: Record<string, any>, key: string, kind?: number) => void) {
  let visited = 0;
  const walk = (value: unknown, depth: number, key = "", parentKind?: number) => {
    if (++visited > 500000 || depth > 24) throw new Error("存档结构过大或嵌套过深。");
    if (Array.isArray(value)) { value.forEach(row => walk(row, depth + 1, key, parentKind)); return; }
    if (!record(value)) return;
    visit(value, key, parentKind);
    for (const [childKey, child] of Object.entries(value)) {
      if (["request", "connection", "summary", "saveEdit", "bestMerge"].includes(childKey) || /rival|playlog/i.test(childKey)) continue;
      walk(child, depth + 1, childKey, readStock(value.itemKind));
    }
  };
  walk(payload(raw), 0);
}
function holdings(raw: unknown, save?: SaveSummary): Holdings {
  const result: Holdings = { data: new Map(), items: new Map(), chapters: new Map(), stories: new Map() };
  traverse(raw, (row, key, parentKind) => {
    if (key === "userData" || typeof row.userName === "string") for (const item of dataResources) {
      const stock = readStock(row[item.field]); if (stock !== undefined) result.data.set(item.field, stock);
    }
    if (/^(user)?(itemlist|items)$/i.test(key)) {
      const kind = readStock(row.itemKind) ?? parentKind, id = readStock(row.itemId);
      if (kind !== undefined && id !== undefined && id <= intMax && itemResources.has(kind)) result.items.set(`item:${kind}:${id}`, {
        stock: readStock(row.stock ?? row.quantity ?? row.count), isValid: row.isValid === false || row.isValid === 0 ? false : row.isValid === true || row.isValid === 1 ? true : undefined,
        name: typeof (row.itemName ?? row.name) === "string" ? (row.itemName ?? row.name).slice(0, 200) : undefined
      });
    }
    for (const [type, field, target] of [["chapter", "chapterId", result.chapters], ["story", "storyId", result.stories]] as const) {
      if (!new RegExp(`^(user)?${type}(list|s)?$`, "i").test(key)) continue;
      const id = readStock(row[field]), value = readStock(row.jewelCount);
      if (id !== undefined && id <= intMax && value !== undefined) target.set(id, value);
    }
  });
  if (save) for (const item of save.inventory.items) {
    if (itemResources.has(item.itemKind) && integer(item.itemId) && item.itemId <= intMax) result.items.set(`item:${item.itemKind}:${item.itemId}`, { stock: item.stock, name: item.name, isValid: item.isValid });
    const aggregate = dataResources.find(definition => definition.kind === item.itemKind && item.itemId === 0);
    if (aggregate && item.stock !== undefined) result.data.set(aggregate.field, item.stock);
  }
  return result;
}
async function chartHeader(directory: string, relative: string): Promise<{ exists: boolean; platinumMax: number | null }> {
  if (!relative || path.isAbsolute(relative)) return { exists: false, platinumMax: null };
  const file = path.resolve(directory, relative), rel = path.relative(directory, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { exists: false, platinumMax: null };
  const stat = await fs.lstat(file).catch(() => undefined);
  if (!stat?.isFile() || stat.isSymbolicLink()) return { exists: false, platinumMax: null };
  const handle = await fs.open(file, "r").catch(() => undefined);
  if (!handle) return { exists: false, platinumMax: null };
  try {
    const buffer = Buffer.alloc(16384), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead).toString("utf8").split(/\[HEADER\]/i)[1]?.split(/\[[A-Z_]+\]/)[0];
    const total = header?.match(/^T_TOTAL[\t ]+(\d+)[\t ]*\r?$/m)?.[1];
    const maximum = total === undefined ? undefined : Number(total) * 2;
    return { exists: true, platinumMax: integer(maximum) && maximum <= intMax ? maximum : null };
  } finally { await handle.close(); }
}
async function loadCatalog(root: string): Promise<Catalog> {
  const { paths } = await compatibleGameDataPaths(root), items = await playerItemNames(root);
  const chapters = new Map<number, string>(), stories = new Map<number, string>(), charts = new Map<string, PlayerSaveEditorState["scoreConstraints"][number]>();
  for (const directory of paths) {
    for (const [type, target] of [["chapter", chapters], ["story", stories]] as const) {
      const parent = path.join(directory, type), entries = (await directories(parent)).slice(0, 20000);
      for (let offset = 0; offset < entries.length; offset += 24) for (const xml of await Promise.all(entries.slice(offset, offset + 24).map(entry => readXml(path.join(parent, entry.name, `${type[0].toUpperCase()}${type.slice(1)}.xml`))))) {
        const name = block(xml, "Name"), id = xmlInteger(name, "id");
        if (id !== undefined && id <= intMax) target.set(id, textContent(block(name, "str")) || `${type === "chapter" ? "章节" : "剧情"} #${id}`);
      }
    }
    const parent = path.join(directory, "music"), entries = (await directories(parent)).slice(0, 20000);
    for (let offset = 0; offset < entries.length; offset += 24) {
      await Promise.all(entries.slice(offset, offset + 24).map(async entry => {
        const folder = path.join(parent, entry.name), xml = await readXml(path.join(folder, "Music.xml")), musicId = xmlInteger(block(xml, "Name"), "id");
        if (musicId === undefined || musicId > intMax) return;
        const data = [...xml.matchAll(/<FumenData\b[^>]*>([\s\S]*?)<\/FumenData>/gi)].slice(0, 5);
        for (let difficulty = 0; difficulty < data.length; difficulty++) {
          const info = await chartHeader(folder, textContent(block(block(data[difficulty][1], "FumenFile"), "path")));
          if (!info.exists) { charts.delete(`${musicId}:${difficulty}`); continue; }
          charts.set(`${musicId}:${difficulty}`, { musicId, difficulty, platinumMax: info.platinumMax, battleMax: intMax, editable: true });
        }
      }));
    }
  }
  return { items, chapters, stories, charts: [...charts.values()].sort((a, b) => a.musicId - b.musicId || a.difficulty - b.difficulty) };
}
async function sourceHoldings(root: string, save: SaveSummary, raw: unknown): Promise<Holdings> {
  let evidence = holdings(raw, save), value = payload(raw), depth = 0;
  const seen = new Set<string>([save.id]);
  // Canonical best snapshots intentionally omit original protocol responses. Their
  // target archive is the only valid source of unchanged money/chapter holdings.
  while (record(value) && value.format === bestMergeFormat && validId(value.bestMerge?.targetId) && depth++ < 24) {
    const id = value.bestMerge.targetId;
    if (seen.has(id)) break; seen.add(id);
    const file = path.join(saveDirectory(root), "archives", `${id}.json`), stat = await fs.lstat(file).catch(() => undefined);
    if (!stat?.isFile() || stat.isSymbolicLink()) break;
    const stored = await readSave(file);
    if (!record(stored) || !record(stored.summary) || stored.summary.id !== id) break;
    if (!validScope(value.scope) || !validScope(stored.summary.scope) || value.scope.cardId !== stored.summary.scope.cardId || value.scope.serverId !== stored.summary.scope.serverId) break;
    const previous = holdings(stored.raw, stored.summary as SaveSummary);
    evidence = { data: new Map([...previous.data, ...evidence.data]), items: new Map([...previous.items, ...evidence.items]), chapters: new Map([...previous.chapters, ...evidence.chapters]), stories: new Map([...previous.stories, ...evidence.stories]) };
    value = payload(stored.raw);
  }
  const edit = playerSaveEditMetadata(record(payload(raw)) ? (payload(raw) as Record<string, any>).saveEdit : undefined);
  if (edit) for (const row of edit.resources) {
    if (/^data:/.test(row.key)) evidence.data.set(row.key.slice(5), row.value);
    else if (/^item:/.test(row.key)) evidence.items.set(row.key, { ...evidence.items.get(row.key), stock: row.value, isValid: row.value > 0 });
    else if (/^chapter:/.test(row.key)) evidence.chapters.set(Number(row.key.slice(8)), row.value);
    else if (/^story:/.test(row.key)) evidence.stories.set(Number(row.key.slice(6)), row.value);
  }
  return evidence;
}
export async function getPlayerSaveEditor(root: string, save: SaveSummary, raw: unknown, playerId: string): Promise<PlayerSaveEditorState> {
  if (!validId(save.id) || !validId(playerId)) throw new Error("请选择有效的玩家存档。");
  const [catalog, owned] = await Promise.all([loadCatalog(root), sourceHoldings(root, save, raw)]), resources: EditorResource[] = [];
  for (const definition of dataResources) resources.push({ key: `data:${definition.field}`, category: definition.name, name: definition.name, value: owned.data.get(definition.field) ?? null, max: definition.max, editable: true });
  const itemKeys = new Set([...catalog.items.keys()].filter(key => itemResources.has(Number(key.split(":")[0]))).map(key => `item:${key}`));
  owned.items.forEach((_value, key) => itemKeys.add(key));
  for (const key of itemKeys) {
    const [, kindText, idText] = key.split(":"), kind = Number(kindText), id = Number(idText), definition = itemResources.get(kind), item = owned.items.get(key);
    if (!definition || !integer(id) || id > intMax) continue;
    const value = definition.binary && item?.isValid === false ? 0 : item?.stock ?? (definition.binary && item?.isValid ? 1 : null);
    resources.push({ key, category: definition.category, name: catalog.items.get(`${kind}:${id}`) || item?.name || `${definition.category} #${id}`, value, max: definition.max, binary: definition.binary, editable: true,
      limitKind: kind === 9 ? "field" : "game", ...(definition.binary ? { removable: (value ?? 0) === 0 } : {}) });
  }
  for (const [type, names, values] of [["chapter", catalog.chapters, owned.chapters], ["story", catalog.stories, owned.stories]] as const) for (const id of new Set([...names.keys(), ...values.keys()])) {
    resources.push({ key: `${type}:${id}`, category: "章节珠", name: names.get(id) || `${type === "chapter" ? "章节" : "剧情"} #${id}`, value: values.get(id) ?? null, max: 99999, editable: true });
  }
  const knownCharts = new Set(catalog.charts.map(chartKey));
  for (const score of save.scores) if (!knownCharts.has(chartKey(score))) catalog.charts.push({ musicId: score.musicId, difficulty: score.difficulty, platinumMax: null, battleMax: null, editable: false, reason: "缺少本地谱面" });
  return { saveId: save.id, playerId, techScoreMax: 1010000, resources, scoreConstraints: catalog.charts, scores: summarizeSave(raw, save.source, save.id).scores };
}
function assertPatch(patch: unknown): asserts patch is PlayerSaveEditorPatch {
  if (!record(patch) || Object.keys(patch).some(key => !["resources", "scores"].includes(key)) || !Array.isArray(patch.resources) || !Array.isArray(patch.scores)
    || patch.resources.length > 5000 || patch.scores.length > 5000 || patch.resources.length + patch.scores.length === 0) throw new Error("请选择要修改的资源或成绩。");
  const resourceKeys = new Set(), scoreKeys = new Set();
  for (const row of patch.resources) {
    if (!record(row) || Object.keys(row).some(key => !["key", "value"].includes(key)) || typeof row.key !== "string" || !integer(row.value) || resourceKeys.has(row.key)) throw new Error("资源修改字段无效。");
    resourceKeys.add(row.key);
  }
  const scoreFields = ["fields", "playCount", "maxComboCount", "maxOverKill", "maxTeamOverKill", "battleScoreRank", "clearStatus", "musicId", "difficulty", "techScore", "platinumScore", "battleScore", "fullCombo", "fullBell", "allBreak"];
  for (const row of patch.scores) {
    if (!record(row) || Object.keys(row).some(key => !scoreFields.includes(key)) || !integer(row.musicId) || row.musicId > intMax || !integer(row.difficulty) || row.difficulty > 4
      || !integer(row.techScore) || row.techScore > 1010000 || !integer(row.platinumScore) || row.platinumScore > intMax || !integer(row.battleScore) || row.battleScore > intMax
      || [row.fullCombo, row.fullBell, row.allBreak].some(value => typeof value !== "boolean") || scoreKeys.has(`${row.musicId}:${row.difficulty}`)) throw new Error("成绩修改字段无效。");
    for (const field of ["playCount", "maxComboCount", "maxOverKill", "maxTeamOverKill", "battleScoreRank", "clearStatus"]) if (row[field] !== undefined && (!integer(row[field]) || row[field] > (field === "battleScoreRank" ? 11 : field === "clearStatus" ? 1 : intMax) || field === "playCount" && row[field] < 1)) throw Error("成绩附加字段无效。");
    if (row.fields !== undefined && (!Array.isArray(row.fields) || !row.fields.length || new Set(row.fields).size !== row.fields.length || row.fields.some((field: unknown) => typeof field !== "string" || !scoreFields.includes(field) || row[field] === undefined || ["fields", "musicId", "difficulty"].includes(field)))) throw Error("成绩修改范围无效。");
    scoreKeys.add(`${row.musicId}:${row.difficulty}`);
  }
}
function normalizePatch(state: PlayerSaveEditorState, save: Pick<SaveSummary, "scores">, patch: PlayerSaveEditorPatch): { patch: PlayerSaveEditorPatch; scores: SaveScore[] } {
  assertPatch(patch);
  const resources = new Map(state.resources.map(row => [row.key, row])), constraints = new Map(state.scoreConstraints.map(row => [chartKey(row), row])), previous = new Map((state.scores ?? save.scores).map(row => [chartKey(row), row]));
  for (const row of patch.resources) {
    const definition = resources.get(row.key);
    if (!definition?.editable || row.value > definition.max || definition.binary && row.value !== 0 && row.value !== 1) throw new Error("资源不存在或数量超过游戏上限。");
    if (definition.binary && row.value === 0 && (definition.value ?? 0) > 0) throw new Error("解锁道具只能增加持有，不能取消已有解锁。");
  }
  const scores = patch.scores.map(row => {
    const old = previous.get(chartKey(row)), constraint = constraints.get(chartKey(row));
    if (!constraint?.editable) throw new Error("本地没有这张谱面，无法修改成绩。");
    if (constraint.platinumMax === null ? row.platinumScore !== (old?.platinumScore ?? 0) : row.platinumScore > constraint.platinumMax) throw new Error("白金分数超过谱面上限或缺少谱面上限。");
    if (constraint.battleMax === null ? row.battleScore !== (old?.battleScore ?? 0) : row.battleScore > constraint.battleMax) throw new Error("战斗分数字段无效。");
    return { ...old, ...row, fullCombo: row.fullCombo || row.allBreak || row.techScore === 1010000, allBreak: row.allBreak || row.techScore === 1010000,
      fullBell: row.fullBell || row.techScore === 1010000, playCount: row.playCount ?? (integer(old?.playCount) && old!.playCount! > 0 ? old!.playCount : 1),
      techScoreRank: playerBestTechnicalRank(row.techScore), platinumScoreStar: constraint.platinumMax === null ? old?.platinumScoreStar : playerBestPlatinumRank(row.platinumScore, constraint.platinumMax) };
  });
  return { patch: { resources: patch.resources.map(row => ({ key: row.key, value: row.value })), scores: patch.scores.map(row => ({ ...row,
    fullCombo: row.fullCombo || row.allBreak || row.techScore === 1010000, allBreak: row.allBreak || row.techScore === 1010000, fullBell: row.fullBell || row.techScore === 1010000 })) }, scores };
}
export function validatePlayerSaveEditorPatch(patch: unknown, state: PlayerSaveEditorState, currentScores: SaveScore[]): PlayerSaveEditorPatch {
  assertPatch(patch); return normalizePatch(state, { scores: currentScores }, patch).patch;
}
function updateProtocolScore(row: Record<string, any>, score: SaveScore) {
  const aliases: [string[], unknown][] = [
    [["techScoreMax", "techScore", "technicalScore"], score.techScore], [["platinumScoreMax", "platinumScore"], score.platinumScore ?? 0],
    [["battleScoreMax", "battleScore"], score.battleScore ?? 0], [["isAllBreake", "isAllBreak"], score.allBreak],
    [["isFullCombo"], score.fullCombo], [["isFullBell"], score.fullBell], [["techScoreRank"], score.techScoreRank], [["platinumScoreStar"], score.platinumScoreStar]
  ];
  for (const [fields, value] of aliases) {
    const existing = fields.filter(field => field in row);
    for (const field of existing.length ? existing : [fields[0]]) if (value !== undefined) {
      // The game packs its full-score count in the low four digits of an
      // over-one-million techScoreMax. Editing another metric at displayed full
      // score must preserve that count; an explicit reduction replaces it.
      if (field === "techScoreMax" && score.techScore === 1010000 && integer(row[field]) && row[field] > 1010000 && row[field] <= 1019999) continue;
      row[field] = value;
    }
  }
  for (const field of ["playCount", "maxComboCount", "maxOverKill", "maxTeamOverKill", "battleScoreRank", "clearStatus"] as const) if (score[field] !== undefined) row[field] = score[field];
  if (!integer(row.playCount) || row.playCount === 0) row.playCount = score.playCount ?? 1;
}
function protocolScore(score: SaveScore) {
  const row = { musicId: score.musicId, level: serverPlayerDifficulty(score.difficulty), playCount: score.playCount ?? 1 };
  updateProtocolScore(row, score); return row;
}
function setStock(row: Record<string, any>, value: number, kind: number) {
  const fields = ["stock", "quantity", "count"].filter(field => field in row);
  for (const field of fields.length ? fields : ["stock"]) row[field] = value;
  // Gifts retain their validity flag. Unlock rows are only added, never revoked.
  if (kind !== 9) row.isValid = value > 0;
}
export function applyPlayerSaveEditorPatch(raw: unknown, resources: PlayerSaveEditorPatch["resources"], scores: SaveScore[]): unknown {
  let clone = JSON.parse(JSON.stringify(raw)), value = payload(clone);
  if (Array.isArray(value)) {
    const wrapped = { userMusicDetailList: value };
    if (record(clone)) {
      let holder = clone;
      while (record(holder.raw) && record(holder.raw.summary) && Array.isArray(holder.raw.summary.scores)) holder = holder.raw;
      holder.raw = wrapped;
    } else clone = wrapped;
    value = wrapped;
  }
  if (!record(value)) throw new Error("存档格式不支持修改。");
  const edits = new Map(resources.map(row => [row.key, row.value])), changes = new Map(scores.map(row => [chartKey(row), row]));
  if (value.format === bestMergeFormat) {
    const player = value.player;
    if (!record(player) || !Array.isArray(player.scores) || !record(player.inventory) || !Array.isArray(player.inventory.items)) throw new Error("合并存档字段无效。");
    player.scores = player.scores.map((row: any) => changes.get(chartKey(row)) ?? row);
    const keys = new Set(player.scores.map(chartKey)); scores.forEach(row => { if (!keys.has(chartKey(row))) player.scores.push({ ...row }); });
    for (const [key, stock] of edits) {
      const match = key.match(/^item:(\d+):(\d+)$/), aggregate = dataResources.find(row => key === `data:${row.field}`);
      const kind = match ? Number(match[1]) : aggregate?.kind, id = match ? Number(match[2]) : aggregate ? 0 : undefined;
      if (kind === undefined || id === undefined) continue;
      const old = player.inventory.items.find((row: any) => row.itemKind === kind && row.itemId === id);
      if (old) { old.stock = stock; if (kind !== 9) old.isValid = stock > 0; }
      else player.inventory.items.push({ itemKind: kind, itemId: id, stock, isValid: true, ...(aggregate ? { name: aggregate.name } : {}) });
    }
    return clone;
  }
  const seenResources = new Set<string>(), seenScores = new Set<string>();
  traverse(clone, (row, key, parentKind) => {
    if (key === "userData" || typeof row.userName === "string") for (const definition of dataResources) {
      const resourceKey = `data:${definition.field}`;
      if (edits.has(resourceKey)) { row[definition.field] = edits.get(resourceKey); seenResources.add(resourceKey); }
    }
    if (/^(user)?(itemlist|items)$/i.test(key)) {
      const kind = readStock(row.itemKind) ?? parentKind, id = readStock(row.itemId), resourceKey = `item:${kind}:${id}`;
      if (kind !== undefined && id !== undefined && edits.has(resourceKey)) { setStock(row, edits.get(resourceKey)!, kind); seenResources.add(resourceKey); }
    }
    for (const [type, field] of [["chapter", "chapterId"], ["story", "storyId"]] as const) if (new RegExp(`^(user)?${type}(list|s)?$`, "i").test(key)) {
      const id = readStock(row[field]), resourceKey = `${type}:${id}`;
      if (id !== undefined && edits.has(resourceKey)) { row.jewelCount = edits.get(resourceKey); seenResources.add(resourceKey); }
    }
    const difficulty = localPlayerDifficulty(row.level ?? row.difficulty), score = changes.get(`${row.musicId}:${difficulty}`);
    if (score && integer(row.musicId) && integer(difficulty) && ("techScoreMax" in row || "techScore" in row || "technicalScore" in row)) { updateProtocolScore(row, score); seenScores.add(chartKey(score)); }
  });
  const append = (field: string, row: Record<string, any>) => { if (!Array.isArray(value[field])) value[field] = []; value[field].push(row); };
  for (const [key, stock] of edits) if (!seenResources.has(key)) {
    if (key.startsWith("data:")) {
      // This is a local desired balance, not a fabricated server identity. Upload
      // overlays it on a separately read, complete target UserData response.
      if (!record(value.userData)) value.userData = {};
      value.userData[key.slice(5)] = stock;
    } else {
      const match = key.match(/^(item|chapter|story):(\d+)(?::(\d+))?$/);
      if (!match) throw new Error("资源修改字段无效。");
      if (match[1] === "item") append("userItemList", { itemKind: Number(match[2]), itemId: Number(match[3]), stock, isValid: stock > 0 });
      else append(match[1] === "chapter" ? "userChapterList" : "userStoryList", { [match[1] === "chapter" ? "chapterId" : "storyId"]: Number(match[2]), jewelCount: stock });
    }
  }
  for (const score of scores) if (!seenScores.has(chartKey(score))) append("userMusicDetailList", protocolScore(score));
  return clone;
}
export async function preparePlayerSaveEdit(root: string, save: SaveSummary, raw: unknown, patch: PlayerSaveEditorPatch, playerId: string): Promise<{ raw: unknown; edit: PlayerSaveEditMetadata; unchanged: boolean }> {
  const state = await getPlayerSaveEditor(root, save, raw, playerId), normalized = normalizePatch(state, save, patch);
  const previous = playerSaveEditMetadata(record(payload(raw)) ? (payload(raw) as Record<string, any>).saveEdit : undefined);
  const inherited = previous?.playerId === playerId ? previous : undefined;
  if (inherited && inherited.resources.length + inherited.scores.length) {
    const prior = normalizePatch(state, save, { resources: inherited.resources, scores: inherited.scores });
    for (const expected of prior.scores) {
      const actual = save.scores.find(row => chartKey(row) === chartKey(expected));
      if (!actual || ["techScore", "platinumScore", "battleScore", "techScoreRank", "platinumScoreStar", "fullCombo", "fullBell", "allBreak"].some(field => (actual as any)[field] !== (expected as any)[field])) throw new Error("原修改记录与成绩不一致，请重新选择存档。");
    }
  }
  const resources = new Map((inherited?.resources ?? []).map(row => [row.key, { ...row }])), scores = new Map((inherited?.scores ?? []).map(row => [chartKey(row), { ...row }]));
  normalized.patch.resources.forEach(row => resources.set(row.key, { ...row })); normalized.patch.scores.forEach(row => scores.set(chartKey(row), { ...row }));
  const edit: PlayerSaveEditMetadata = { version: 1, parentId: save.id, playerId, createdAt: new Date().toISOString(), resources: [...resources.values()], scores: [...scores.values()] };
  if (edit.resources.length > 5000 || edit.scores.length > 5000) throw new Error("累计修改过多，请分次上传。");
  const output = applyPlayerSaveEditorPatch(raw, normalized.patch.resources, normalized.scores), editable = payload(output);
  if (!record(editable)) throw new Error("存档格式不支持修改。");
  editable.saveEdit = edit;
  const result = summarizeSave(output, "json"), currentResources = new Map(state.resources.map(row => [row.key, row.value]));
  // Exact replacement also supports reductions. Never leave a repeated page's
  // old higher best behind, where the ordinary summarizer would mask this edit.
  for (const score of normalized.scores) {
    const actual = result.scores.find(row => chartKey(row) === chartKey(score));
    if (!actual || ["techScore", "battleScore", "platinumScore", "techScoreRank", "platinumScoreStar", "fullCombo", "fullBell", "allBreak", ...["playCount", "maxComboCount", "maxOverKill", "maxTeamOverKill", "battleScoreRank", "clearStatus"].filter(field => (score as any)[field] !== undefined)].some(field => (actual as any)[field] !== (score as any)[field])) throw new Error("存档成绩结构不支持完整修改，原文件未改动。");
  }
  const unchanged = normalized.patch.resources.every(row => currentResources.get(row.key) === row.value) && normalized.scores.every(score => {
    const old = save.scores.find(row => chartKey(row) === chartKey(score));
    return !!old && ["techScore", "battleScore", "platinumScore", "techScoreRank", "platinumScoreStar", "fullCombo", "fullBell", "allBreak", ...["playCount", "maxComboCount", "maxOverKill", "maxTeamOverKill", "battleScoreRank", "clearStatus"].filter(field => (score as any)[field] !== undefined)].every(field => ((old as any)[field] ?? (typeof (score as any)[field] === "boolean" ? false : 0)) === (score as any)[field]);
  });
  return { raw: output, edit, unchanged };
}
