require('./character-selection.preload.cjs');
// Isolated renderer bridge. Anonymous profiles only; no production IPC, game,
// INI, card files, game processes or remote servers are accessed.
const roots = ['C:\\anonymous-machine-a', 'C:\\anonymous-machine-b'];
let selectedRoot = roots[0], running = false, holdReads = false, holdSaves = false, holdCards = false, revision = 0;
const copy = value => structuredClone(value), operations = [], reads = [], saves = [], cardCreations = [];
const aimeEnabled = new Map(roots.map(root => [root, '1']));
const values = (host, id, enabled) => ({ dns: { default: host, AimeDB: '', replaceHost: '0', unknownSetting: '保留参数' }, netenv: { enable: enabled }, keychip: { id, subnet: '192.168.100.0' } });
const machine = (id, name, configuration) => ({ id, name, values: configuration, server: { id: configuration.dns.default, label: configuration.dns.default }, keychipHint: configuration.keychip.id ? '•••• ' + configuration.keychip.id.slice(-4) : '未设置' });
const states = new Map(roots.map((root, index) => [root, { machines: [
  machine(`machine-${index}-a`, `主机台 ${index + 1}`, values('ea.naominet.live', 'A69EANON000001', '1')),
  machine(`machine-${index}-b`, `备用机台 ${index + 1}`, values('aqua.naominet.live', 'A69EANON000002', '0'))
], activeMachineId: `machine-${index}-a`, cards: [{ id: 'card-a', accessCode: '01234567890123456789' }, { id: 'card-b', accessCode: '98765432109876543210' }],
  virtualCard: { path: 'DEVICE/aime.txt', cardId: 'card-a', accessCode: '01234567890123456789' }, configurationError: '' }]));
const initialMachines = new Map([...states].map(([root, state]) => [root, copy(state.machines)]));
const references = new Set(roots.map((root, index) => `${root}:machine-${index}-b`));
const summary = root => ({ gameRoot: root, musicCount: 0, cardCount: 0, characterCount: 0, resourceCount: 0, diagnosticCount: 0, gameVersion: '1.50.0' });
const scan = root => ({ summary: summary(root), music: [], cards: [], characters: [], resources: [], diagnostics: [] });
const configuration = root => {
  const state = states.get(root), active = state.machines.find(machine => machine.id === state.activeMachineId);
  const data = { vfs: { amfs: 'amfs', option: 'option', appdata: 'appdata' }, ...active.values, aime: { enable: aimeEnabled.get(root), aimePath: state.virtualCard.path, aimeGen: '0', scan: '0x0D' }, io4: { enable: '1', keyboard: '1' }, mu3io: { path: '' } };
  return { diagnostics: [], mods: [], files: [{ kind: 'SegaTools', exists: true, contentHash: `anonymous-${root}-${revision}`, entries: Object.entries(data).flatMap(([section, fields]) => Object.entries(fields).map(([key, value], index) => ({
    section, key, value, isKnown: true, isPresent: true, locator: section + ':' + key, lineNumber: index + 1,
    valueKind: ['enable', 'keyboard', 'aimeGen', 'replaceHost'].includes(key) ? 'Boolean' : 'String', isSensitive: section === 'keychip' && key === 'id', displayValue: '•••• ' + value.slice(-4)
  }))) }] };
};
localStorage.setItem('ogk-toolbox.game-root.v1', selectedRoot);
Object.assign(window.ogk, {
  cachedScan: async root => scan(root), scan: async root => scan(root), librarySummary: async root => summary(root), librarySection: async () => [],
  chooseGameDirectory: async () => selectedRoot, inspectConfiguration: async root => configuration(root), backupSegatools: async () => [{ name: 'anonymous-backup', createdAt: '2026-10-01T00:00:00Z' }], segatoolsBackups: async () => [{ name: 'anonymous-backup', createdAt: '2026-10-01T00:00:00Z' }],
  restoreSegatoolsBackup: async request => { if (running) throw new Error('游戏正在运行，不能恢复配置。'); operations.push({ kind: 'restore', root: request.gameRoot }); revision++; },
  segatoolsDlls: async root => ({ directory: root, dlls: [] }), gameRunningProcesses: async () => running ? ['mu3'] : [], stopGameProcesses: async () => { running = false; },
  machineProfiles: root => {
    const read = { index: reads.length, root, result: copy(states.get(root)), settled: false }; reads.push(read);
    if (holdReads) return new Promise(resolve => { read.resolve = resolve; });
    read.settled = true; return Promise.resolve(read.result);
  },
  saveMachineProfile: (root, request) => {
    const run = () => {
      const state = states.get(root), current = request.id && state.machines.find(machine => machine.id === request.id);
      if (running && current?.id === state.activeMachineId) throw new Error('游戏正在运行，不能写入配置。');
      if (!request.name.trim()) throw new Error('机台名称不能为空。');
      const saved = machine(request.id || `new-${state.machines.length}`, request.name.trim(), copy(request.values));
      if (current) state.machines[state.machines.indexOf(current)] = saved; else state.machines.push(saved);
      const applied = saved.id === state.activeMachineId; if (applied) revision++;
      operations.push({ kind: 'save', root, id: saved.id, applied, values: copy(request.values) }); return copy(saved);
    };
    if (holdSaves) return new Promise((resolve, reject) => saves.push({ run, resolve, reject, settled: false }));
    return Promise.resolve().then(run);
  },
  activateMachineProfile: async (root, id) => { if (running) throw new Error('游戏正在运行，不能写入配置。'); states.get(root).activeMachineId = id; revision++; operations.push({ kind: 'activate', root, id }); },
  deleteMachineProfile: async (root, id) => {
    const state = states.get(root);
    if (!state.machines.some(machine => machine.id === id)) throw new Error('机台不存在。');
    if (state.machines.length === 1) throw new Error('至少保留一个机台。');
    if (state.activeMachineId === id) throw new Error('请先将另一机台设为当前。');
    if (references.has(`${root}:${id}`)) throw new Error('请先修改使用此机台的玩家。');
    state.machines = state.machines.filter(machine => machine.id !== id); operations.push({ kind: 'delete', root, id });
  },
  addPlayerCard: (root, code) => {
    const run = () => {
      operations.push({ kind: 'add-card', root });
      const cards = states.get(root).cards, found = cards.find(card => card.accessCode === code);
      if (found) return found.id;
      if (!/^\d{20}$/.test(code)) throw new Error('卡号必须为 20 位数字。');
      const id = `card-${cards.length}`; cards.push({ id, accessCode: code }); return id;
    };
    if (holdCards) return new Promise((resolve, reject) => cardCreations.push({ run, resolve, reject, settled: false }));
    return Promise.resolve().then(run);
  },
  setVirtualPlayerCard: async (root, cardId) => {
    if (running) throw new Error('游戏正在运行，不能写入虚拟卡号。');
    const state = states.get(root), card = state.cards.find(card => card.id === cardId); if (!card) throw new Error('卡号不存在。');
    state.virtualCard = { path: state.virtualCard.path || 'DEVICE/aime.txt', cardId, accessCode: card.accessCode }; revision++; operations.push({ kind: 'virtual-card', root, cardId });
  },
  playerSaves: async root => {
    const state = states.get(root); return { saves: [], capture: { enabled: false, installed: false, status: '', sessions: 0, canRefresh: false }, profiles: {
      cards: copy(state.cards), defaultCardId: state.virtualCard.cardId, machines: copy(state.machines), activeMachineId: state.activeMachineId, server: state.machines[0].server,
      players: [{ id: 'player-a', name: '匿名玩家', machineId: state.machines[1].id, cardId: 'card-a' }], selectedPlayerId: 'player-a', configurationError: ''
    } };
  },
  cancelPlayerRefresh() {}, selectPlayerProfile: async () => {},
  previewConfiguration: async request => ({ canSave: true, ...request }), saveConfiguration: async request => {
    if (running) throw new Error('游戏正在运行，不能保存配置。');
    for (const edit of request.edits) if (edit.section === 'aime' && edit.key === 'enable') aimeEnabled.set(request.gameRoot, edit.newValue);
    revision++;
  }
});
window.__machineUi = {
  roots, state: () => ({ operations: copy(operations), current: copy(states.get(selectedRoot)), reads: reads.map(({ index, root, settled }) => ({ index, root, settled })) }),
  running: value => { running = value; }, holdReads: value => { holdReads = value; }, holdSaves: value => { holdSaves = value; }, holdCards: value => { holdCards = value; }, selectRoot: index => { selectedRoot = roots[index]; },
  releaseReads: root => reads.forEach(read => { if (!read.settled && (!root || read.root === root)) { read.settled = true; read.resolve(read.result); } }),
  releaseSaves: () => saves.forEach(save => { if (!save.settled) { save.settled = true; try { save.resolve(save.run()); } catch (error) { save.reject(error); } } }),
  releaseCards: () => cardCreations.forEach(card => { if (!card.settled) { card.settled = true; try { card.resolve(card.run()); } catch (error) { card.reject(error); } } }),
  machineCount: count => {
    const state = states.get(selectedRoot), baseline = copy(initialMachines.get(selectedRoot));
    state.machines = count < 3 ? baseline.slice(0, count) : [...baseline, ...Array.from({ length: count - 2 }, (_, index) => machine(index === 0 ? 'count-third' : `count-extra-${index + 3}`, `匿名扩展机台 ${index + 3}`, copy(baseline[0].values)))];
    state.activeMachineId = state.machines[0].id;
  },
  clearReferences: () => { references.clear(); }
};
