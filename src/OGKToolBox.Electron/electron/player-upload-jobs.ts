import path from "node:path";

const uploads = new Set<string>();
export function beginPlayerUpload(root: string): () => void {
  const key = path.resolve(root).toLowerCase();
  if (uploads.has(key)) throw new Error("存档正在上传，请稍候。");
  uploads.add(key);
  return () => { uploads.delete(key); };
}
