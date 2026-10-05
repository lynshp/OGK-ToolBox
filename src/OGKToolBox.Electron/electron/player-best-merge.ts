import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mergeBestScores, type BestMergeMetadata } from "../src/player-best-merge";
import { validScope, type SaveScope } from "./player-identity";
import { archiveSerial, bestMergeFormat, readSave, safeServerLabel, saveDirectory, saveLimit, summarizeSave, type SaveSummary } from "./player-save";
import { saveFingerprint } from "./player-save-fingerprint";
import { playerBestPlatinumMaxima } from "./player-best-metadata";

export function validateBestMergeSelection(targetId: unknown, sourceIds: unknown): asserts sourceIds is string[] {
  if (typeof targetId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(targetId) || !Array.isArray(sourceIds) || !sourceIds.length
      || sourceIds.length > 500 || new Set(sourceIds).size !== sourceIds.length
      || sourceIds.some(id => typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id) || id === targetId)) throw new Error("请选择有效的目标存档和其他来源存档。");
}

// The caller holds the profiles queue, so the archive lock is always acquired in
// the same order as import. Re-read the scope and files under this lock.
export async function mergePlayerBestArchive(root: string, targetId: string, sourceIds: string[], scope: SaveScope,
  resolveScopedSaves: () => Promise<SaveSummary[]>): Promise<SaveSummary> {
  validateBestMergeSelection(targetId, sourceIds);
  if (!validScope(scope)) throw new Error("请选择有效的卡号和服务器。");
  return archiveSerial(root, async () => {
    const saves = await resolveScopedSaves(), target = saves.find(save => save.id === targetId);
    if (!target || target.scope?.serverId !== scope.serverId || target.scope.cardId !== scope.cardId) throw new Error("目标存档不属于当前服务器和卡号，请重新选择。");
    const sources = sourceIds.map(id => saves.find(save => save.id === id));
    if (sources.some(save => !save || !validScope(save.scope) || save.scope.cardId !== scope.cardId)) throw new Error("来源存档已变化或不属于同一卡号，请重新选择。");
    const directory = path.join(saveDirectory(root), "archives");
    for (const id of [targetId, ...sourceIds]) {
      const file = path.join(directory, `${id}.json`), stat = await fs.lstat(file).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error("存档记录已变化，请刷新后重试。");
      await readSave(file);
    }
    const allScores = [target.scores, ...sources.map(save => save!.scores)].flat();
    const maxima = await playerBestPlatinumMaxima(root, allScores);
    const result = mergeBestScores(target.scores, sources.map(save => save!.scores), maxima);
    if (!result.changed) return { ...target, unchanged: true };
    const createdAt = new Date().toISOString();
    const bestMerge: BestMergeMetadata = { version: 1, targetId, sourceIds: [...sourceIds], createdAt,
      sources: sources.map(save => ({ id: save!.id, serverId: save!.scope!.serverId, serverLabel: safeServerLabel(save!.serverLabel), updatedAt: save!.updatedAt })) };
    const warnings = [...target.warnings];
    if (allScores.some(score => score.platinumScoreStar === undefined && (score.platinumScore ?? 0) > 0 && !maxima.has(`${score.musicId}:${score.difficulty}`))) {
      warnings.push("部分白金成绩缺少本地谱面上限，未推断缺失星数；已记录的最佳星数保留。");
    }
    const raw = { format: bestMergeFormat, version: 1, scope, serverLabel: safeServerLabel(target.serverLabel), bestMerge,
      player: { playerName: target.playerName, scores: result.scores, inventory: target.inventory, collections: target.collections,
        recentPlays: target.recentPlays ?? [], recentPlaysRecorded: target.recentPlaysRecorded ?? false, warnings: [...new Set(warnings)].slice(-100) } };
    const id = `best-${randomUUID()}`, summary = summarizeSave(raw, "json", id);
    summary.scope = { ...scope }; summary.serverId = scope.serverId; summary.updatedAt = createdAt;
    summary.sequence = Math.max(0, ...saves.map(save => save.sequence ?? 0)) + 1;
    const serialized = JSON.stringify({ summary, raw, fingerprint: saveFingerprint(raw) });
    if (Buffer.byteLength(serialized) > saveLimit) throw new Error("合并存档不能超过 64 MB，请减少来源后重试。");
    const destination = path.join(directory, `${id}.json`), temporary = `${destination}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, serialized, { encoding: "utf8", flag: "wx" });
    try { await fs.rename(temporary, destination); }
    catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
    return summary;
  });
}
