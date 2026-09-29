require('./character-selection.preload.cjs');
let reads = 0, scans = 0;
const gameRoot = 'C:\\fixture\\package';
localStorage.setItem('ogk-toolbox.game-root.v1', 'C:\\fixture');
const summary = { gameRoot, musicCount: 0, cardCount: 0, characterCount: 0, resourceCount: 1, diagnosticCount: 1, gameVersion: '1.50.0', lastScanAt: '2026-09-30T00:00:00Z' };
const diagnostic = { severity: 'Error', code: 'RESOURCE_DUPLICATE', message: '数据包 A000 中有重名资源“ui_jacket_000001”。已继续加载，同包内优先使用目录层级较浅的文件；层级相同时按路径名称排序选择。\n已使用：C:\\fixture\\package\\mu3_Data\\StreamingAssets\\assets\\ui_jacket_000001\n已跳过：C:\\fixture\\package\\mu3_Data\\StreamingAssets\\assets\\backup\\ui_jacket_000001\n没有删除或修改这些文件，请核对是否混入备份或重复解压的文件。', sourcePath: 'C:\\fixture\\package\\mu3_Data\\StreamingAssets\\assets\\backup\\ui_jacket_000001' };
window.ogk.cachedScan = async () => { reads++; return null; };
window.ogk.scan = async () => {
  scans++;
  if (scans === 1) throw new Error("Error invoking remote method 'library:scan': Error: SQLite Error 10: disk I/O error");
  return { summary, music: [], cards: [], characters: [], resources: [], diagnostics: [] };
};
window.ogk.librarySummary = async () => summary;
window.ogk.librarySection = async (_root, kind) => kind === 'diagnostics' ? [diagnostic] : [];
window.__libraryTest = { counts: () => ({ reads, scans }) };
