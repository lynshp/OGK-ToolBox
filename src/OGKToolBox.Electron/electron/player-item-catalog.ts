import fs from "node:fs/promises";
import path from "node:path";

// ItemType values verified against the game's metadata; IDs are scoped to the item kind.
const itemFiles: Record<number, [string, string]> = {
  2: ["nameplate", "NamePlate.xml"], 3: ["trophy", "Trophy.xml"], 4: ["limitbreak", "LimitBreakItem.xml"],
  8: ["profilevoice", "ProfileVoice.xml"], 9: ["present", "Present.xml"], 11: ["gachaticket", "GachaTicket.xml"],
  12: ["kaikaitem", "KaikaItem.xml"], 13: ["expupitem", "ExpUpItem.xml"], 14: ["intimateupitem", "IntimateUpItem.xml"],
  15: ["book", "Book.xml"], 16: ["systemvoice", "SystemVoice.xml"], 17: ["costume", "Costume.xml"],
  19: ["attachment", "Attachment.xml"], 20: ["unlockitem", "UnlockItem.xml"]
};
export const itemKey = (kind: number, id: number) => `${kind}:${id}`;
const caches = new Map<string, { expires: number; names: Promise<Map<string, string>> }>();
export async function readXml(file: string) {
  try {
    if ((await fs.stat(file)).size > 1024 * 1024) return "";
    const xml = await fs.readFile(file, "utf8");
    // Only read simple local metadata; never resolve DTDs or external entities.
    return /<!DOCTYPE|<!ENTITY/i.test(xml) ? "" : xml.replace(/<!--[\s\S]*?-->/g, "");
  } catch { return ""; }
}
export function textContent(value: string) {
  if (/^\s*<!\[CDATA\[[\s\S]*\]\]>\s*$/.test(value)) return value.trim().slice(9, -3).trim();
  if (/[<>]/.test(value)) return "";
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_entity, code: string) => {
    if (code[0] !== "#") return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[code.toLowerCase()];
    const number = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : "";
  }).trim();
}
export async function version(directory: string) {
  const xml = await readXml(path.join(directory, "DataConfig.xml")) || await readXml(path.join(directory, "dataConfig.xml"));
  const block = xml.match(/<version\b[^>]*>([\s\S]*?)<\/version>/i)?.[1] ?? "";
  const major = block.match(/<major>\s*(\d+)\s*<\/major>/)?.[1];
  const minor = block.match(/<minor>\s*(\d+)\s*<\/minor>/)?.[1];
  return major && minor ? `${Number(major)}.${Number(minor)}` : "0.0";
}
export async function directories(directory: string) {
  return (await fs.readdir(directory, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory());
}
export async function compatibleGameDataPaths(root: string) {
  const gameData = path.join(root, "mu3_Data", "StreamingAssets", "GameData");
  const base = path.join(gameData, "A000"), baseVersion = await version(base);
  const packages: { id: string; directory: string }[] = [];
  // Same ordering as DataPackageResolver: compatible packages only, option wins duplicate IDs.
  for (const parent of [path.join(root, "option"), gameData]) {
    for (const entry of await directories(parent)) {
      const id = entry.name.toUpperCase();
      if (/^A[A-Z0-9]{3}$/.test(id) && id !== "A000") packages.push({ id, directory: path.join(parent, entry.name) });
    }
  }
  packages.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const loaded = new Set<string>(), paths = [base];
  for (const item of packages) {
    if (loaded.has(item.id) || await version(item.directory) !== baseVersion) continue;
    loaded.add(item.id); paths.push(item.directory);
  }
  return { paths, baseVersion };
}
async function loadCatalog(root: string) {
  const { paths } = await compatibleGameDataPaths(root);
  const names = new Map<string, string>();
  for (const directory of paths) {
    for (const [kind, [folder, filename]] of Object.entries(itemFiles)) {
      const parent = path.join(directory, folder);
      const entries = (await directories(parent)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 20000);
      for (let offset = 0; offset < entries.length; offset += 24) {
        const xmls = await Promise.all(entries.slice(offset, offset + 24).map(entry => readXml(path.join(parent, entry.name, filename))));
        for (const xml of xmls) {
          const block = xml.match(/<Name\b[^>]*>([\s\S]*?)<\/Name>/)?.[1];
          if (!block) continue;
          const idText = block.match(/<id>\s*(\d+)\s*<\/id>/)?.[1];
          const name = textContent(block.match(/<str\b[^>]*>([\s\S]*?)<\/str>/)?.[1] ?? "").slice(0, 200);
          const id = idText === undefined ? NaN : Number(idText);
          if (Number.isSafeInteger(id) && name) names.set(itemKey(Number(kind), id), name);
        }
      }
    }
  }
  return names;
}
export function playerItemNames(root: string): Promise<Map<string, string>> {
  const key = path.resolve(root).toLowerCase(), cached = caches.get(key);
  if (cached && cached.expires > Date.now()) return cached.names;
  if (caches.size >= 4) caches.delete(caches.keys().next().value!);
  const names = loadCatalog(root);
  caches.set(key, { expires: Date.now() + 60000, names });
  return names;
}
