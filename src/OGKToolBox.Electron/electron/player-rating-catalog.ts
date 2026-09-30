import fs from "node:fs/promises";
import path from "node:path";
import { compatibleGameDataPaths, directories, readXml, textContent } from "./player-item-catalog";

export type RatingMetadata = { isNew?: boolean; isBonus: boolean; charts: { difficulty: number; constant: number; platinumMax?: number }[] };
const block = (xml: string, key: string) => xml.match(new RegExp(`<${key}\\b[^>]*>([\\s\\S]*?)</${key}>`))?.[1] ?? "";
const integer = (xml: string, key: string) => { const text = block(xml, key).trim(); return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : undefined; };

async function platinumMax(directory: string, relative: string) {
  if (!relative || path.isAbsolute(relative)) return undefined;
  const file = path.resolve(directory, relative), rel = path.relative(directory, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  const handle = await fs.open(file, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const buffer = Buffer.alloc(16384), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead).toString("utf8").split(/\[HEADER\]/i)[1]?.split(/\[[A-Z_]+\]/)[0];
    const total = header?.match(/^T_TOTAL[\t ]+(\d+)[\t ]*\r?$/m)?.[1];
    // The game uses totalNotesNum * 2, not bell count or the player's best platinum score.
    return total !== undefined && Number.isSafeInteger(Number(total) * 2) ? Number(total) * 2 : undefined;
  } catch { return undefined; }
  finally { await handle.close().catch(() => undefined); }
}

// Read alongside the indexed library so a rescan refreshes both sets of metadata.
export async function playerRatingCatalog(root: string, items: { numericId: number; packageId: string }[], signal?: AbortSignal) {
  const { paths, baseVersion } = await compatibleGameDataPaths(root);
  const versions = new Map<number, string>(), result = new Map<number, RatingMetadata>();
  for (const directory of paths) {
    signal?.throwIfAborted();
    const parent = path.join(directory, "version");
    for (const entry of await directories(parent)) {
      const xml = await readXml(path.join(parent, entry.name, "Version.xml"));
      const id = integer(block(xml, "Name"), "id"), major = integer(xml, "Major"), minor = integer(xml, "Minor");
      if (id !== undefined && major !== undefined && minor !== undefined) versions.set(id, `${major}.${minor}`);
    }
  }
  for (const directory of paths) {
    const wanted = new Set(items.filter(item => item.packageId.toUpperCase() === path.basename(directory).toUpperCase()).map(item => Number(item.numericId)));
    if (!wanted.size) continue;
    const parent = path.join(directory, "music"), entries = await directories(parent);
    for (let offset = 0; offset < entries.length; offset += 24) {
      signal?.throwIfAborted();
      await Promise.all(entries.slice(offset, offset + 24).map(async entry => {
        const folder = path.join(parent, entry.name), xml = await readXml(path.join(folder, "Music.xml"));
        const id = integer(block(xml, "Name"), "id"), versionId = integer(block(xml, "VersionID"), "id");
        const bonus = block(xml, "IsBonusTrack").trim().toLowerCase();
        if (id === undefined || !wanted.has(id) || !["true", "false"].includes(bonus)) return;
        const songVersion = versionId === undefined ? undefined : versions.get(versionId);
        const chartBlocks = [...xml.matchAll(/<FumenData>\s*(<FumenConstIntegerPart>[\s\S]*?)<\/FumenData>/g)];
        const charts = await Promise.all(chartBlocks.slice(0, 5).map(async ([, data], difficulty) => {
          const whole = integer(data, "FumenConstIntegerPart"), fraction = integer(data, "FumenConstFractionalPart");
          const constant = whole === undefined || fraction === undefined ? NaN : Math.fround(Math.fround(whole) + Math.fround(Math.fround(fraction) / 100));
          return { difficulty, constant, platinumMax: await platinumMax(folder, textContent(block(block(data, "FumenFile"), "path"))) };
        }));
        result.set(id, { isNew: songVersion && baseVersion !== "0.0" ? songVersion === baseVersion : undefined, isBonus: bonus === "true", charts: charts.filter(chart => Number.isFinite(chart.constant)) });
      }));
    }
  }
  return result;
}
