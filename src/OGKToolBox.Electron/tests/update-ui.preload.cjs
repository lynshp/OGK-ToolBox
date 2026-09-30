require('./character-selection.preload.cjs');
let status = {
  packaged: true, currentVersion: '1.1.8', state: 'error', hasToken: false, source: 'auto',
  channels: { fastgithub: { state: 'failed', error: '本地代理启动失败' }, github: { state: 'reachable', latencyMs: 168 } },
  error: 'FastGithub · 校验安装包失败：sha512 checksum mismatch。可切换通道后重新检查。',
  diagnostics: ['2026-09-18T00:00:00Z FastGithub · 本地代理启动失败', '2026-09-18T00:00:01Z 原生 GitHub：更新源可达（168 ms）']
};
let listener;
const calls = [];
window.ogk.getUpdateStatus = async () => status;
window.ogk.onUpdateStatus = callback => { listener = callback; return () => { listener = undefined; }; };
window.ogk.checkForUpdate = async source => { calls.push(source); return status; };
window.__updateTest = {
  calls: () => calls,
  publish: patch => { status = { ...status, ...patch }; listener?.(status); }
};

window.ogk.setGithubSources = async (source, downloadSource) => { status = { ...status, source, downloadSource }; listener?.(status); return status; };

window.ogk.inspectHddSetup = async () => ({ bepinex: { directoryExists: true, preloaderExists: true } });
window.ogk.optionPackages = async () => ({ directoryPath: "fixture", exists: true, packages: [], totalFiles: 0, totalSize: 0 });
