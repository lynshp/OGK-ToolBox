import { createHash } from "node:crypto";
import { serverIdentity, saveOwnerKey, validScope, type SaveScope } from "./player-identity";
import { saveFingerprint } from "./player-save-fingerprint";
import type { MachineValues } from "../src/machine-profile-models";

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const groups = { dns: ["default", "AimeDB", "replaceHost"], netenv: ["enable"], keychip: ["id", "subnet"] } as const;
function emptyMachine(): MachineValues {
  return { dns: { default: "", AimeDB: "", replaceHost: "0" }, netenv: { enable: "0" }, keychip: { id: "", subnet: "" } };
}
function snapshot(value: unknown): MachineValues {
  const fail = () => { throw new Error("存档中的机台配置无效，未导入。"); };
  if (!record(value)) return fail();
  const source = record(value.values) ? value.values : value;
  if (Object.keys(source).some(key => !(key in groups))) return fail();
  const result = emptyMachine();
  for (const [group, keys] of Object.entries(groups)) {
    const fields = source[group];
    if (!record(fields) || Object.keys(fields).length !== keys.length || Object.keys(fields).some(key => !(keys as readonly string[]).includes(key))) return fail();
    for (const key of keys) {
      const field = fields[key];
      if (typeof field !== "string" || field.length > 1024 || /[\r\n\0]/.test(field)) return fail();
      result[group as keyof MachineValues][key] = field.trim();
    }
  }
  if (!["0", "1"].includes(result.dns.replaceHost) || !["0", "1"].includes(result.netenv.enable)) return fail();
  for (const address of [result.dns.default, result.dns.AimeDB]) if (address) {
    try { serverIdentity(address); } catch { return fail(); }
  }
  if (result.keychip.id && !/^(?:[A-Z0-9]{4}-[A-Z0-9]{11}|[A-Z0-9]{15}|[A-Z0-9]{11})$/i.test(result.keychip.id)) return fail();
  if (result.keychip.subnet && (!/^192\.168\.\d{1,3}\.\d{1,3}$/.test(result.keychip.subnet) || result.keychip.subnet.split(".").some(part => Number(part) > 255))) return fail();
  return result;
}
function client(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z0-9]{11}$/i.test(value) ? value.toUpperCase() : undefined;
}
function dataRows(raw: Record<string, any>): Record<string, any>[] {
  const rows: Record<string, any>[] = record(raw.userData) ? [raw.userData] : [];
  if (Array.isArray(raw.events)) for (const event of raw.events) {
    if (record(event?.response?.userData)) rows.push(event.response.userData);
  }
  if (record(raw.player)) rows.push(raw.player);
  return rows;
}
export type ImportedSaveSource = {
  machine: MachineValues; machineComplete: boolean; machineKey: string; playerKey: string;
  declaredServerId?: string; declaredScope?: SaveScope; payload: unknown;
};

// Source evidence comes only from the file. Never fill missing fields from the active INI.
export function importedSaveSource(raw: unknown): ImportedSaveSource {
  const wrapper = record(raw) ? raw : {};
  const exported = record(wrapper.summary) && Array.isArray(wrapper.summary.scores) && (record(wrapper.raw) || Array.isArray(wrapper.raw)) ? wrapper.summary : undefined;
  const payload = exported ? wrapper.raw : raw, object = record(payload) ? payload : {};
  const declaredScope = validScope(exported?.scope) ? exported.scope : object.format === "ogk-toolbox-player-best" && validScope(object.scope) ? object.scope : undefined;
  const serverId = declaredScope?.serverId ?? exported?.serverId;
  const declaredServerId = typeof serverId === "string" && /^[a-f0-9]{64}$/.test(serverId) ? serverId : undefined;
  const snapshots = [wrapper.machine, wrapper.machineSnapshot, wrapper.identity?.machine, object.machine, object.machineSnapshot, object.identity?.machine].filter(value => value !== undefined);
  const machines = snapshots.map(snapshot);
  if (machines.some(machine => JSON.stringify(machine) !== JSON.stringify(machines[0]))) throw new Error("存档中的机台配置不一致，未导入。");
  const machine = machines[0] ?? emptyMachine(), machineComplete = !!machines.length;
  const rows = dataRows(object);
  if (!machineComplete) {
    const clients = new Set([client(object.clientId), ...rows.map(row => client(row.lastClientId))].filter((value): value is string => !!value));
    if (clients.size > 1) throw new Error("存档中的机台身份不一致，未导入。");
    machine.keychip.id = [...clients][0] ?? "";
    // Old exports retain the actual API endpoint; use only its root host as a draft.
    // A complete machine snapshot takes precedence over the discovered API endpoint.
    const servers = new Set<string>();
    if (Array.isArray(object.events)) for (const event of object.events) {
      const base = event?.connection?.baseUrl;
      if (typeof base !== "string") continue;
      try {
        const url = new URL(base);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
        servers.add(url.origin);
      } catch { throw new Error("存档中的服务器地址无效，未导入。"); }
    }
    if (!servers.size) {
      const label = exported?.serverLabel ?? object.serverLabel;
      if (typeof label === "string" && label) {
        try { servers.add(serverIdentity(label).label); } catch { throw new Error("存档中的服务器地址无效，未导入。"); }
      }
    }
    if (servers.size > 1) throw new Error("存档包含多个服务器，无法确定机台。");
    machine.dns.default = [...servers][0] ?? "";
  }
  const hasMachine = machineComplete || !!machine.dns.default || !!machine.keychip.id || !!declaredServerId;
  const machineKey = hash({ machine, declaredServerId, ...(hasMachine ? {} : { unknownExport: saveFingerprint(payload) }) });
  const databaseIdentity = rows.map(row => row.userId ?? row.id).find(value => Number.isSafeInteger(value) && value > 0 || typeof value === "string" && /^\d+$/.test(value));
  // This identity only reuses a local imported player. It never establishes an Aime card.
  const owner = saveOwnerKey(payload) ?? (databaseIdentity !== undefined ? { game: object.gameId ?? "ongeki", databaseIdentity } : { snapshot: saveFingerprint(payload) });
  const playerKey = hash({ machineKey, owner });
  return { machine, machineComplete, machineKey, playerKey, declaredServerId, declaredScope, payload };
}
