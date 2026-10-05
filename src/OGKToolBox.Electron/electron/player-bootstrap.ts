import { cardIdentity, serverIdentity } from "./player-identity";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createCipheriv, createDecipheriv, randomInt } from "node:crypto";
import { deflateSync, inflateSync, gunzipSync } from "node:zlib";
import { refreshFromRequests, readGameApi } from "./player-capture";
import { readApis, type CaptureEvent } from "./player-save";
export type PlayerConnectionInput = { server: string; keychip: string; accessCode: string; version: string; aimeServer?: string };

const agent = "OGKToolBox/1.0";
// Protocol framing, not a user's credential. See game-capture/README.md for protocol references.
const aimeTransportKey = Buffer.from("Copyright(C)SEGA", "ascii");
const itemKinds = [2, 3, 4, 8, 9, 11, 12, 13, 14, 15, 16, 17, 19, 20];
// Public Segatools default, not a player's credential. Nageki does not require an issued keychip.
// https://github.com/djhackersdev/segatools/blob/master/platform/config.c (nusec_config_load)
const segatoolsDefaultKeychip = "A69E-01A88888888";

function serverUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value.includes("://") ? value : `http://${value}`); }
  catch { throw new Error("服务器地址无效，请检查 segatools.ini 中的 DNS 配置。"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("服务器地址应为主机名或 HTTP(S) 根地址，不能包含账号、路径或查询参数。");
  return url;
}
export function validatePlayerConnection(input: PlayerConnectionInput) {
  if (!input || typeof input !== "object" || [input.server, input.keychip, input.accessCode, input.version].some(value => typeof value !== "string") || (input.aimeServer !== undefined && typeof input.aimeServer !== "string")) throw new Error("连接配置格式无效。");
  const server = serverUrl(input.server.trim());
  const configuredKeychip = input.keychip.trim().toUpperCase();
  const keychip = !configuredKeychip && server.hostname.replace(/\.$/, "") === "nageki-net.com" ? segatoolsDefaultKeychip : configuredKeychip;
  if (!/^(?:[A-Z0-9]{4}-[A-Z0-9]{11}|[A-Z0-9]{15}|[A-Z0-9]{11})$/.test(keychip)) throw new Error("Keychip 格式无效，请检查 segatools.ini 的 [keychip] id。");
  const accessCode = input.accessCode.replace(/[\s-]/g, "");
  if (!/^\d{20}$/.test(accessCode)) throw new Error("卡号应为 20 位数字的 Aime Access Code。");
  const version = input.version.trim();
  if (!/^1\.\d{2}$/.test(version)) throw new Error("游戏版本格式应为 1.xx，例如 1.50。");
  const aime = input.aimeServer?.trim() ? serverUrl(input.aimeServer.trim()) : undefined;
  return { server, keychipShort: keychip.replace("-", "").slice(0, 11), accessCode, version, aimeHost: (aime?.hostname ?? server.hostname).replace(/^\[|\]$/g, ""), aimePort: aime?.port ? Number(aime.port) : 22345 };
}

export async function playerConnectionDefaults(root: string): Promise<PlayerConnectionInput> {
  const file = path.join(root, "segatools.ini");
  let ini: string;
  try {
    if ((await fs.stat(file)).size > 1024 * 1024) throw new Error("oversized");
    ini = (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "");
  } catch { throw new Error("无法读取 segatools.ini，请检查所选游戏目录中的配置文件（最大 1 MB）。"); }
  const values = new Map<string, string>(); let section = "";
  for (const line of ini.split(/\r?\n/)) {
    const text = line.trim(); if (!text || /^[;#]/.test(text)) continue;
    const heading = text.match(/^\[([^\]]+)\]/);
    if (heading) { section = heading[1].trim().toLowerCase(); continue; }
    const entry = text.match(/^([^=]+)=(.*)$/);
    if (entry) values.set(`${section}.${entry[1].trim().toLowerCase()}`, entry[2].trim().replace(/^"(.*)"$/, "$1"));
  }
  let accessCode = "";
  const configured = values.get("aime.aimepath") || "DEVICE/aime.txt";
  const cardPath = path.resolve(root, configured.replace(/[\\/]/g, path.sep));
  try {
    if ((await fs.stat(cardPath)).size <= 4096) {
      const card = (await fs.readFile(cardPath, "utf8")).replace(/^\uFEFF/, "").trim();
      if (/^\d{20}$/.test(card)) accessCode = card;
    }
  } catch { /* A physical card or absent file can be entered by the user. */ }
  return { server: values.get("dns.default") ?? "", keychip: values.get("keychip.id") ?? "", accessCode, version: "1.50", aimeServer: values.get("dns.aimedb") ?? "" };
}

function postPowerOn(url: URL, body: Buffer, signal?: AbortSignal, omitUserAgent = false): Promise<{ body: Buffer; dfi: boolean }> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(url, { method: "POST", signal, headers: { ...(omitUserAgent ? {} : { "User-Agent": agent }), "Content-Type": "application/x-www-form-urlencoded", "Pragma": "DFI", "Content-Length": body.length, "Connection": "close" } }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`服务器地址发现返回 HTTP ${response.statusCode}，请检查服务器和 Keychip。`)); return; }
      const chunks: Buffer[] = []; let length = 0;
      response.on("data", (chunk: Buffer) => { length += chunk.length; if (length > 65536) { response.destroy(new Error("地址发现响应过大。")); return; } chunks.push(chunk); });
      response.on("error", () => reject(new Error("地址发现响应中断。")));
      response.on("end", () => {
        try {
          let bytes = Buffer.concat(chunks);
          if (response.headers["content-encoding"] === "deflate") bytes = inflateSync(bytes, { maxOutputLength: 65536 });
          else if (response.headers["content-encoding"] === "gzip") bytes = gunzipSync(bytes, { maxOutputLength: 65536 });
          resolve({ body: bytes, dfi: response.headers.pragma === "DFI" });
        } catch { reject(new Error("地址发现响应无法解码。")); }
      });
    });
    const timeout = setTimeout(() => req.destroy(new Error("timeout")), 15000);
    req.on("close", () => clearTimeout(timeout));
    req.on("error", () => reject(new Error(signal?.aborted ? "已取消获取，原存档保留。" : "无法连接地址发现服务，请检查服务器地址和网络。")));
    req.end(body);
  });
}
export async function discoverPlayerServer(input: PlayerConnectionInput, signal?: AbortSignal, policy?: { omitUserAgent?: boolean }) {
  if (signal?.aborted) throw new Error("已取消获取，原存档保留。");
  const config = validatePlayerConnection(input);
  const fields = new URLSearchParams({ game_id: "SDDT", ver: config.version, serial: config.keychipShort, ip: "127.0.0.1", firm_ver: "60001", boot_ver: "0000", encode: "UTF-8", format_ver: "3", hops: "1", token: String(randomInt(0, 2147483647)) });
  const body = Buffer.from(deflateSync(Buffer.from(fields.toString())).toString("base64"));
  const result = await postPowerOn(new URL("/sys/servlet/PowerOn", config.server), body, signal, policy?.omitUserAgent === true);
  let params: URLSearchParams;
  try {
    const decoded = result.dfi ? inflateSync(Buffer.from(result.body.toString("utf8"), "base64"), { maxOutputLength: 65536 }) : result.body;
    params = new URLSearchParams(decoded.toString("utf8").trim());
  } catch { throw new Error("地址发现响应无法解析，请确认服务器兼容 ALL.Net。"); }
  if (params.get("stat") !== "1" || !params.get("uri")) throw new Error("服务器未返回可用游戏地址，请检查自己的 Keychip、服务器和游戏版本。");
  let api: URL;
  try { api = new URL(params.get("uri")!); } catch { throw new Error("服务器返回的游戏地址无效。"); }
  if (!["http:", "https:"].includes(api.protocol) || api.username || api.password || api.search || api.hash) throw new Error("服务器返回了不支持的游戏地址。");
  if (!api.pathname.endsWith("/")) api.pathname += "/";
  const place = Number(params.get("place_id") ?? "0");
  const region = params.get("region0"), regionId = region !== null && /^\d+$/.test(region) ? Number(region) : undefined;
  return { baseUrl: api.href, placeId: Number.isSafeInteger(place) && place >= 0 && place <= 0xffffffff ? place : 0,
    ...(params.has("name") ? { placeName: params.get("name")! } : {}),
    ...(params.has("region_name0") ? { regionName: params.get("region_name0")! } : {}),
    ...(regionId !== undefined && Number.isSafeInteger(regionId) && regionId <= 2147483647 ? { regionId } : {}) };
}

function aimeCrypt(bytes: Buffer, encrypt: boolean) {
  const cipher = encrypt ? createCipheriv("aes-128-ecb", aimeTransportKey, null) : createDecipheriv("aes-128-ecb", aimeTransportKey, null);
  cipher.setAutoPadding(false); return Buffer.concat([cipher.update(bytes), cipher.final()]);
}
export function createCardLookup(input: PlayerConnectionInput, placeId: number) {
  const config = validatePlayerConnection(input), bytes = Buffer.alloc(48);
  bytes.writeUInt16LE(0xa13e, 0); bytes.writeUInt16LE(0x3087, 2); bytes.writeUInt16LE(0x0f, 4); bytes.writeUInt16LE(bytes.length, 6);
  bytes.write("SDDT", 10, "ascii"); bytes.writeUInt32LE(placeId, 16); bytes.write(config.keychipShort, 20, "ascii");
  Buffer.from(config.accessCode, "hex").copy(bytes, 32);
  return aimeCrypt(bytes, true);
}
export function parseCardLookup(bytes: Buffer): number {
  if (bytes.length < 48 || bytes.length % 16 !== 0) throw new Error("读卡服务器返回了不完整响应。");
  const data = aimeCrypt(bytes, false);
  if (data.readUInt16LE(0) !== 0xa13e || data.readUInt16LE(4) !== 0x10 || data.readUInt16LE(6) !== data.length || data.readUInt16LE(8) !== 1) throw new Error("读卡服务器未接受查询，请检查 Keychip 和卡号。");
  const userId = data.readUInt32LE(32);
  if (userId === 0 || userId === 0xffffffff) throw new Error("该卡号在此服务器尚未注册，请先确认卡号和服务器。工具箱不会自动注册新卡。");
  return userId;
}
export async function lookupPlayerCard(input: PlayerConnectionInput, placeId: number, signal?: AbortSignal): Promise<number> {
  const config = validatePlayerConnection(input), packet = createCardLookup(input, placeId);
  if (signal?.aborted) throw new Error("已取消获取，原存档保留。");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: config.aimeHost, port: config.aimePort });
    let bytes = Buffer.alloc(0), expected = 0, settled = false;
    const finish = (error?: Error, userId?: number) => {
      if (settled) return; settled = true; clearTimeout(timeout); signal?.removeEventListener("abort", cancel); socket.destroy();
      if (error) reject(error); else resolve(userId!);
    };
    const cancel = () => finish(new Error("已取消获取，原存档保留。"));
    const timeout = setTimeout(() => finish(new Error("读卡查询超时，请检查读卡服务器、22345 端口和 Keychip。")), 15000);
    signal?.addEventListener("abort", cancel, { once: true });
    socket.on("connect", () => socket.write(packet));
    socket.on("error", () => finish(new Error("无法连接读卡服务器，请检查地址和端口。")));
    socket.on("end", () => finish(new Error("读卡服务器未返回完整结果，请检查 Keychip 和卡号。")));
    socket.on("data", (chunk: Buffer) => {
      try {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 4096) throw new Error("读卡响应过大。");
        if (!expected && bytes.length >= 16) {
          const header = aimeCrypt(bytes.subarray(0, 16), false); expected = header.readUInt16LE(6);
          if (header.readUInt16LE(0) !== 0xa13e || expected < 48 || expected > 4096 || expected % 16) throw new Error("读卡服务器返回了不支持的协议。");
        }
        if (expected && bytes.length >= expected) {
          if (bytes.length !== expected) throw new Error("读卡响应长度无效。");
          finish(undefined, parseCardLookup(bytes));
        }
      } catch (error) { finish(error as Error); }
    });
  });
}

export function playerReadRequests(baseUrl: string, userId: number, userAgent?: (api: string, userId: number) => string): CaptureEvent[] {
  // Ordinary independent reads retain their compatible adapter. Explicit best
  // synchronization passes the installed game's identifier for every API.
  return [...readApis.flatMap(api => (api === "GetUserItemApi" ? itemKinds : [0]).map(kind => ({
    api, at: new Date().toISOString(), response: {},
    request: { userId, ...(["GetUserDataApi", "GetUserOptionApi"].includes(api) ? {} : { nextIndex: kind * 10000000000, maxCount: 100 }) },
    connection: { baseUrl, encryptVersion: 0, userAgent: userAgent?.(api, userId) ?? agent }
  }))), { api: "GetUserActivityApi", at: new Date().toISOString(), response: {}, request: { userId, kind: 2 }, connection: { baseUrl, encryptVersion: 0, userAgent: userAgent?.("GetUserActivityApi", userId) ?? agent } }];
}
export async function fetchPlayerFromConfiguration(root: string, input: PlayerConnectionInput, signal?: AbortSignal, services = { discover: discoverPlayerServer, lookup: lookupPlayerCard, read: readGameApi }) {
  validatePlayerConnection(input);
  const discovered = await services.discover(input, signal);
  const userId = await services.lookup(input, discovered.placeId, signal);
  const server = serverIdentity(input.server, input.aimeServer);
  return refreshFromRequests(root, playerReadRequests(discovered.baseUrl, userId), signal, services.read, undefined, { serverId: server.id, cardId: cardIdentity(input.accessCode) });
}
