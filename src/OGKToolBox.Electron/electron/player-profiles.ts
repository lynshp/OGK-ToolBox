import { refreshFromGame } from "./player-capture";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { playerConnectionDefaults, fetchPlayerFromConfiguration } from "./player-bootstrap";
import { cardIdentity, normalizeCard, serverIdentity, saveOwnerKey, validScope, type SaveScope } from "./player-identity";
import { deletePlayerArchives, persistSave, listSaves, saveDirectory, summarizeSave, type SaveSummary } from "./player-save";

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
    let server: { id: string; label: string } | undefined, configurationError = "", defaultCardId = "";
    try {
      const config = await playerConnectionDefaults(root);
      if (config.accessCode) {
        defaultCardId = cardIdentity(config.accessCode);
        if (!data.cards.some(card => card.id === defaultCardId) && data.cards.length < 100) {
          data.cards.push({ id: defaultCardId, accessCode: config.accessCode }); await writeProfiles(root, data);
        }
      }
      server = serverIdentity(config.server, config.aimeServer);
    } catch (error) { configurationError = (error as Error).message; }
    return { cards: data.cards, server, defaultCardId, configurationError };
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
  const [saves, data] = await Promise.all([listSaves(root), serial(root, () => readProfiles(root))]);
  // Only successful direct reads establish an automatic endpoint/player -> card mapping.
  const owners = new Map<string, Map<string, SaveScope>>();
  for (const save of saves) if (save.ownerKey && validScope(save.scope) && save.source === "direct") {
    for (const ownerKey of save.ownerKeys ?? [save.ownerKey]) {
      const scopes = owners.get(ownerKey) ?? new Map<string, SaveScope>();
      scopes.set(`${save.scope.serverId}:${save.scope.cardId}`, save.scope); owners.set(ownerKey, scopes);
    }
  }
  return saves.map(save => {
    const matches = save.ownerKey ? owners.get(save.ownerKey) : undefined;
    const inferred = save.source !== "json" && matches?.size === 1 ? [...matches.values()][0] : undefined;
    return { ...save, scope: data.bindings[save.id] ?? (validScope(save.scope) ? save.scope : inferred) };
  });
}
export async function requirePlayerScope(root: string, cardId: string, serverId: string) {
  const config = await playerConnectionDefaults(root), server = serverIdentity(config.server, config.aimeServer);
  if (server.id !== serverId) throw new Error("服务器配置已变化，请重新选择存档后操作。");
  const data = await serial(root, () => readProfiles(root)), card = data.cards.find(card => card.id === cardId);
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

export async function deleteManagedPlayerSaves(root: string, ids: string[], scope: { serverId: string; cardId?: string } | null) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id))) throw new Error("请选择有效存档。");
  if (scope !== null && (!/^[a-f0-9]{64}$/.test(scope?.serverId) || scope.cardId !== undefined && !validScope(scope))) throw new Error("存档分组无效。");
  if (scope?.cardId) await requirePlayerScope(root, scope.cardId, scope.serverId);
  else if (scope) await requireImportServer(root, scope.serverId);
  const saves = await scopedPlayerSaves(root);
  for (const id of ids) {
    const save = saves.find(item => item.id === id);
    if (!save || (scope?.cardId ? save.scope?.serverId !== scope.serverId || save.scope.cardId !== scope.cardId : !!save.scope || (save.serverId ?? null) !== (scope?.serverId ?? null))) throw new Error("存档分组已变化，请重新选择。");
  }
  await deletePlayerArchives(root, ids);
}

async function requireImportServer(root: string, expected: string | null) {
  if (expected === null) return;
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("服务器标识无效。");
  const config = await playerConnectionDefaults(root);
  if (serverIdentity(config.server, config.aimeServer).id !== expected) throw new Error("服务器配置已变化，请重试导入。");
}
export async function importManagedPlayerSave(root: string, raw: unknown, serverId: string | null) {
  await requireImportServer(root, serverId);
  // Validate the archive before adding a newly identified card to local profiles.
  summarizeSave(raw, "json");
  const wrapper = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, any> : undefined;
  const exported = wrapper?.summary && Array.isArray(wrapper.summary.scores) && wrapper.raw && typeof wrapper.raw === "object" ? wrapper.summary as SaveSummary : undefined;
  const payload = exported ? wrapper!.raw : raw;
  const accessCode = importedAccessCode(payload);
  const exportedServer = exported?.scope?.serverId ?? exported?.serverId;
  if (serverId && exportedServer && /^[a-f0-9]{64}$/.test(exportedServer) && exportedServer !== serverId) throw new Error("存档来自其他服务器，请切换到对应服务器后导入。");
  return serial(root, async () => {
    await requireImportServer(root, serverId);
    const data = await readProfiles(root);
    let cardId: string | undefined;
    if (serverId && accessCode) {
      const identified = cardIdentity(accessCode);
      // Conflicting explicit identities must stay unassigned, never choose one arbitrarily.
      if (!validScope(exported?.scope) || exported.scope.cardId === identified) {
        cardId = identified;
        if (!data.cards.some(card => card.id === cardId)) {
          if (data.cards.length >= 100) throw new Error("最多保存 100 个卡号。");
          data.cards.push({ id: cardId, accessCode }); await writeProfiles(root, data);
        }
      }
    } else if (serverId && accessCode === undefined) {
      if (validScope(exported?.scope) && exported.scope.serverId === serverId && data.cards.some(card => card.id === exported.scope!.cardId)) cardId = exported.scope.cardId;
      else {
        // Older toolbox exports contain only raw responses. Match their exact endpoint/user
        // to a previously read card on this server, never by player name or userId alone.
        const owner = saveOwnerKey(payload), matches = new Set<string>();
        if (owner) for (const save of await listSaves(root)) {
          const scope = data.bindings[save.id] ?? save.scope;
          if (save.source === "direct" && validScope(scope) && scope.serverId === serverId && (save.ownerKeys ?? [save.ownerKey]).includes(owner) && data.cards.some(card => card.id === scope.cardId)) matches.add(scope.cardId);
        }
        if (matches.size === 1) cardId = [...matches][0];
      }
    }
    return persistSave(root, raw, "json", undefined, serverId && cardId ? { serverId, cardId } : undefined, serverId ?? undefined);
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
