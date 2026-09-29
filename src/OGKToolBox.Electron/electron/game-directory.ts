import fs from "node:fs/promises";
import path from "node:path";

const dataParts = ["mu3_Data", "StreamingAssets", "GameData", "A000"];
const assetsParts = ["mu3_Data", "StreamingAssets", "assets"];
const excluded = new Set(["mu3_data", "tools", "option", "node_modules", ".git", "$recycle.bin", "system volume information"]);

async function isDirectory(directory: string): Promise<boolean> {
  try { return (await fs.stat(directory)).isDirectory(); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

/** Look only inside the selected folder; never traverse game assets or directory links. */
export async function resolveGameDirectory(selected: string): Promise<string> {
  if (!selected?.trim()) throw new Error("请选择游戏的 package 文件夹，或包含它的上层文件夹。");
  const root = path.resolve(selected.trim());
  const candidates: string[] = [];
  const incomplete: string[] = [];
  const inaccessible: string[] = [];
  const queue = [{ directory: root, depth: 0 }];
  let limited = false;
  try {
    if (!await isDirectory(root)) throw new Error(`所选文件夹不存在或不是文件夹：\n${root}\n请确认磁盘已连接，或重新选择游戏目录。`);
    for (let i = 0; i < queue.length; i++) {
      const { directory, depth } = queue[i];
      try {
        const hasData = await isDirectory(path.join(directory, ...dataParts));
        const hasAssets = await isDirectory(path.join(directory, ...assetsParts));
        if (hasData && hasAssets) {
          if (depth === 0) return directory;
          candidates.push(directory);
          continue;
        }
        if (await isDirectory(path.join(directory, "mu3_Data"))) {
          incomplete.push(`${directory}\n缺少：${[!hasData && path.join(directory, ...dataParts), !hasAssets && path.join(directory, ...assetsParts)].filter(Boolean).join("\n")}`);
          continue;
        }
        const children = (await fs.readdir(directory, { withFileTypes: true }))
          .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !excluded.has(entry.name.toLowerCase()) && !entry.name.startsWith("."))
          .sort((a, b) => a.name.localeCompare(b.name));
        if (depth === 4) { limited ||= children.length > 0; continue; }
        for (const child of children) {
          if (queue.length >= 512) { limited = true; break; }
          queue.push({ directory: path.join(directory, child.name), depth: depth + 1 });
        }
      } catch (error) {
        inaccessible.push(`${directory}（${(error as NodeJS.ErrnoException).code ?? "无法读取"}）`);
      }
    }
  } catch (error) {
    if (!(error as NodeJS.ErrnoException).code) throw error;
    throw new Error(`无法读取所选文件夹：\n${root}\n请确认磁盘已连接且当前账户可以访问。\n详细原因：${(error as Error).message}`);
  }
  if (candidates.length > 1) throw new Error(`找到多套游戏，无法确定要使用哪一套。请直接选择其中一个 package 文件夹：\n${candidates.join("\n")}\n当前选择：${root}`);
  if (limited) throw new Error(`所选文件夹范围较大，尚未完成查找。\n当前选择：${root}\n已查找最多 4 层子文件夹、512 个文件夹。请选择更接近游戏的文件夹，或直接选择 package。`);
  if (candidates.length === 1) return candidates[0];
  throw new Error(`没有找到完整的游戏目录。\n当前选择：${root}\n${incomplete.length ? incomplete.slice(0, 3).join("\n") : `需要找到：\n${path.join(root, ...dataParts)}\n${path.join(root, ...assetsParts)}\n也已检查所选文件夹下的子文件夹。`}${inaccessible.length ? `\n以下位置无法读取：\n${inaccessible.slice(0, 3).join("\n")}` : ""}\n请选择包含 mu3_Data 的 package 文件夹，或它的上层文件夹；如果游戏文件不完整，请先恢复缺少的目录。`);
}
