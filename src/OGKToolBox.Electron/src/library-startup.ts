/** Cache restoration is an optimization; a failed cache read must allow rebuilding. */
export async function loadInitialLibrary<T>(
  readCache: () => Promise<T | null>,
  rebuild: () => Promise<T>,
  isActive: () => boolean,
  forceRebuild = false
): Promise<{ value: T; cached: boolean } | null> {
  let cached: T | null = null;
  try { if (!forceRebuild) cached = await readCache(); }
  catch { /* Retry the service below and attempt to rebuild the index. */ }
  if (!isActive()) return null;
  if (cached !== null) return { value: cached, cached: true };
  const value = await rebuild();
  return isActive() ? { value, cached: false } : null;
}

/** Keep the actionable backend detail, without Electron's transport wrapper. */
export function libraryFailureMessage(error: unknown): string {
  const detail = (error && typeof error === "object" && "message" in error ? String(error.message) : String(error ?? ""))
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "")
    .replace(/\s*\(Parameter 'rootPath'\)\s*$/, "");
  if (/SQLite Error 19|UNIQUE constraint failed/i.test(detail))
    return `写入资源清单时发现重复记录。请点击“重试加载”重新扫描；如果仍然失败，请将此信息和软件版本提供给维护者。\n详细原因：${detail}`;
  if (/SQLite Error 10|disk I\/O error/i.test(detail))
    return `无法读写本地资源清单。请确认游戏所在磁盘可用，且当前账户可以读写游戏目录，然后重试。\n详细原因：${detail}`;
  if (/SQLite|database.*(?:malformed|locked)|SQLITE_/i.test(detail))
    return `本地资源清单读写失败。请关闭其他工具箱窗口后重试；如果仍然失败，请将以下信息提供给维护者。\n详细原因：${detail}`;
  return detail || "资源加载失败。请重试；如果仍然失败，请重新选择游戏目录。";
}
