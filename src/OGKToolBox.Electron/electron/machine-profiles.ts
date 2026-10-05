import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cardIdentity, serverIdentity } from "./player-identity";
import { playerConnectionDefaults, type PlayerConnectionInput } from "./player-bootstrap";
import { saveDirectory } from "./player-save";
import type { MachineValues, MachineProfile, PlayerProfile, MachineProfilesState, SaveMachineProfileRequest, SavePlayerProfileRequest } from "../src/machine-profile-models";

type Card = { id: string; accessCode: string };
type Machine = { id: string; name: string; values: MachineValues; importSourceKey?: string };
type Store = { version: 1; machines: Machine[]; activeMachineId: string; players: PlayerProfile[]; selectedPlayerId: string };
export type CapturedPlayerIdentity = { version: 1; userId: number; accessCode: string; clientId: string; machine: MachineValues };
export class CapturedPlayerServerMismatchError extends Error {
  constructor() {
    super("采集服务器与当前机台不同，未自动归属。");
    this.name = "Error";
    this.stack = undefined;
  }
}
const groups = ["dns", "netenv", "keychip"] as const;
const keys = { dns: ["default", "AimeDB", "replaceHost"], netenv: ["enable"], keychip: ["id", "subnet"] } as const;
const locks = new Map<string, Promise<unknown>>();
const idValid = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);
const sourceKeyValid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function importList(value: unknown, validate: (value: unknown) => boolean): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 500 || value.some(item => !validate(item)) || new Set(value).size !== value.length) throw new Error("导入来源记录无效。");
  return [...value];
}
async function serial<T>(root: string, action: () => Promise<T>): Promise<T> {
  const id = path.resolve(root).toLowerCase(), previous = locks.get(id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action); locks.set(id, next);
  try { return await next; } finally { if (locks.get(id) === next) locks.delete(id); }
}
function defaults(): MachineValues { return { dns: { default: "", AimeDB: "", replaceHost: "0" }, netenv: { enable: "1" }, keychip: { id: "", subnet: "192.168.162.0" } }; }
function safeName(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 40 || /[\r\n\0]/.test(value)) throw new Error(`${label}名称应为 1–40 个字符。`);
  return value.trim();
}
function normalizedValues(value: unknown, validateConnection = true): MachineValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("机台配置无效。");
  const result = defaults();
  for (const group of groups) {
    const record = (value as MachineValues)[group];
    if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).some(key => !keys[group].some(allowed => allowed === key))) throw new Error("机台配置包含未知字段。");
    for (const key of keys[group]) {
      const item = record[key] ?? result[group][key];
      if (typeof item !== "string" || item.length > 1024 || /[\r\n\0]/.test(item)) throw new Error("机台配置字段无效。");
      result[group][key] = item.trim();
    }
  }
  // Imported/external settings must stay editable even when their connection fields are invalid.
  if (!validateConnection) return result;
  if (!["0", "1"].includes(result.dns.replaceHost) || !["0", "1"].includes(result.netenv.enable)) throw new Error("网络开关应为 0 或 1。");
  // Empty fields are valid drafts. Connection validation remains a fetch/upload requirement.
  for (const item of [result.dns.default, result.dns.AimeDB]) if (item) {
    try { serverIdentity(item); } catch { throw new Error("服务器应为主机名或 HTTP(S) 根地址。"); }
  }
  if (result.keychip.id && !/^(?:[A-Z0-9]{4}-[A-Z0-9]{11}|[A-Z0-9]{15}|[A-Z0-9]{11})$/i.test(result.keychip.id)) throw new Error("Keychip 格式无效。");
  if (result.keychip.subnet && !/^192\.168\.(?:\d{1,3})\.(?:\d{1,3})$/.test(result.keychip.subnet)) throw new Error("机台子网应为 192.168 开头的 IPv4 地址。");
  if (result.keychip.subnet && result.keychip.subnet.split(".").some(part => Number(part) > 255)) throw new Error("机台子网地址无效。");
  return result;
}
export function validateCapturedPlayerIdentity(value: unknown): CapturedPlayerIdentity {
  const fail = () => { throw new Error("采集身份或机台快照无效，未自动归属。"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const identity = value as Record<string, unknown>;
  if (Object.keys(identity).some(key => !["version", "userId", "accessCode", "clientId", "machine"].includes(key))
      || identity.version !== 1 || !Number.isSafeInteger(identity.userId) || Number(identity.userId) <= 0
      || typeof identity.accessCode !== "string" || !/^\d{20}$/.test(identity.accessCode)
      || typeof identity.clientId !== "string" || !/^[A-Z0-9]{11}$/i.test(identity.clientId)
      || !identity.machine || typeof identity.machine !== "object" || Array.isArray(identity.machine)) return fail();
  const snapshot = identity.machine as Record<string, unknown>;
  if (Object.keys(snapshot).length !== groups.length || Object.keys(snapshot).some(key => !groups.some(group => group === key))) return fail();
  for (const group of groups) {
    const fields = snapshot[group];
    if (!fields || typeof fields !== "object" || Array.isArray(fields)
        || Object.keys(fields).length !== keys[group].length
        || Object.keys(fields).some(key => !keys[group].some(allowed => allowed === key))
        || keys[group].some(key => typeof (fields as Record<string, unknown>)[key] !== "string")) return fail();
  }
  let machine: MachineValues;
  try {
    machine = normalizedValues(snapshot);
    serverIdentity(machine.dns.default, machine.dns.AimeDB);
  } catch { return fail(); }
  // An unset keychip can use a game/Segatools default; keep the observed short ID.
  const keychip = machine.keychip.id;
  if (keychip && keychip.replace("-", "").toUpperCase().slice(0, 11) !== identity.clientId.toUpperCase()) return fail();
  return { version: 1, userId: Number(identity.userId), accessCode: identity.accessCode, clientId: identity.clientId.toUpperCase(), machine };
}
function automaticName(rows: { name: string }[], label: string) {
  const occupied = new Set(rows.map(row => Number(new RegExp(`^${label}\\s*(\\d+)$`).exec(row.name.trim())?.[1])));
  let number = 1;
  while (occupied.has(number)) number++;
  return `${label} ${number}`;
}
type IniDocument = { text: string; encode: (text: string) => Buffer };
function iniDocument(bytes: Buffer): IniDocument {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: bytes.subarray(2).toString("utf16le"), encode: text => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]) };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    if ((bytes.length - 2) % 2) throw new Error("Segatools 配置编码无效。");
    return { text: Buffer.from(bytes.subarray(2)).swap16().toString("utf16le"), encode: text => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]) };
  }
  // Byte-preserving round trip for UTF-8 and legacy INIs; edits are converted to bytes separately.
  return { text: bytes.toString("latin1"), encode: text => Buffer.from(text, "latin1") };
}
async function readIni(root: string) {
  const file = path.join(root, "segatools.ini"), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Segatools 配置不是有效文件（最大 1 MB）。");
  const bytes = await fs.readFile(file), document = iniDocument(bytes);
  let content = document.text;
  if (!((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    // Parse paths as Unicode while the painter keeps all untouched original bytes.
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { content = new TextDecoder("gbk").decode(bytes); }
  }
  const map = new Map<string, string>(); let section = "";
  for (const line of content.replace(/^\uFEFF|^\xEF\xBB\xBF/, "").split(/\r?\n/)) {
    const trimmed = line.trim(); if (!trimmed || /^[;#]/.test(trimmed)) continue;
    const heading = trimmed.match(/^\[([^\]]+)\]/);
    if (heading) { section = heading[1].trim().toLowerCase(); continue; }
    const item = trimmed.match(/^([^=]+)=(.*)$/);
    if (item) map.set(`${section}.${item[1].trim().toLowerCase()}`, item[2].trim().replace(/\s+[;#].*$/, "").replace(/^"(.*)"$/, "$1"));
  }
  const values = defaults();
  for (const group of groups) for (const key of keys[group]) if (map.has(`${group}.${key.toLowerCase()}`)) values[group][key] = map.get(`${group}.${key.toLowerCase()}`)!;
  return { file, bytes, document, map, values };
}
function displayMachine(machine: Machine): MachineProfile {
  let server: MachineProfile["server"];
  try { server = serverIdentity(machine.values.dns.default, machine.values.dns.AimeDB); } catch { /* Unconfigured drafts stay visible. */ }
  const keychip = machine.values.keychip.id;
  return { ...machine, server, keychipHint: keychip ? `${keychip.slice(0, 4)} ···· ${keychip.slice(-4)}` : "未配置" };
}
const storePath = (root: string) => path.join(saveDirectory(root), "stations.json");
async function persist(root: string, data: Store) {
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error("机台与玩家列表不能超过 1 MB。");
  const file = storePath(root); await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, serialized, { encoding: "utf8", flag: "wx" }); await fs.rename(temp, file); }
  finally { await fs.unlink(temp).catch(() => {}); }
}
async function readStore(root: string, cards: Card[]): Promise<{ data: Store; configurationError: string }> {
  let values = defaults(), configurationError = "";
  try { values = normalizedValues((await readIni(root)).values, false); } catch (error) { configurationError = error instanceof Error ? error.message : "无法读取 Segatools 配置。"; }
  let data: Store;
  try {
    const file = storePath(root), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error();
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    if (raw?.version !== 1 || !Array.isArray(raw.machines) || !raw.machines.length || raw.machines.length > 100 || !Array.isArray(raw.players) || raw.players.length > 500) throw new Error();
    const machines: Machine[] = raw.machines.map((machine: Machine) => {
      if (!idValid(machine?.id) || machine.importSourceKey !== undefined && !sourceKeyValid(machine.importSourceKey)) throw new Error();
      return { id: machine.id, name: safeName(machine.name, "机台"), values: normalizedValues(machine.values, false), ...(machine.importSourceKey ? { importSourceKey: machine.importSourceKey } : {}) };
    });
    const players: PlayerProfile[] = raw.players.map((player: PlayerProfile) => {
      const importedSaveIds = importList(player?.importedSaveIds, idValid), importSourceKeys = importList(player?.importSourceKeys, sourceKeyValid);
      if (!idValid(player?.id) || !machines.some(machine => machine.id === player.machineId)
          || !(cards.some(card => card.id === player.cardId) || player.cardId === "" && !!importedSaveIds?.length)) throw new Error();
      return { id: player.id, name: safeName(player.name, "玩家"), machineId: player.machineId, cardId: player.cardId,
        ...(importedSaveIds ? { importedSaveIds } : {}), ...(importSourceKeys ? { importSourceKeys } : {}) };
    });
    const machineSourceKeys = machines.flatMap(machine => machine.importSourceKey ? [machine.importSourceKey] : []), importedSaveIds = players.flatMap(player => player.importedSaveIds ?? []);
    if (new Set(machines.map(machine => machine.id)).size !== machines.length || new Set(players.map(player => player.id)).size !== players.length
        || new Set(machineSourceKeys).size !== machineSourceKeys.length || new Set(importedSaveIds).size !== importedSaveIds.length
        || !machines.some(machine => machine.id === raw.activeMachineId) || raw.selectedPlayerId && !players.some(player => player.id === raw.selectedPlayerId)) throw new Error();
    data = { version: 1, machines, players, activeMachineId: raw.activeMachineId, selectedPlayerId: raw.selectedPlayerId || "" };
    // External INI edits and existing backup restores update only the active station.
    const active = data.machines.find(machine => machine.id === data.activeMachineId)!;
    if (!configurationError && JSON.stringify(active.values) !== JSON.stringify(values)) { active.values = values; delete active.importSourceKey; await persist(root, data); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("机台与玩家列表无法读取，原文件已保留。");
    const machine: Machine = { id: randomUUID(), name: "机台 1", values };
    const players = cards.map((card, index) => ({ id: randomUUID(), name: `玩家 ${index + 1}`, machineId: machine.id, cardId: card.id }));
    let defaultCardId = "";
    try { defaultCardId = (await readVirtualCard(root)).cardId; } catch {}
    data = { version: 1, machines: [machine], activeMachineId: machine.id, players, selectedPlayerId: players.find(player => player.cardId === defaultCardId)?.id ?? players[0]?.id ?? "" };
    await persist(root, data);
  }
  return { data, configurationError };
}
export async function readVirtualCard(root: string) {
  try {
    const ini = await readIni(root), target = path.resolve(root, (ini.map.get("aime.aimepath") || "DEVICE/aime.txt").replace(/[\\/]/g, path.sep));
    let accessCode = "";
    try {
      const stat = await fs.lstat(target);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096) {
        const value = (await fs.readFile(target, "utf8")).replace(/^\uFEFF/, "").trim();
        if (/^\d{20}$/.test(value)) accessCode = value;
      }
    } catch { /* A missing/invalid card file remains editable in Aime settings. */ }
    return { path: target, accessCode, cardId: accessCode ? cardIdentity(accessCode) : "" };
  } catch { return { path: path.join(root, "DEVICE", "aime.txt"), accessCode: "", cardId: "" }; }
}
export async function stationSnapshot(root: string, cards: Card[]) {
  return serial(root, async () => {
    const { data, configurationError } = await readStore(root, cards);
    const machines = data.machines.map(displayMachine), player = data.players.find(item => item.id === data.selectedPlayerId);
    const selectedMachine = machines.find(item => item.id === (player?.machineId ?? data.activeMachineId));
    return { machines, players: data.players, selectedPlayerId: data.selectedPlayerId, activeMachineId: data.activeMachineId, server: selectedMachine?.server, configurationError, virtualCard: await readVirtualCard(root) };
  });
}
export async function machineProfiles(root: string, cards: Card[]): Promise<MachineProfilesState> {
  const state = await stationSnapshot(root, cards);
  return { machines: state.machines, activeMachineId: state.activeMachineId, cards, virtualCard: state.virtualCard, configurationError: state.configurationError };
}
export async function ensureCapturedPlayer(root: string, cards: Card[], value: unknown, registerCapturedCard?: () => Promise<void>) {
  const identity = validateCapturedPlayerIdentity(value), cardId = cardIdentity(identity.accessCode);
  const recorded = cards.some(card => card.id === cardId && card.accessCode === identity.accessCode);
  if (!recorded && typeof registerCapturedCard !== "function") throw new Error("采集卡号尚未保存，未自动归属。");
  return serial(root, async () => {
    // Initialize legacy stations with only the old catalog. The caller holds
    // profiles (and, for archives, the archives lock) before this machines lock.
    const { data } = await readStore(root, cards), machine = data.machines.find(item => item.id === data.activeMachineId)!;
    const serverId = serverIdentity(machine.values.dns.default, machine.values.dns.AimeDB).id;
    if (serverId !== serverIdentity(identity.machine.dns.default, identity.machine.dns.AimeDB).id) throw new CapturedPlayerServerMismatchError();
    let changed = false;
    let player = data.players.find(item => item.machineId === machine.id && item.cardId === cardId);
    if (!player) {
      if (data.players.length >= 500) throw new Error("最多保存 500 个玩家。");
      player = { id: randomUUID(), name: automaticName(data.players, "玩家"), machineId: machine.id, cardId };
      data.players.push(player); changed = true;
    }
    if (!data.selectedPlayerId) { data.selectedPlayerId = player.id; changed = true; }
    if (changed && Buffer.byteLength(JSON.stringify(data)) > 1024 * 1024) throw new Error("机台与玩家列表不能超过 1 MB。");
    if (!recorded) {
      // This internal callback only commits the validated card catalog; it must
      // not acquire another profiles/machines lock or change machine selection.
      await registerCapturedCard!();
      if (!cards.some(card => card.id === cardId && card.accessCode === identity.accessCode)) throw new Error("采集卡号尚未保存，未自动归属。");
    }
    if (changed) await persist(root, data);
    return { machineId: machine.id, playerId: player.id, serverId, cardId };
  });
}
export type ImportedPlayerInput = {
  saveId: string; name: string; cardId: string; machine: MachineValues; machineKey: string; playerKey: string;
  declaredServerId?: string; machineComplete?: boolean; allowLinkedCard?: boolean;
};
function importedValues(value: unknown): MachineValues {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== groups.length || Object.keys(value).some(key => !groups.some(group => group === key))) throw new Error("导入机台字段无效。");
  for (const group of groups) {
    const row = (value as MachineValues)[group];
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== keys[group].length
        || Object.keys(row).some(key => !keys[group].some(allowed => allowed === key))
        || keys[group].some(key => typeof row[key] !== "string")) throw new Error("导入机台字段无效。");
  }
  return normalizedValues(value, false);
}
function importedFieldMatches(group: typeof groups[number], key: string, source: string, actual: string) {
  if (group === "keychip" && key === "id") {
    const expected = source.replace("-", "").toUpperCase(), stored = actual.replace("-", "").toUpperCase();
    return expected.length === 11 ? expected === stored.slice(0, 11) : expected === stored;
  }
  if (group === "dns") {
    try {
      const parse = (value: string) => { const url = new URL(value.includes("://") ? value : `http://${value}`); url.hostname = url.hostname.replace(/\.$/, ""); return url; };
      const a = parse(source), b = parse(actual);
      return key === "AimeDB" ? a.hostname === b.hostname && (a.port || "22345") === (b.port || "22345") : a.origin === b.origin;
    } catch { return source === actual; }
  }
  return source === actual;
}
export async function ensureImportedPlayer(root: string, cards: Card[], input: ImportedPlayerInput) {
  if (!input || !idValid(input.saveId) || !sourceKeyValid(input.machineKey) || !sourceKeyValid(input.playerKey)
      || typeof input.cardId !== "string" || input.cardId !== "" && !cards.some(card => card.id === input.cardId)
      || input.declaredServerId !== undefined && !sourceKeyValid(input.declaredServerId)
      || input.machineComplete !== undefined && typeof input.machineComplete !== "boolean"
      || input.allowLinkedCard !== undefined && typeof input.allowLinkedCard !== "boolean"
      || typeof input.name !== "string" || input.name.length > 2000) throw new Error("导入玩家来源无效。");
  const values = importedValues(input.machine), name = input.name.replace(/[\r\n\0]/g, " ").trim().slice(0, 40);
  return serial(root, async () => {
    const { data } = await readStore(root, cards);
    let changed = false, machine = data.machines.find(item => item.importSourceKey === input.machineKey);
    const fields = ([...["default", "AimeDB"].map(key => ({ group: "dns" as const, key })),
      ...["id", "subnet"].map(key => ({ group: "keychip" as const, key }))]).filter(({ group, key }) => !!values[group][key]);
    if (!machine && (fields.length || input.declaredServerId)) {
      // A declared identity can come from a verified archive mapping. Its API address or
      // display label is not necessarily the original Segatools DNS configuration.
      const matchingFields = input.declaredServerId && !input.machineComplete ? fields.filter(field => field.group === "keychip") : fields;
      const candidates = data.machines.filter(item => (!input.declaredServerId || displayMachine(item).server?.id === input.declaredServerId)
        && (input.machineComplete ? JSON.stringify(item.values) === JSON.stringify(values)
          : matchingFields.every(({ group, key }) => importedFieldMatches(group, key, values[group][key], item.values[group][key]))));
      // Partial evidence never resolves an ambiguity by preferring the active station.
      if (candidates.length === 1 || input.machineComplete && candidates.length > 1) machine = candidates[0];
    }
    if (!machine) {
      if (data.machines.length >= 100) throw new Error("最多保存 100 个机台。");
      machine = { id: randomUUID(), name: automaticName(data.machines, "机台"), values, importSourceKey: input.machineKey };
      data.machines.push(machine); changed = true;
    } else if (machine.importSourceKey !== input.machineKey) { machine.importSourceKey = input.machineKey; changed = true; }
    const archiveOwner = data.players.find(item => item.importedSaveIds?.includes(input.saveId));
    if (archiveOwner && (archiveOwner.machineId !== machine.id || input.cardId && archiveOwner.cardId && archiveOwner.cardId !== input.cardId
        || !input.cardId && input.allowLinkedCard === false && !!archiveOwner.cardId)) throw new Error("导入存档已属于其他玩家，原归属保留。");
    let player = archiveOwner ?? (input.cardId ? data.players.find(item => item.machineId === machine!.id && item.cardId === input.cardId) : undefined);
    if (!player) {
      const candidates = data.players.filter(item => item.machineId === machine!.id && item.importSourceKeys?.includes(input.playerKey)
        && (!input.cardId ? input.allowLinkedCard !== false || !item.cardId : !item.cardId || item.cardId === input.cardId));
      if (candidates.length === 1) player = candidates[0];
    }
    if (!player) {
      if (data.players.length >= 500) throw new Error("最多保存 500 个玩家。");
      player = { id: randomUUID(), name: name || automaticName(data.players, "玩家"), machineId: machine.id, cardId: input.cardId };
      data.players.push(player); changed = true;
    } else if (!player.cardId && input.cardId) { player.cardId = input.cardId; changed = true; }
    if (!player.importedSaveIds?.includes(input.saveId)) {
      if ((player.importedSaveIds?.length ?? 0) >= 500) throw new Error("每位玩家最多关联 500 份导入存档。");
      player.importedSaveIds = [...(player.importedSaveIds ?? []), input.saveId]; changed = true;
    }
    if (!player.importSourceKeys?.includes(input.playerKey)) {
      if ((player.importSourceKeys?.length ?? 0) >= 500) throw new Error("每位玩家最多保存 500 个导入来源。");
      player.importSourceKeys = [...(player.importSourceKeys ?? []), input.playerKey]; changed = true;
    }
    if (!data.selectedPlayerId) { data.selectedPlayerId = player.id; changed = true; }
    if (changed) await persist(root, data);
    return { playerId: player.id, machineId: machine.id, serverId: displayMachine(machine).server?.id, cardId: player.cardId };
  });
}
export async function attachImportedSaveToPlayer(root: string, cards: Card[], input: { playerId: string; saveId: string }) {
  if (!input || !idValid(input.playerId) || !idValid(input.saveId)) throw new Error("导入玩家或存档编号无效。");
  return serial(root, async () => {
    // Attachment can only target an existing player; it must not trigger legacy migration.
    try { await fs.access(storePath(root)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("玩家已变化，请重新选择后导入。"); throw error; }
    const { data } = await readStore(root, cards), player = data.players.find(item => item.id === input.playerId);
    if (!player) throw new Error("玩家已变化，请重新选择后导入。");
    const owner = data.players.find(item => item.importedSaveIds?.includes(input.saveId));
    if (owner && owner.id !== player.id) throw new Error("导入存档已属于其他玩家，原归属保留。");
    if (!player.importedSaveIds?.includes(input.saveId)) {
      if ((player.importedSaveIds?.length ?? 0) >= 500) throw new Error("每位玩家最多关联 500 份导入存档。");
      player.importedSaveIds = [...(player.importedSaveIds ?? []), input.saveId];
      await persist(root, data);
    }
    const machine = data.machines.find(item => item.id === player.machineId)!;
    return { playerId: player.id, machineId: player.machineId, serverId: displayMachine(machine).server?.id, cardId: player.cardId };
  });
}
function patchIni(document: IniDocument, values: MachineValues) {
  const newline = document.text.includes("\r\n") ? "\r\n" : "\n";
  const byteText = document.text.startsWith("\uFEFF") || document.encode("A").length > 1 ? false : true;
  const encodeValue = (value: string) => byteText ? Buffer.from(value, "utf8").toString("latin1") : value;
  const lines = document.text.split(/\r?\n/);
  for (const group of groups) for (const key of keys[group]) {
    const next = encodeValue(values[group][key]); let section = "", found = false;
    const commentWhenEmpty = !next && (group === "dns" && key === "AimeDB" || group === "keychip" && key === "id");
    for (let index = 0; index < lines.length; index++) {
      const heading = lines[index].trim().replace(/^\xEF\xBB\xBF/, "").match(/^\[([^\]]+)\]/);
      if (heading) { section = heading[1].trim().toLowerCase(); continue; }
      if (section !== group) continue;
      const item = lines[index].match(/^(\s*)([^;#=]+?)(\s*=\s*)(.*)$/);
      if (!item || item[2].trim().toLowerCase() !== key.toLowerCase()) continue;
      found = true;
      const comment = item[4].match(/(\s+[;#].*)$/)?.[1] ?? "";
      lines[index] = commentWhenEmpty ? `${item[1]};${item[2]}${item[3]}${item[4]}` : `${item[1]}${item[2]}${item[3]}${next}${comment}`;
    }
    if (!found && !commentWhenEmpty) {
      const start = lines.findIndex(line => line.trim().replace(/^\xEF\xBB\xBF/, "").match(/^\[([^\]]+)\]/)?.[1].trim().toLowerCase() === group);
      if (start < 0) lines.push("", `[${group}]`, `${key}=${next}`);
      else {
        let end = start + 1;
        while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
        lines.splice(end, 0, `${key}=${next}`);
      }
    }
  }
  return document.encode(lines.join(newline));
}
async function applyValues(root: string, values: MachineValues) {
  const ini = await readIni(root), proposed = patchIni(ini.document, values);
  if (proposed.equals(ini.bytes)) return;
  const dir = path.join(saveDirectory(root), "machine-backups"); await fs.mkdir(dir, { recursive: true });
  const backup = path.join(dir, `machine-${Date.now()}-${randomUUID()}.bak`);
  await fs.writeFile(backup, ini.bytes, { flag: "wx" });
  const temp = `${ini.file}.ogk-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, proposed, { flag: "wx" });
    if (!(await fs.readFile(ini.file)).equals(ini.bytes)) throw new Error("Segatools 已被其他程序修改，请重新操作。");
    await fs.rename(temp, ini.file);
  } finally { await fs.unlink(temp).catch(() => {}); }
}
export async function saveMachineProfile(root: string, cards: Card[], request: SaveMachineProfileRequest, requireStopped: () => Promise<void>) {
  const name = safeName(request?.name, "机台"), values = normalizedValues(request?.values);
  if (request.id !== undefined && !idValid(request.id)) throw new Error("机台编号无效。");
  return serial(root, async () => {
    const { data } = await readStore(root, cards);
    let machine = request.id ? data.machines.find(item => item.id === request.id) : undefined;
    if (request.id && !machine) throw new Error("机台已变化，请重新选择。");
    if (!machine) {
      if (data.machines.length >= 100) throw new Error("最多保存 100 个机台。");
      machine = { id: randomUUID(), name, values }; data.machines.push(machine);
    } else {
      if (machine.id === data.activeMachineId && JSON.stringify(machine.values) !== JSON.stringify(values)) { await requireStopped(); await applyValues(root, values); }
      if (JSON.stringify(machine.values) !== JSON.stringify(values)) delete machine.importSourceKey;
      machine.name = name; machine.values = values;
    }
    await persist(root, data); return displayMachine(machine);
  });
}
export async function activateMachineProfile(root: string, cards: Card[], id: string, requireStopped: () => Promise<void>) {
  if (!idValid(id)) throw new Error("机台编号无效。");
  return serial(root, async () => {
    const { data } = await readStore(root, cards), machine = data.machines.find(item => item.id === id);
    if (!machine) throw new Error("机台已变化，请重新选择。");
    const values = normalizedValues(machine.values);
    await requireStopped(); await applyValues(root, values);
    data.activeMachineId = id; await persist(root, data);
  });
}
export async function savePlayerProfile(root: string, cards: Card[], request: SavePlayerProfileRequest) {
  const name = safeName(request?.name, "玩家");
  if (!idValid(request?.machineId) || typeof request?.cardId !== "string" || request.cardId !== "" && !cards.some(card => card.id === request.cardId) || request.id !== undefined && !idValid(request.id)) throw new Error("请选择有效机台和卡片。");
  return serial(root, async () => {
    const { data } = await readStore(root, cards);
    if (!data.machines.some(machine => machine.id === request.machineId)) throw new Error("机台已变化，请重新选择。");
    let player = request.id ? data.players.find(item => item.id === request.id) : undefined;
    if (request.id && !player) throw new Error("玩家已变化，请重新选择。");
    if (!request.cardId && !player?.importedSaveIds?.length) throw new Error("请选择有效卡片，普通玩家必须关联真实卡号。");
    if (!player) {
      if (data.players.length >= 500) throw new Error("最多保存 500 个玩家。");
      player = { id: randomUUID(), name, machineId: request.machineId, cardId: request.cardId }; data.players.push(player);
    } else { player.name = name; player.machineId = request.machineId; player.cardId = request.cardId; }
    await persist(root, data); return player.id;
  });
}
export async function deleteMachineProfile(root: string, cards: Card[], id: string) {
  if (!idValid(id)) throw new Error("机台编号无效。");
  return serial(root, async () => {
    const { data } = await readStore(root, cards);
    if (!data.machines.some(machine => machine.id === id)) throw new Error("机台已变化，请重新选择。");
    if (data.machines.length === 1) throw new Error("至少保留一个机台。");
    if (data.activeMachineId === id) throw new Error("请先将另一机台设为当前。");
    if (data.players.some(player => player.machineId === id)) throw new Error("请先修改使用此机台的玩家。");
    data.machines = data.machines.filter(machine => machine.id !== id);
    await persist(root, data);
  });
}
export async function deletePlayerProfile(root: string, cards: Card[], id: string) {
  if (!idValid(id)) throw new Error("玩家编号无效。");
  return serial(root, async () => {
    const { data } = await readStore(root, cards);
    if (!data.players.some(player => player.id === id)) throw new Error("玩家已变化，请重新选择。");
    data.players = data.players.filter(player => player.id !== id);
    if (data.selectedPlayerId === id) data.selectedPlayerId = data.players[0]?.id ?? "";
    await persist(root, data);
  });
}
export async function selectPlayerProfile(root: string, cards: Card[], id: string, isCurrent: () => boolean = () => true) {
  if (!idValid(id)) throw new Error("玩家编号无效。");
  return serial(root, async () => {
    const { data } = await readStore(root, cards);
    if (!data.players.some(player => player.id === id)) throw new Error("玩家已变化，请重新选择。");
    if (!isCurrent()) return;
    data.selectedPlayerId = id; await persist(root, data);
  });
}
export async function selectedPlayerConnection(root: string, cards: Card[], cardId?: string): Promise<PlayerConnectionInput> {
  if (cardId === "") throw new Error("请先为当前玩家关联真实卡号。");
  // Legacy callers without a station file keep their original INI-only contract.
  try { await fs.access(storePath(root)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return playerConnectionDefaults(root); throw error; }
  return serial(root, async () => {
    const { data, configurationError } = await readStore(root, cards);
    const player = data.players.find(item => item.id === data.selectedPlayerId);
    if (cardId !== undefined && !player) throw new Error("请先新增并选择玩家。");
    if (cardId !== undefined && (!cardId || !player?.cardId)) throw new Error("请先为当前玩家关联真实卡号。");
    if (player && cardId !== undefined && player.cardId !== cardId) throw new Error("当前玩家已变化，请选择对应玩家后操作。");
    const machine = data.machines.find(item => item.id === (player?.machineId ?? data.activeMachineId))!;
    if (machine.id === data.activeMachineId && configurationError) throw new Error(configurationError);
    const current = await playerConnectionDefaults(root);
    return { ...current, server: machine.values.dns.default, aimeServer: machine.values.dns.AimeDB, keychip: machine.values.keychip.id };
  });
}
export async function setVirtualPlayerCard(root: string, cards: Card[], cardId: string, requireStopped: () => Promise<void>) {
  const card = cards.find(item => item.id === cardId); if (!card) throw new Error("请选择有效卡片。");
  return serial(root, async () => {
    await requireStopped(); const ini = await readIni(root);
    const target = path.resolve(root, (ini.map.get("aime.aimepath") || "DEVICE/aime.txt").replace(/[\\/]/g, path.sep));
    if (path.extname(target).toLowerCase() !== ".txt") throw new Error("Aime 卡号路径必须指向 .txt 文件。");
    let original: Buffer | undefined;
    try { const stat = await fs.lstat(target); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("卡号路径不是有效的小型文本文件。"); original = await fs.readFile(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const proposed = Buffer.from(`${card.accessCode}\n`, "utf8"); if (original?.equals(proposed)) return;
    if (original) {
      const dir = path.join(saveDirectory(root), "card-backups"); await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${Date.now()}-${randomUUID()}.bak`), original, { flag: "wx" });
    }
    await fs.mkdir(path.dirname(target), { recursive: true }); const temp = `${target}.ogk-${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, proposed, { flag: "wx" });
      if (!(await fs.readFile(ini.file)).equals(ini.bytes)) throw new Error("卡号路径配置已变化，请重新操作。");
      let fresh: Buffer | undefined;
      try { fresh = await fs.readFile(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (original ? !fresh?.equals(original) : fresh !== undefined) throw new Error("卡号文件已被其他程序修改，请重新操作。");
      await fs.rename(temp, target);
    } finally { await fs.unlink(temp).catch(() => {}); }
  });
}
export async function machineBackups(root: string) {
  const dir = path.join(saveDirectory(root), "machine-backups");
  const names = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  return Promise.all(names.filter(name => /^machine-\d+-[a-f0-9-]+\.bak$/.test(name)).map(async name => ({ name, id: name, createdAt: (await fs.stat(path.join(dir, name))).mtime.toISOString() })));
}
export async function restoreMachineBackup(root: string, name: string, requireStopped: () => Promise<void>) {
  if (!/^machine-\d+-[a-f0-9-]+\.bak$/.test(name)) throw new Error("机台备份编号无效。");
  return serial(root, async () => {
    await requireStopped(); const file = path.join(saveDirectory(root), "machine-backups", name), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("机台备份无效。");
    const ini = await readIni(root), backup = await fs.readFile(file);
    const dir = path.dirname(file); await fs.writeFile(path.join(dir, `machine-${Date.now()}-${randomUUID()}.bak`), ini.bytes, { flag: "wx" });
    const temp = `${ini.file}.ogk-${randomUUID()}.tmp`;
    try { await fs.writeFile(temp, backup, { flag: "wx" }); if (!(await fs.readFile(ini.file)).equals(ini.bytes)) throw new Error("配置已变化，请重新操作。"); await fs.rename(temp, ini.file); }
    finally { await fs.unlink(temp).catch(() => {}); }
  });
}
