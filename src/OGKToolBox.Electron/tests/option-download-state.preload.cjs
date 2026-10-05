require('./character-selection.preload.cjs');
// Anonymous renderer fixture. It does not invoke production download/install IPC or access game files.
const roots = ['C:\\anonymous-options-a', 'C:\\anonymous-options-b'];
let selectedRoot = roots[0], holdReads = false, sequence = 0;
const inventory = new Map(roots.map(root => [root, [{ name: 'A001', directoryPath: `${root}\\option\\A001`, version: '1.2.0',
  isValid: true, isLoaded: true, statusText: '已加载', fileCount: 2, size: 100 }]]));
const reads = [], jobs = [], listeners = new Set();
const summary = root => ({ gameRoot: root, musicCount: 0, cardCount: 0, characterCount: 0, resourceCount: 0, diagnosticCount: 0, gameVersion: '1.50.0' });
const snapshot = root => ({ summary: summary(root), music: [], cards: [], characters: [], resources: [], diagnostics: [] });
const directory = root => ({ directoryPath: `${root}\\option`, exists: true, totalFiles: inventory.get(root).length * 2,
  totalSize: inventory.get(root).length * 100, packages: structuredClone(inventory.get(root)) });
localStorage.setItem('ogk-toolbox.game-root.v1', selectedRoot);
window.ogk.cachedScan = async root => snapshot(root);
window.ogk.scan = async root => snapshot(root);
window.ogk.librarySummary = async root => summary(root);
window.ogk.librarySection = async () => [];
window.ogk.chooseGameDirectory = async () => selectedRoot;
window.ogk.packageManifest = async () => ({ schemaVersion: 1, repository: 'anonymous', release: 'anonymous', mods: [], sourceUrl: '', checkedAt: '',
  optionPackages: ['A001', 'A002', 'A003'].map(id => ({ id, version: { major: 1, minor: 2, release: 0 }, asset: `${id}.zip`, size: 100, sha256: '0'.repeat(64) })) });
window.ogk.optionPackages = root => {
  const read = { index: reads.length, root, snapshot: directory(root), settled: false };
  reads.push(read);
  if (read.index === 0 || holdReads) return new Promise(resolve => { read.resolve = resolve; });
  read.settled = true;
  return Promise.resolve(read.snapshot);
};
window.ogk.onPackageProgress = callback => { listeners.add(callback); return () => listeners.delete(callback); };
const emit = (job, phase, message) => listeners.forEach(listener => listener({ downloadId: job.request.downloadId, kind: 'option', id: job.request.id,
  phase, received: 100, total: 100, percent: 100, speed: 0, message, error: phase === 'error' ? message : undefined }));
window.ogk.downloadPackage = request => new Promise((resolve, reject) => jobs.push({ sequence: ++sequence, request, resolve, reject, settled: false }));
function finish(sequence, phase = 'completed') {
  const job = jobs.find(item => item.sequence === sequence);
  if (!job || job.settled) throw new Error('Missing active anonymous job');
  job.settled = true;
  if (phase === 'completed') {
    const packages = inventory.get(job.request.root);
    const item = { name: job.request.id, directoryPath: `${job.request.root}\\option\\${job.request.id}`, version: '1.2.0', isValid: true,
      isLoaded: true, statusText: '已加载', fileCount: 2, size: 100 };
    const index = packages.findIndex(existing => existing.name === item.name);
    if (index < 0) packages.push(item); else packages[index] = item;
    emit(job, 'completed', '安装完成');
    job.resolve({ kind: 'option', id: item.name, path: item.directoryPath });
  } else {
    const message = phase === 'cancelled' ? '下载已取消。' : 'anonymous checksum rejected';
    emit(job, phase, message); job.reject(new Error(message));
  }
}
window.ogk.cancelPackage = downloadId => finish(jobs.find(job => job.request.downloadId === downloadId && !job.settled).sequence, 'cancelled');
window.ogk.openOptionDirectory = async () => {};
window.ogk.playerSaves = async () => ({ saves: [], capture: { enabled: false, installed: false }, profiles: { cards: [] } });
window.__optionStateTest = {
  roots,
  state: () => ({ reads: reads.map(({ index, root, settled }) => ({ index, root, settled })), jobs: jobs.map(({ sequence, request, settled }) => ({ sequence, request, settled })) }),
  hold: value => { holdReads = value; },
  releaseRead: index => { const read = reads[index]; if (!read?.resolve || read.settled) throw new Error('Missing held anonymous read'); read.settled = true; read.resolve(read.snapshot); },
  releaseAll: () => reads.forEach(read => { if (read.resolve && !read.settled) { read.settled = true; read.resolve(read.snapshot); } }),
  releaseRoot: root => reads.forEach(read => { if (read.root === root && read.resolve && !read.settled) { read.settled = true; read.resolve(read.snapshot); } }),
  finish,
  selectRoot: index => { selectedRoot = roots[index]; },
  reset: () => { inventory.set(selectedRoot, inventory.get(selectedRoot).filter(item => item.name === 'A001')); },
  duplicate: () => { const base = inventory.get(selectedRoot)[0]; inventory.set(selectedRoot, [base, { ...base, directoryPath: `${selectedRoot}\\mu3_Data\\StreamingAssets\\GameData\\A001`, version: '1.1.0', fileCount: 27 }]); }
};
