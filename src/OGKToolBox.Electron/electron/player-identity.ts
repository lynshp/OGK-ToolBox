import { createHash } from "node:crypto";

export type SaveScope = { serverId: string; cardId: string };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function normalizeCard(value: string) {
  if (typeof value !== "string") throw new Error("卡号格式无效。");
  const card = value.replace(/[\s-]/g, "");
  if (!/^\d{20}$/.test(card)) throw new Error("卡号应为 20 位数字。");
  return card;
}
export const cardIdentity = (value: string) => digest(`card:${normalizeCard(value)}`);
export function serverIdentity(server: string, aimeServer = "") {
  const parse = (value: string) => {
    const url = new URL(value.includes("://") ? value : `http://${value}`);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    url.hostname = url.hostname.replace(/\.$/, "");
    return url;
  };
  try {
    if (!server.trim()) throw new Error();
    const url = parse(server.trim()), aime = aimeServer.trim() ? parse(aimeServer.trim()) : url;
    return { id: digest(`${url.origin}\n${aime.hostname}:${aimeServer.trim() && aime.port ? aime.port : 22345}`), label: url.host };
  } catch { throw new Error("服务器配置无效，请检查 segatools.ini。"); }
}
// Exact endpoint + player identity only. Never infer ownership from a player name or current INI.
export function saveOwnerKey(raw: any): string | undefined {
  const events = raw?.events;
  if (!Array.isArray(events) || !events.length) return undefined;
  const keys = new Set<string>();
  for (const event of events) {
    if (!event?.connection?.baseUrl || !/^\d+$/.test(String(event?.request?.userId ?? ""))) return undefined;
    try {
      const url = new URL(event.connection.baseUrl);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
      keys.add(`${url.href.replace(/\/$/, "")}\n${event.request.userId}`);
    } catch { return undefined; }
  }
  return keys.size === 1 ? digest([...keys][0]) : undefined;
}
export function validScope(value: unknown): value is SaveScope {
  const scope = value as SaveScope | undefined;
  return !!scope && /^[a-f0-9]{64}$/.test(scope.serverId) && /^[a-f0-9]{64}$/.test(scope.cardId);
}
