import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { saveDirectory } from "./player-save";
import { playerUploadPolicyForServer } from "../src/player-upload-policy";
import { validatePlayerConnection } from "./player-bootstrap";
import type { PlayerSaveEditorPatch, PlayerSaveEditorState, PendingPlayerEdit } from "../src/player-save-editor-models";

type Identity = { server: string; accessCode: string; keychip: string };
export async function playerEditModEnabled(root: string): Promise<boolean> {
  const files = [path.join(saveDirectory(root), "capture.enabled"), path.join(root, "BepInEx", "plugins", "OGKToolBox.PlayerCapture.dll")];
  return (await Promise.all(files.map(file => fs.stat(file).then(stat => stat.isFile(), () => false)))).every(Boolean);
}
async function requirePlayerEditMod(root: string) {
  if (!await playerEditModEnabled(root)) throw Error("请先在自动读取中启用 Mod，再保存改动；也可以选择仅保存存档。");
}
function identity(value: Identity) {
  const config = validatePlayerConnection({ ...value, version: "1.50" });
  const host = config.server.hostname.toLowerCase().replace(/\.$/, "") + (config.server.port ? `:${config.server.port}` : "");
  return { host, accessCode: config.accessCode, clientId: config.keychipShort };
}
function location(root: string, value: Identity) {
  const owner = identity(value), key = createHash("sha256").update(`${owner.host}\n${owner.accessCode}\n${owner.clientId}`).digest("hex");
  return { owner, directory: path.join(saveDirectory(root), "edits"), key };
}
export async function pendingPlayerEdit(root: string, value: Identity): Promise<PendingPlayerEdit | undefined> {
  // Offline archive editing remains available without a configured cabinet.
  try { identity(value); } catch { return undefined; }
  const { directory, key } = location(root, value);
  for (const status of ["active", "pending", "complete"] as const) {
    const file = path.join(directory, `${key}.${status}.json`), stat = await fs.lstat(file).catch(() => undefined);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error("待应用改动文件无效。");
    const job = JSON.parse(await fs.readFile(file, "utf8"));
    if (job.version !== 1 || typeof job.id !== "string" || !Array.isArray(job.resources) || !Array.isArray(job.scores)) throw Error("待应用改动文件无效。");
    const receipt = await fs.readFile(path.join(directory, `${key}.error.json`), "utf8").then(text => JSON.parse(text)).catch(() => undefined);
    const issue = status !== "complete" && receipt?.id === job.id && ["incompatible", "interrupted"].includes(receipt.issue) ? receipt.issue : undefined;
    return { id: job.id, status, issue, resources: job.resources.map(({ key, value }: any) => ({ key, value })),
      scores: job.scores.map(({ platinumMax, ...score }: any) => score) };
  }
}
/** Immutable commands are claimed by an atomic move in the game. Never alter an archive here. */
export async function queuePlayerGameEdit(root: string, value: Identity, patch: PlayerSaveEditorPatch, state: PlayerSaveEditorState): Promise<PendingPlayerEdit> {
  await requirePlayerEditMod(root);
  const { owner, directory, key } = location(root, value), existing = await pendingPlayerEdit(root, value);
  if (existing && existing.status !== "complete") throw Error(existing.status === "pending" ? "已有待应用改动，请先取消或进入游戏完成保存。" : "改动已由游戏领取，请完成游戏保存；若游戏中断，请先核对最新存档再清除待办。");
  if (patch.scores.length && playerUploadPolicyForServer(value.server).scoreUpload !== "direct") throw Error("此服务器的成绩只能保存存档，再到 NET 手动上传。");
  if (patch.resources.some(row => !/^(data:(point|jewelCount|medalCount|shizukuCount)|item:(11|12|13|14|20):\d+|(chapter|story):\d+)$/.test(row.key))) throw Error("此资源暂不支持游戏内应用，请使用仅保存存档。");
  if (patch.resources.some(row => row.key.startsWith("item:20:") && row.value !== 1)) throw Error("解锁道具只能增加持有。");
  const constraints = new Map(state.scoreConstraints.map(row => [`${row.musicId}:${row.difficulty}`, row]));
  const job = { version: 1, id: randomUUID(), ...owner, createdAt: new Date().toISOString(), resources: patch.resources,
    scores: patch.scores.map(row => ({ ...row, fields: row.fields ?? ["techScore", "platinumScore", "battleScore", "fullCombo", "fullBell", "allBreak", ...["playCount", "maxComboCount", "maxOverKill", "maxTeamOverKill", "battleScoreRank", "clearStatus"].filter(field => (row as any)[field] !== undefined)], platinumMax: constraints.get(`${row.musicId}:${row.difficulty}`)?.platinumMax ?? -1 })) };
  const serialized = JSON.stringify(job);
  if (Buffer.byteLength(serialized) > 1024 * 1024) throw Error("待应用改动过多，请分次保存。");
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `${job.id}.tmp`), target = path.join(directory, `${key}.pending.json`);
  try {
    const handle = await fs.open(temporary, "wx");
    try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
    // link is an atomic publish without overwrite, including another process's pending command.
    await requirePlayerEditMod(root);
    await fs.link(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
  return { id: job.id, status: "pending", ...patch };
}
export async function cancelPlayerGameEdit(root: string, value: Identity, id: string, discardActive = false) {
  const { directory, key } = location(root, value);
  const pending = await pendingPlayerEdit(root, value);
  if (!pending || pending.id !== id || pending.status === "complete") throw Error("待办已变化，请重新打开编辑器。");
  if (pending.status === "active" && !discardActive) throw Error("游戏已领取改动，不能撤回正在使用的数据。");
  // The caller permits discarding an active command only while the game is stopped.
  await fs.rename(path.join(directory, `${key}.${pending.status}.json`), path.join(directory, `${key}.${id}.cancelled.json`));
}
