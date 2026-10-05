import { refreshFromGame } from "./player-capture";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { playerConnectionDefaults, fetchPlayerFromConfiguration } from "./player-bootstrap";
import { cardIdentity, normalizeCard, serverIdentity, saveOwnerKey, validScope, type SaveScope } from "./player-identity";
import { deletePlayerArchives, persistSave, listSaves, saveDirectory, summarizeSave, readSave, type SaveSummary } from "./player-save";
import { mergePlayerBestArchive, validateBestMergeSelection } from "./player-best-merge";
import { stationSnapshot, selectedPlayerConnection, readVirtualCard, ensureCapturedPlayer, ensureImportedPlayer, attachImportedSaveToPlayer, validateCapturedPlayerIdentity, CapturedPlayerServerMismatchError, type CapturedPlayerIdentity } from "./machine-profiles";
import { importedSaveSource } from "./player-import-source";
import { getPlayerSaveEditor as buildPlayerSaveEditor, preparePlayerSaveEdit } from "./player-save-editor";
import { pendingPlayerEdit, queuePlayerGameEdit, cancelPlayerGameEdit, playerEditModEnabled } from "./player-game-edits";
import { validatePlayerSaveEditorPatch } from "./player-save-editor";

type Card = { id: string; accessCode: string };
type Profiles = { version: 1; cards: Card[]; bindings: Record<string, SaveScope> };
const queues = new Map<string, Promise<unknown>>();
async function serial<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(root).toLowerCase(), previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action); queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
async function readProfiles(root: string): Promise<Profiles> {
  try {
    const file = path.join(saveDirectory(root), "profiles.json");
    if ((await fs.stat(file)).size > 1024 * 1024) throw new Error();
    const data = JSON.parse(await fs.readFile(file, "utf8")) as Profiles;
    if (data.version !== 1 || !Array.isArray(data.cards) || data.cards.length > 100 || !data.bindings || typeof data.bindings !== "object" || Array.isArray(data.bindings)) throw new Error();
    if (data.cards.some(card => card.id !== cardIdentity(card.accessCode)) || new Set(data.cards.map(card => card.id)).size !== data.cards.length || Object.values(data.bindings).some(scope => !validScope(scope))) throw new Error();
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, cards: [], bindings: {} };
    throw new Error("卡号列表无法读取，原文件已保留。");
  }
}
async function writeProfiles(root: string, data: Profiles) {
  const dir = saveDirectory(root); await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "profiles.json"), temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data), { encoding: "utf8", flag: "wx" });
  await fs.rename(temp, file);
}
export async function playerProfiles(root: string) {
  return serial(root, async () => {
    const data = await readProfiles(root);
    let configurationError = "", defaultCardId = "";
    try {
      const config = await playerConnectionDefaults(root);
      if (config.accessCode) {
        defaultCardId = cardIdentity(config.accessCode);
        if (!data.cards.some(card => card.id === defaultCardId) && data.cards.length < 100) {
          data.cards.push({ id: defaultCardId, accessCode: config.accessCode }); await writeProfiles(root, data);
        }
      }
    } catch (error) { configurationError = (error as Error).message; }
    const virtual = await readVirtualCard(root);
    if (virtual.cardId && !data.cards.some(card => card.id === virtual.cardId) && data.cards.length < 100) {
      data.cards.push({ id: virtual.cardId, accessCode: virtual.accessCode }); await writeProfiles(root, data);
    }
    const stations = await stationSnapshot(root, data.cards);
    const selected = stations.players.find(player => player.id === stations.selectedPlayerId);
    return { cards: data.cards, server: stations.server, defaultCardId: selected?.cardId ?? defaultCardId,
      configurationError: stations.configurationError || configurationError,
      machines: stations.machines, players: stations.players, selectedPlayerId: stations.selectedPlayerId, activeMachineId: stations.activeMachineId };
  });
}
export async function addPlayerCard(root: string, value: string) {
  const accessCode = normalizeCard(value), id = cardIdentity(accessCode);
  return serial(root, async () => {
    const data = await readProfiles(root);
    if (!data.cards.some(card => card.id === id)) {
      if (data.cards.length >= 100) throw new Error("最多保存 100 个卡号。");
      data.cards.push({ id, accessCode }); await writeProfiles(root, data);
    }
    return id;
  });
}
export async function reorderPlayerCards(root: string, ids: string[]) {
  return serial(root, async () => {
    const data = await readProfiles(root);
    if (!Array.isArray(ids) || ids.length !== data.cards.length || new Set(ids).size !== ids.length || ids.some(id => !data.cards.some(card => card.id === id))) throw new Error("卡号列表已变化，请重新排序。");
    data.cards = ids.map(id => data.cards.find(card => card.id === id)!); await writeProfiles(root, data);
  });
}
export async function scopedPlayerSaves(root: string): Promise<SaveSummary[]> {
  return serial(root, async () => {
    const data = await readProfiles(root), stations = await stationSnapshot(root, data.cards);
    return scopePlayerSaves(await listSaves(root), data, stations);
  });
}
export async function capturedPlayerScope(root: string, value: unknown): Promise<SaveScope> {
  // Validate all capture evidence before any migration or local-profile writes.
  const identity = validateCapturedPlayerIdentity(value);
  return serial(root, () => capturedScopeCore(root, identity));
}
async function capturedScopeCore(root: string, identity: CapturedPlayerIdentity): Promise<SaveScope> {
  const cardId = cardIdentity(identity.accessCode), data = await readProfiles(root);
  // First migration may bind every existing card to today's active station.
  // Initialize with only the old catalog before adding the captured card.
  const stations = await stationSnapshot(root, data.cards), active = stations.machines.find(machine => machine.id === stations.activeMachineId);
  if (active?.server?.id !== serverIdentity(identity.machine.dns.default, identity.machine.dns.AimeDB).id) throw new CapturedPlayerServerMismatchError();
  const missingCard = !data.cards.some(card => card.id === cardId);
  if (missingCard && data.cards.length >= 100) throw new Error("最多保存 100 个卡号。");
  const registerCapturedCard = missingCard ? async () => {
    // Called only after the second source check under the machines lock.
    data.cards.push({ id: cardId, accessCode: identity.accessCode });
    await writeProfiles(root, data);
  } : undefined;
  const source = await ensureCapturedPlayer(root, data.cards, identity, registerCapturedCard);
  return { serverId: source.serverId, cardId: source.cardId };
}
export async function persistCapturedPlayerSave(root: string, raw: unknown, session: string, value: unknown): Promise<SaveSummary> {
  const identity = validateCapturedPlayerIdentity(value);
  if (typeof session !== "string" || !/^[a-f0-9]{32}$/.test(session)) throw new Error("采集会话无效。");
  // Hold profiles → archives → machines in the same order as import/merge.
  // The archive lock checks deletion before any card or player is created.
  return serial(root, () => persistSave(root, raw, "game", `game-${session}`, undefined, undefined, () => capturedScopeCore(root, identity)));
}
function scopePlayerSaves(saves: SaveSummary[], data: Profiles, stations?: Awaited<ReturnType<typeof stationSnapshot>>): SaveSummary[] {
  // Only successful direct reads establish an automatic endpoint/player -> card mapping.
  const owners = new Map<string, Map<string, SaveScope>>();
  for (const save of saves) if (save.ownerKey && validScope(save.scope) && save.source === "direct") {
    for (const ownerKey of save.ownerKeys ?? [save.ownerKey]) {
      const scopes = owners.get(ownerKey) ?? new Map<string, SaveScope>();
      scopes.set(`${save.scope.serverId}:${save.scope.cardId}`, save.scope); owners.set(ownerKey, scopes);
    }
  }
  return saves.map(save => {
    const player = stations?.players.find(player => player.importedSaveIds?.includes(save.id));
    const machine = stations?.machines.find(machine => machine.id === player?.machineId);
    const importedScope = player?.cardId && machine?.server && data.cards.some(card => card.id === player.cardId)
      && (!save.serverId || save.serverId === machine.server.id) ? { serverId: machine.server.id, cardId: player.cardId } : undefined;
    const matches = save.ownerKey ? owners.get(save.ownerKey) : undefined;
    const inferred = save.source !== "json" && matches?.size === 1 ? [...matches.values()][0] : undefined;
    return { ...save, localPlayerId: player?.id, scope: data.bindings[save.id] ?? (validScope(save.scope) ? save.scope : importedScope ?? inferred) };
  });
}
function editorOwner(stations: Awaited<ReturnType<typeof stationSnapshot>>, saves: SaveSummary[], saveId: string, playerId: string) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(saveId) || !/^[a-zA-Z0-9-]{1,80}$/.test(playerId)) throw new Error("请选择玩家和存档。");
  const player = stations.players.find(player => player.id === playerId);
  if (!player || stations.selectedPlayerId !== playerId) throw new Error("当前玩家已变化，请重新打开存档编辑。");
  const save = saves.find(save => save.id === saveId), machine = stations.machines.find(machine => machine.id === player.machineId);
  if (!save || (save.localPlayerId ? save.localPlayerId !== playerId : !player.cardId || !machine?.server || save.scope?.cardId !== player.cardId || save.scope.serverId !== machine.server.id)) throw new Error("存档不属于当前玩家，原存档保留。");
  return { save, player, scope: save.scope };
}
export async function requirePlayerSaveOwner(root: string, saveId: string, playerId: string) {
  return serial(root, async () => {
    const data = await readProfiles(root), stations = await stationSnapshot(root, data.cards);
    return editorOwner(stations, scopePlayerSaves(await listSaves(root), data, stations), saveId, playerId);
  });
}
async function editorSource(root: string, saveId: string) {
  const file = path.join(saveDirectory(root), "archives", `${saveId}.json`), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("存档记录已变化，请重新选择。");
  const stored = await readSave(file) as { raw?: unknown };
  if (!stored || stored.raw === undefined) throw new Error("存档缺少原始内容，原存档保留。");
  return stored.raw;
}
export async function getManagedPlayerSaveEditor(root: string, saveId: string, playerId: string) {
  return serial(root, async () => {
    const data = await readProfiles(root), stations = await stationSnapshot(root, data.cards);
    const { save } = editorOwner(stations, scopePlayerSaves(await listSaves(root), data, stations), saveId, playerId);
    const state = await buildPlayerSaveEditor(root, save, await editorSource(root, saveId), playerId);
    state.gameEditEnabled = await playerEditModEnabled(root);
    if (save.scope?.cardId) {
      const card = data.cards.find(card => card.id === save.scope!.cardId);
      if (card) {
        const config = await selectedPlayerConnection(root, data.cards, card.id);
        state.pendingEdit = await pendingPlayerEdit(root, { ...config, accessCode: card.accessCode });
      }
    }
    return state;
  });
}
export async function queueManagedPlayerEdit(root: string, saveId: string, playerId: string, patch: import("../src/player-save-editor-models").PlayerSaveEditorPatch) {
  return serial(root, async () => {
    const data = await readProfiles(root), stations = await stationSnapshot(root, data.cards);
    const { save, player } = editorOwner(stations, scopePlayerSaves(await listSaves(root), data, stations), saveId, playerId);
    const card = data.cards.find(card => card.id === player.cardId);
    if (!card || !save.scope || save.scope.cardId !== card.id) throw Error("请先将存档关联至当前玩家的卡号和服务器。");
    const config = await selectedPlayerConnection(root, data.cards, card.id);
    if (serverIdentity(config.server, config.aimeServer).id !== save.scope.serverId) throw Error("存档与玩家服务器不匹配。");
    const state = await buildPlayerSaveEditor(root, save, await editorSource(root, saveId), playerId);
    const normalized = validatePlayerSaveEditorPatch(patch, state, save.scores);
    const current = await stationSnapshot(root, data.cards);
    editorOwner(current, scopePlayerSaves(await listSaves(root), data, current), saveId, playerId);
    const latest = await selectedPlayerConnection(root, data.cards, card.id);
    if (JSON.stringify(config) !== JSON.stringify(latest)) throw Error("玩家配置已变化，请重新打开编辑器。");
    return queuePlayerGameEdit(root, { ...config, accessCode: card.accessCode }, normalized, state);
  });
}
export async function managedPlayerEditStatus(root: string, saveId: string, playerId: string) {
  const { player } = await requirePlayerSaveOwner(root, saveId, playerId);
  if (!player.cardId) return undefined;
  const data = await serial(root, () => readProfiles(root));
  const card = data.cards.find(card => card.id === player.cardId);
  if (!card) return undefined;
  const config = await selectedPlayerConnection(root, data.cards, card.id);
  return pendingPlayerEdit(root, { ...config, accessCode: card.accessCode });
}
export async function cancelManagedPlayerEdit(root: string, saveId: string, playerId: string, id: string, discardActive: boolean) {
  return serial(root, async () => {
    const data = await readProfiles(root), stations = await stationSnapshot(root, data.cards);
    const { player } = editorOwner(stations, scopePlayerSaves(await listSaves(root), data, stations), saveId, playerId);
    const card = data.cards.find(card => card.id === player.cardId);
    if (!card) throw Error("玩家卡号已变化。");
    const config = await selectedPlayerConnection(root, data.cards, card.id);
    await cancelPlayerGameEdit(root, { ...config, accessCode: card.accessCode }, id, discardActive);
  });
}
export async function saveManagedPlayerSaveEditor(root: string, saveId: string, playerId: string, patch: import("../src/player-save-editor-models").PlayerSaveEditorPatch) {
  return serial(root, async () => {
    const data = await readProfiles(root), stations = await stationSnapshot(root, data.cards);
    const { save, player } = editorOwner(stations, scopePlayerSaves(await listSaves(root), data, stations), saveId, playerId);
    const prepared = await preparePlayerSaveEdit(root, save, await editorSource(root, saveId), patch, playerId);
    const current = await stationSnapshot(root, data.cards);
    const owner = editorOwner(current, scopePlayerSaves(await listSaves(root), data, current), saveId, playerId);
    const originalMachine = stations.machines.find(machine => machine.id === player.machineId);
    const currentMachine = current.machines.find(machine => machine.id === owner.player.machineId);
    if (player.machineId !== owner.player.machineId || player.cardId !== owner.player.cardId || JSON.stringify(originalMachine?.values) !== JSON.stringify(currentMachine?.values)) throw new Error("玩家机台或卡号配置已变化，请重新打开存档编辑，原存档保留。");
    if (prepared.unchanged) return owner.save;
    const machine = current.machines.find(machine => machine.id === owner.player.machineId);
    const scope = owner.player.cardId && machine?.server && data.cards.some(card => card.id === owner.player.cardId)
      ? { serverId: machine.server.id, cardId: owner.player.cardId } : undefined;
    let saved: SaveSummary | undefined;
    try {
      saved = await persistSave(root, prepared.raw, "json", `edit-${randomUUID()}`, scope);
      await attachImportedSaveToPlayer(root, data.cards, { playerId, saveId: saved.id });
      return { ...saved, localPlayerId: playerId, newPlayerRating: undefined };
    } catch (error) {
      if (saved) await deletePlayerArchives(root, [saved.id]);
      throw error;
    }
  });
}
export async function mergePlayerBest(root: string, targetId: string, sourceIds: string[], cardId: string, serverId: string): Promise<SaveSummary> {
  validateBestMergeSelection(targetId, sourceIds);
  if (!validScope({ serverId, cardId })) throw new Error("请选择有效的卡号和服务器。");
  return serial(root, () => mergePlayerBestArchive(root, targetId, sourceIds, { serverId, cardId }, async () => {
    const data = await readProfiles(root), config = await selectedPlayerConnection(root, data.cards, cardId), server = serverIdentity(config.server, config.aimeServer);
    if (server.id !== serverId) throw new Error("服务器配置已变化，请重新选择存档后操作。");
    if (!data.cards.some(card => card.id === cardId)) throw new Error("请选择有效卡号。");
    return scopePlayerSaves(await listSaves(root), data, await stationSnapshot(root, data.cards));
  }));
}
export async function requirePlayerScope(root: string, cardId: string, serverId: string) {
  const data = await serial(root, () => readProfiles(root));
  const config = await selectedPlayerConnection(root, data.cards, cardId), server = serverIdentity(config.server, config.aimeServer);
  if (server.id !== serverId) throw new Error("服务器配置已变化，请重新选择存档后操作。");
  const card = data.cards.find(card => card.id === cardId);
  if (!card) throw new Error("请选择有效卡号。");
  return { config: { ...config, accessCode: card.accessCode }, scope: { serverId, cardId } };
}
export async function fetchManagedPlayerSave(root: string, cardId: string, serverId: string, signal?: AbortSignal) {
  const { config } = await requirePlayerScope(root, cardId, serverId);
  return fetchPlayerFromConfiguration(root, config, signal);
}
export async function bindPlayerSave(root: string, saveId: string, cardId: string, serverId: string) {
  const { scope } = await requirePlayerScope(root, cardId, serverId);
  const saves = await scopedPlayerSaves(root), save = saves.find(item => item.id === saveId);
  if (!save || save.scope) throw new Error("只可归属未分组存档，请刷新后重试。");
  await serial(root, async () => { const data = await readProfiles(root); if (data.bindings[saveId]) throw new Error("存档归属已变化，请刷新后重试。"); data.bindings[saveId] = scope; await writeProfiles(root, data); });
}

export async function refreshManagedPlayerSave(root: string, saveId: string, cardId: string, serverId: string, signal?: AbortSignal) {
  const { scope } = await requirePlayerScope(root, cardId, serverId);
  const save = (await scopedPlayerSaves(root)).find(item => item.id === saveId);
  if (!save?.sessionId || save.source === "json" || save.scope?.cardId !== cardId || save.scope.serverId !== serverId) throw new Error("请选择当前服务器和卡号的采集存档。");
  return refreshFromGame(root, save.sessionId, signal, undefined, scope);
}

export type PlayerSaveDeleteScope = { serverId: string; cardId?: string } | { localPlayerId: string } | null;
export async function deleteManagedPlayerSaves(root: string, ids: string[], scope: PlayerSaveDeleteScope) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id))) throw new Error("请选择有效存档。");
  if (scope && "localPlayerId" in scope) {
    if (typeof scope.localPlayerId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(scope.localPlayerId) || Object.keys(scope).length !== 1) throw new Error("存档分组无效。");
    return serial(root, async () => {
      const data = await readProfiles(root), stations = await stationSnapshot(root, data.cards);
      const player = stations.players.find(player => player.id === scope.localPlayerId), machine = stations.machines.find(machine => machine.id === player?.machineId);
      if (!player) throw new Error("玩家已变化，请重新选择。");
      const saves = scopePlayerSaves(await listSaves(root), data, stations);
      for (const id of ids) {
        const save = saves.find(save => save.id === id);
        if (!save || (save.localPlayerId ? save.localPlayerId !== player.id : !player.cardId || !machine?.server || save.scope?.cardId !== player.cardId || save.scope.serverId !== machine.server.id)) throw new Error("存档分组已变化，请重新选择。");
      }
      await deletePlayerArchives(root, ids);
    });
  }
  if (scope !== null && (!/^[a-f0-9]{64}$/.test(scope?.serverId) || scope.cardId !== undefined && !validScope(scope))) throw new Error("存档分组无效。");
  if (scope?.cardId) await requirePlayerScope(root, scope.cardId, scope.serverId);
  else if (scope) await requireImportServer(root, scope.serverId);
  const saves = await scopedPlayerSaves(root);
  for (const id of ids) {
    const save = saves.find(item => item.id === id);
    if (!save || save.localPlayerId || (scope?.cardId ? save.scope?.serverId !== scope.serverId || save.scope.cardId !== scope.cardId : !!save.scope || (save.serverId ?? null) !== (scope?.serverId ?? null))) throw new Error("存档分组已变化，请重新选择。");
  }
  await deletePlayerArchives(root, ids);
}

async function requireImportServer(root: string, expected: string | null) {
  if (expected === null) return;
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("服务器标识无效。");
  const config = await selectedPlayerConnection(root, (await readProfiles(root)).cards);
  if (serverIdentity(config.server, config.aimeServer).id !== expected) throw new Error("服务器配置已变化，请重试导入。");
}
export async function importManagedPlayerSave(root: string, raw: unknown, serverId: string | null, destinationPlayerId?: string) {
  if (serverId !== null && (typeof serverId !== "string" || !/^[a-f0-9]{64}$/.test(serverId))) throw new Error("服务器标识无效。");
  if (destinationPlayerId !== undefined && (typeof destinationPlayerId !== "string" || destinationPlayerId !== "" && !/^[a-zA-Z0-9-]{1,80}$/.test(destinationPlayerId))) throw new Error("导入玩家无效。");
  const summary = summarizeSave(raw, "json");
  return serial(root, async () => {
    const data = await readProfiles(root);
    const stations = await stationSnapshot(root, data.cards);
    const targetId = destinationPlayerId ?? stations.selectedPlayerId;
    if (targetId) {
      const player = stations.players.find(player => player.id === targetId);
      if (!player) throw new Error("玩家已变化，请重新选择后导入。");
      const machine = stations.machines.find(machine => machine.id === player.machineId);
      const scope = player.cardId && machine?.server && data.cards.some(card => card.id === player.cardId)
        ? { serverId: machine.server.id, cardId: player.cardId } : undefined;
      let saved: SaveSummary | undefined;
      try {
        // The chosen local player owns this import. Source identities stay in raw,
        // and cannot change the user's machine, card catalog or player selection.
        saved = await persistSave(root, raw, "json", undefined, scope);
        const imported = await attachImportedSaveToPlayer(root, data.cards, { playerId: player.id, saveId: saved.id });
        return { ...saved, localPlayerId: imported.playerId };
      } catch (error) {
        if (saved) {
          try { await deletePlayerArchives(root, [saved.id]); }
          catch { throw new Error("导入未完成，回滚失败；请检查本地存档目录，原始导入文件未改动。"); }
        }
        throw error;
      }
    }
    if (stations.players.length) throw new Error("请先选择玩家，再导入存档。");
    // Only an empty player roster needs identity evidence from the file.
    // Initialize the old catalog before adding a source card so this fallback
    // never implicitly assigns it to the active Segatools machine.
    const source = importedSaveSource(raw);
    const accessCode = importedAccessCode(source.payload), declaredScope = source.declaredScope;
    const profileFile = path.join(saveDirectory(root), "profiles.json");
    const previousProfiles = await fs.readFile(profileFile).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    let addedCard = false;
    let cardId: string | undefined;
    if (accessCode) {
      const identified = cardIdentity(accessCode);
      // Conflicting explicit identities must stay unassigned, never choose one arbitrarily.
      if (!declaredScope || declaredScope.cardId === identified) {
        cardId = identified;
        if (!data.cards.some(card => card.id === cardId)) {
          if (data.cards.length >= 100) throw new Error("最多保存 100 个卡号。");
          data.cards.push({ id: cardId, accessCode }); addedCard = true;
        }
      }
    } else if (accessCode === undefined) {
      if (declaredScope && data.cards.some(card => card.id === declaredScope.cardId)) cardId = declaredScope.cardId;
      else {
        // Older toolbox exports contain only raw responses. Match their exact endpoint/user
        // to a previously read card on this server, never by player name or userId alone.
        const owner = saveOwnerKey(source.payload), matches = new Map<string, SaveScope>();
        if (owner) for (const save of await listSaves(root)) {
          const scope = data.bindings[save.id] ?? save.scope;
          if (save.source === "direct" && validScope(scope) && (!source.declaredServerId || scope.serverId === source.declaredServerId) && (save.ownerKeys ?? [save.ownerKey]).includes(owner) && data.cards.some(card => card.id === scope.cardId)) matches.set(`${scope.serverId}:${scope.cardId}`, scope);
        }
        if (matches.size === 1) {
          const scope = [...matches.values()][0]; cardId = scope.cardId; source.declaredServerId = scope.serverId;
          source.machineKey = createHash("sha256").update(JSON.stringify({ source: source.machineKey, verifiedServer: scope.serverId })).digest("hex");
          source.playerKey = createHash("sha256").update(JSON.stringify({ source: source.playerKey, verifiedServer: scope.serverId })).digest("hex");
        }
      }
    }
    // New-player fallback uses the file's origin. Missing fields remain editable
    // source drafts; only Mod defaults to the active Segatools machine.
    let sourceServer = source.declaredServerId;
    if (!sourceServer && source.machine.dns.default) sourceServer = serverIdentity(source.machine.dns.default, source.machine.dns.AimeDB).id;
    let saved: SaveSummary | undefined;
    try {
      if (addedCard) await writeProfiles(root, data);
      saved = await persistSave(root, raw, "json", undefined, undefined, sourceServer);
      const imported = await ensureImportedPlayer(root, data.cards, { ...source, saveId: saved.id, name: summary.playerName.replace(/[\r\n\0]/g, "").trim().slice(0, 40) || "导入玩家", cardId: cardId ?? "", allowLinkedCard: accessCode !== null && (!accessCode || !declaredScope || cardIdentity(accessCode) === declaredScope.cardId) });
      const scope = imported.cardId && imported.serverId && (!saved.serverId || saved.serverId === imported.serverId) ? { cardId: imported.cardId, serverId: imported.serverId } : undefined;
      return { ...saved, localPlayerId: imported.playerId, scope };
    } catch (error) {
      // Roll back only this newly created archive/card. The source and older
      // snapshots remain untouched when a profile limit or write fails.
      try {
        if (saved) await deletePlayerArchives(root, [saved.id]);
        if (addedCard && (await fs.readFile(profileFile, "utf8")) === JSON.stringify(data)) {
          if (previousProfiles) {
            const temp = `${profileFile}.${randomUUID()}.tmp`;
            try { await fs.writeFile(temp, previousProfiles, { flag: "wx" }); await fs.rename(temp, profileFile); }
            finally { await fs.unlink(temp).catch(() => {}); }
          } else await fs.unlink(profileFile);
        }
      } catch { throw new Error("导入未完成，回滚失败；请检查本地存档目录，原始导入文件未改动。"); }
      throw error;
    }
  });
}

// Only explicit 20-digit access-code fields are card identities; game cardId/userId are not.
// null means ambiguous or incomplete evidence and disables all automatic fallbacks.
function importedAccessCode(raw: unknown): string | null | undefined {
  const codes = new Set<string>(); let invalid = false, visited = 0;
  const walk = (value: unknown, depth: number) => {
    if (++visited > 500000 || depth > 24) { invalid = true; return; }
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/rival/i.test(key)) continue;
      if (["accesscode", "aimeaccesscode", "cardnumber"].includes(key.replace(/[_\s-]/g, "").toLowerCase())) {
        try { codes.add(normalizeCard(child as string)); } catch { invalid = true; }
      } else if (child && typeof child === "object") walk(child, depth + 1);
    }
  };
  walk(raw, 0);
  return invalid || codes.size > 1 ? null : codes.size === 1 ? [...codes][0] : undefined;
}
