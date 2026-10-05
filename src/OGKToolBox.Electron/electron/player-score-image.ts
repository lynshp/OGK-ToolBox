import fs from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";

export type PlayerScoreImageRequest = { dataUrl: string; fileName?: string };
const maxBytes = 24 * 1024 * 1024;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  return crc >>> 0;
});
function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

// Only accept the non-interlaced eight-bit RGB/RGBA PNGs emitted by our canvas.
// Inspect dimensions before inflation and cap its output to avoid oversized IPC
// payloads or decompression bombs from a compromised renderer.
export function decodePlayerScoreImage(request: unknown): Buffer {
  const input = request as Partial<PlayerScoreImageRequest> | null;
  if (!input || typeof input.dataUrl !== "string" || input.dataUrl.length > Math.ceil(maxBytes / 3) * 4 + 22
      || !input.dataUrl.startsWith("data:image/png;base64,")) throw new Error("成绩图必须是有效 PNG，且不超过 24 MB。");
  const encoded = input.dataUrl.slice(22);
  const paddingStart = encoded.endsWith("==") ? encoded.length - 2 : encoded.endsWith("=") ? encoded.length - 1 : encoded.length;
  // Avoid repeated capture groups: V8 can exhaust its regexp stack on a normal
  // multi-megabyte poster. A character scan and padding position are bounded.
  if (!encoded || encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)
      || encoded.indexOf("=") !== (paddingStart === encoded.length ? -1 : paddingStart)) throw new Error("成绩图的 PNG 编码无效。");
  const png = Buffer.from(encoded, "base64");
  if (png.length > maxBytes || png.length < 57 || !png.subarray(0, 8).equals(signature)) throw new Error("成绩图的 PNG 文件无效。");
  let offset = 8, rawBytes = 0, stride = 0, ended = false, sawData = false, dataEnded = false;
  const compressed: Buffer[] = [];
  while (offset < png.length) {
    if (offset + 12 > png.length) throw new Error("成绩图的 PNG 文件不完整。");
    const size = png.readUInt32BE(offset), end = offset + 12 + size;
    if (end > png.length) throw new Error("成绩图的 PNG 数据长度无效。");
    const type = png.toString("ascii", offset + 4, offset + 8), data = png.subarray(offset + 8, end - 4);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(png.subarray(offset + 4, end - 4)) !== png.readUInt32BE(end - 4)) throw new Error("成绩图的 PNG 校验失败。");
    if (offset === 8) {
      if (type !== "IHDR" || size !== 13) throw new Error("成绩图的 PNG 图片头无效。");
      const width = data.readUInt32BE(0), height = data.readUInt32BE(4), channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (!width || !height || width > 8192 || height > 8192 || width * height > 24_000_000 || data[8] !== 8
          || !channels || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new Error("成绩图的 PNG 尺寸或格式不受支持。");
      stride = width * channels + 1; rawBytes = stride * height;
    } else if (type === "IHDR") throw new Error("成绩图的 PNG 图片头重复。");
    if (type === "IDAT") {
      if (dataEnded) throw new Error("成绩图的 PNG 像素数据无效。");
      sawData = true; compressed.push(data);
    } else if (sawData) dataEnded = true;
    if (type === "IEND") {
      if (size || end !== png.length || !sawData) throw new Error("成绩图的 PNG 结尾无效。");
      ended = true; break;
    }
    offset = end;
  }
  if (!ended) throw new Error("成绩图的 PNG 文件不完整。");
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: rawBytes }); }
  catch { throw new Error("成绩图的 PNG 像素数据损坏。"); }
  if (raw.length !== rawBytes) throw new Error("成绩图的 PNG 像素长度无效。");
  for (let row = 0; row < raw.length; row += stride) if (raw[row] > 4) throw new Error("成绩图的 PNG 像素格式无效。");
  return png;
}

export function playerScoreImageFileName(requested?: unknown): string {
  if (typeof requested !== "string") return "ongeki-best110.png";
  let name = path.win32.basename(requested).replace(/[\x00-\x1f<>:"/\\|?*]/g, "_").replace(/\.+$/, "").trim().replace(/\.png$/i, "").replace(/[. ]+$/, "").slice(0, 100);
  if (!name || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = "ongeki-best110";
  return `${name}.png`;
}

export async function savePlayerScoreImage(request: unknown, choosePath: (fileName: string) => Promise<string | null>): Promise<boolean> {
  const png = decodePlayerScoreImage(request), fileName = playerScoreImageFileName((request as PlayerScoreImageRequest).fileName);
  const destination = await choosePath(fileName);
  if (!destination) return false;
  if (path.extname(destination).toLowerCase() !== ".png") throw new Error("请选择 .png 文件名保存成绩图。");
  await fs.writeFile(destination, png);
  return true;
}
