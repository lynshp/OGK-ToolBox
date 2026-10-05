const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const ts = require('typescript');
const cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const m = new Module(file, module); m.filename = file; m.paths = module.paths;
  m.require = name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name);
  cache.set(file, m); m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, file);
  return m.exports;
}
const stations = load(path.join(__dirname, '../electron/machine-profiles.ts'));
const profiles = load(path.join(__dirname, '../electron/player-profiles.ts'));
const { cardIdentity, serverIdentity } = load(path.join(__dirname, '../electron/player-identity.ts'));
const { saveDirectory } = load(path.join(__dirname, '../electron/player-save.ts'));
const codes = ['12345678901234567890', '23456789012345678901'];
const cards = codes.map(accessCode => ({ id: cardIdentity(accessCode), accessCode }));
const stopped = async () => {};
const fixture = `[vfs]\r\namfs=unchanged\r\noption=Option\r\nappdata=appdata\r\n[aime]\r\naimePath=DEVICE\\selected.txt\r\nenable=1\r\n[dns]\r\ndefault=one.invalid ; keep comment\r\nAimeDB=\r\nreplaceHost=0\r\n[netenv]\r\nenable=1\r\n[keychip]\r\nid=A123-45678901234\r\nsubnet=192.168.162.0\r\n[pcbid]\r\nserialNo=DO-NOT-TOUCH\r\n`;
async function temporary(t, bytes = Buffer.from(fixture)) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ogk-stations-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('ogk-stations-')); await fsp.rm(root, { recursive: true, force: true }); });
  await fsp.writeFile(path.join(root, 'segatools.ini'), bytes);
  await fsp.mkdir(path.join(root, 'DEVICE')); await fsp.writeFile(path.join(root, 'DEVICE/selected.txt'), codes[0]);
  return root;
}
function secondValues(values) {
  return { dns: { ...values.dns, default: 'two.invalid', AimeDB: 'cards.two.invalid', replaceHost: '1' }, netenv: { enable: '0' }, keychip: { id: 'B123-45678901234', subnet: '192.168.99.0' } };
}
test('initial migration creates one station and one profile per saved card without touching game files', async t => {
  const root = await temporary(t), ini = await fsp.readFile(path.join(root, 'segatools.ini')), txt = await fsp.readFile(path.join(root, 'DEVICE/selected.txt'));
  const state = await stations.stationSnapshot(root, cards);
  assert.equal(state.machines.length, 1); assert.equal(state.players.length, 2);
  assert.equal(state.players.find(p => p.id === state.selectedPlayerId).cardId, cards[0].id);
  assert.equal(state.machines[0].server.label, 'one.invalid');
  assert.equal(state.machines[0].values.dns.default, 'one.invalid');
  assert.ok(!state.machines[0].keychipHint.includes('45678901234'));
  assert.deepEqual(await fsp.readFile(path.join(root, 'segatools.ini')), ini);
  assert.deepEqual(await fsp.readFile(path.join(root, 'DEVICE/selected.txt')), txt);
  const repeated = await stations.stationSnapshot(root, cards); assert.equal(repeated.players.length, 2); assert.equal(repeated.machines[0].id, state.machines[0].id);
});
test('inactive station and player binding choose their own server/keychip without changing game INI', async t => {
  const root = await temporary(t), initial = await stations.stationSnapshot(root, cards), baseline = await fsp.readFile(path.join(root, 'segatools.ini')), virtual = await fsp.readFile(path.join(root, 'DEVICE/selected.txt'));
  const machine = await stations.saveMachineProfile(root, cards, { name: '机台 2', values: secondValues(initial.machines[0].values) }, () => { throw Error('must not stop game for local draft'); });
  const id = await stations.savePlayerProfile(root, cards, { name: '跨服玩家', machineId: machine.id, cardId: cards[1].id });
  await stations.selectPlayerProfile(root, cards, id);
  const selected = await stations.selectedPlayerConnection(root, cards, cards[1].id);
  assert.equal(selected.server, 'two.invalid'); assert.equal(selected.keychip, machine.values.keychip.id); assert.equal(selected.aimeServer, 'cards.two.invalid');
  const snapshot = await stations.stationSnapshot(root, cards);
  assert.equal(snapshot.server.id, serverIdentity('two.invalid', 'cards.two.invalid').id);
  assert.equal(snapshot.selectedPlayerId, id);
  assert.equal(snapshot.activeMachineId, initial.activeMachineId);
  await assert.rejects(stations.selectedPlayerConnection(root, cards, cards[0].id), /玩家已变化/);
  assert.deepEqual(await fsp.readFile(path.join(root, 'segatools.ini')), baseline);
  assert.deepEqual(await fsp.readFile(path.join(root, 'DEVICE/selected.txt')), virtual);
  assert.equal((await stations.machineBackups(root)).length, 0);
});
test('activation applies all six network fields, retains unrelated bytes and creates restorable backup', async t => {
  const root = await temporary(t), baseline = await fsp.readFile(path.join(root, 'segatools.ini')), initial = await stations.stationSnapshot(root, cards);
  const machine = await stations.saveMachineProfile(root, cards, { name: '机台 2', values: secondValues(initial.machines[0].values) }, stopped);
  await stations.activateMachineProfile(root, cards, machine.id, stopped);
  const current = await stations.machineProfiles(root, cards), ini = await fsp.readFile(path.join(root, 'segatools.ini'), 'utf8');
  assert.equal(current.activeMachineId, machine.id); assert.deepEqual(current.machines.find(m => m.id === machine.id).values, machine.values);
  assert.match(ini, /default=two\.invalid ; keep comment/); assert.match(ini, /\[netenv\]\r\nenable=0/);
  assert.match(ini, /amfs=unchanged/); assert.match(ini, /serialNo=DO-NOT-TOUCH/); assert.match(ini, /aimePath=DEVICE\\selected.txt/);
  assert.equal(current.machines[0].values.dns.default, 'one.invalid');
  const backups = await stations.machineBackups(root); assert.equal(backups.length, 1);
  await stations.restoreMachineBackup(root, backups[0].name, stopped);
  assert.deepEqual(await fsp.readFile(path.join(root, 'segatools.ini')), baseline);
  assert.equal((await stations.machineProfiles(root, cards)).machines.find(m => m.id === machine.id).values.dns.default, 'one.invalid');
});
test('editing the active station requires game stop, failed edits preserve both store and INI', async t => {
  const root = await temporary(t), initial = await stations.stationSnapshot(root, cards), machine = initial.machines[0], baseline = await fsp.readFile(path.join(root, 'segatools.ini'));
  const file = path.join(saveDirectory(root), 'stations.json'), original = await fsp.readFile(file);
  await assert.rejects(stations.saveMachineProfile(root, cards, { id: machine.id, name: machine.name, values: secondValues(machine.values) }, async () => { throw Error('游戏仍在运行'); }), /仍在运行/);
  assert.deepEqual(await fsp.readFile(file), original); assert.deepEqual(await fsp.readFile(path.join(root, 'segatools.ini')), baseline);
  await stations.saveMachineProfile(root, cards, { id: machine.id, name: '重命名', values: machine.values }, async () => { throw Error('rename must not stop game'); });
  assert.equal((await stations.machineProfiles(root, cards)).machines[0].name, '重命名');
});
test('byte preserving INI editing handles UTF8 BOM, legacy bytes and optional missing groups', async t => {
  const base = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[vfs]\r\namfs=keep\r\n; legacy '), Buffer.from([0x81, 0x40, 0xff]), Buffer.from('\r\n[aime]\r\naimePath=DEVICE/selected.txt\r\n[dns]\r\ndefault=one.invalid\r\n')]);
  const root = await temporary(t, base), initial = await stations.stationSnapshot(root, cards), values = secondValues(initial.machines[0].values);
  await stations.saveMachineProfile(root, cards, { id: initial.machines[0].id, name: '机台 1', values }, stopped);
  const bytes = await fsp.readFile(path.join(root, 'segatools.ini')); assert.deepEqual(bytes.subarray(0, 3), base.subarray(0, 3));
  assert.ok(bytes.includes(Buffer.from([0x81, 0x40, 0xff]))); assert.ok(bytes.includes(Buffer.from('[keychip]\r\n')));
  assert.deepEqual((await stations.machineProfiles(root, cards)).machines[0].values, values);
});
test('UTF16 INI format survives network edits', async t => {
  for (const be of [false, true]) {
    const payload = Buffer.from(fixture + '; 注释保留\r\n', 'utf16le');
    const bytes = Buffer.concat([Buffer.from(be ? [0xfe, 0xff] : [0xff, 0xfe]), be ? payload.swap16() : payload]);
    const root = await temporary(t, bytes), initial = await stations.stationSnapshot(root, cards);
    await stations.saveMachineProfile(root, cards, { id: initial.machines[0].id, name: '机台', values: secondValues(initial.machines[0].values) }, stopped);
    const written = await fsp.readFile(path.join(root, 'segatools.ini')); assert.deepEqual(written.subarray(0, 2), bytes.subarray(0, 2));
    const decoded = (be ? Buffer.from(written.subarray(2)).swap16() : written.subarray(2)).toString('utf16le');
    assert.match(decoded, /default=two.invalid/); assert.match(decoded, /注释保留/);
  }
});
test('blank keychip comments the existing setting and later activation restores a value', async t => {
  const root = await temporary(t), initial = await stations.stationSnapshot(root, cards), machine = initial.machines[0];
  const values = structuredClone(machine.values); values.keychip.id = '';
  await stations.saveMachineProfile(root, cards, { id: machine.id, name: machine.name, values }, stopped);
  assert.match(await fsp.readFile(path.join(root, 'segatools.ini'), 'utf8'), /;id=A123-45678901234/);
  assert.equal((await stations.machineProfiles(root, cards)).machines[0].values.keychip.id, '');
  await stations.saveMachineProfile(root, cards, { id: machine.id, name: machine.name, values: machine.values }, stopped);
  assert.equal((await stations.machineProfiles(root, cards)).machines[0].values.keychip.id, machine.values.keychip.id);
});
test('switching filled AimeDB to an empty station comments all active variants and switching back restores it', async t => {
  const base = fixture.replace('AimeDB=\r\n', '  AiMeDb = cards.one.invalid ; reader comment\r\naimedb=cards.one.invalid # duplicate comment\r\n;AimeDB=old.invalid\r\n');
  const root = await temporary(t, Buffer.from(base)), initial = await stations.stationSnapshot(root, cards), original = initial.machines[0];
  const empty = structuredClone(original.values); empty.dns.default = 'two.invalid'; empty.dns.AimeDB = '';
  const machine = await stations.saveMachineProfile(root, cards, { name: 'Empty reader station', values: empty }, stopped);
  await stations.activateMachineProfile(root, cards, machine.id, stopped);
  const blankIni = await fsp.readFile(path.join(root, 'segatools.ini'), 'utf8');
  assert.match(blankIni, /^  ;AiMeDb = cards\.one\.invalid ; reader comment\r?$/m);
  assert.match(blankIni, /^;aimedb=cards\.one\.invalid # duplicate comment\r?$/m);
  assert.match(blankIni, /^;AimeDB=old\.invalid\r?$/m);
  assert.doesNotMatch(blankIni, /^\s*aimedb\s*=/im);
  assert.equal((await stations.machineProfiles(root, cards)).machines.find(item => item.id === machine.id).values.dns.AimeDB, '');
  await stations.activateMachineProfile(root, cards, original.id, stopped);
  const filledIni = await fsp.readFile(path.join(root, 'segatools.ini'), 'utf8');
  assert.match(filledIni, /^AimeDB=cards\.one\.invalid\r?$/m);
  assert.match(filledIni, /^  ;AiMeDb = cards\.one\.invalid ; reader comment\r?$/m);
  assert.match(filledIni, /^;aimedb=cards\.one\.invalid # duplicate comment\r?$/m);
  assert.equal((await stations.machineProfiles(root, cards)).machines.find(item => item.id === original.id).values.dns.AimeDB, original.values.dns.AimeDB);
  const backups = await stations.machineBackups(root); assert.equal(backups.length, 2);
  assert.ok((await Promise.all(backups.map(item => fsp.readFile(path.join(saveDirectory(root), 'machine-backups', item.name))))).some(bytes => bytes.equals(Buffer.from(base))));
  assert.match(filledIni, /serialNo=DO-NOT-TOUCH/); assert.match(filledIni, /aimePath=DEVICE\\selected.txt/);
  assert.equal(await fsp.readFile(path.join(root, 'DEVICE/selected.txt'), 'utf8'), codes[0]);
});
test('clearing the active AimeDB comments the setting while preserving UTF16 encoding and inline explanation', async t => {
  for (const be of [false, true]) {
    const text = fixture.replace('AimeDB=\r\n', 'AimeDB=cards.one.invalid ; 注释保留\r\n');
    const payload = Buffer.from(text, 'utf16le'), baseline = Buffer.concat([Buffer.from(be ? [0xfe, 0xff] : [0xff, 0xfe]), be ? payload.swap16() : payload]);
    const root = await temporary(t, baseline), initial = await stations.stationSnapshot(root, cards), machine = initial.machines[0];
    const values = structuredClone(machine.values); values.dns.AimeDB = '';
    await stations.saveMachineProfile(root, cards, { id: machine.id, name: machine.name, values }, stopped);
    const written = await fsp.readFile(path.join(root, 'segatools.ini'));
    assert.deepEqual(written.subarray(0, 2), baseline.subarray(0, 2));
    const decoded = (be ? Buffer.from(written.subarray(2)).swap16() : written.subarray(2)).toString('utf16le');
    assert.match(decoded, /;AimeDB=cards\.one\.invalid ; 注释保留/);
    assert.doesNotMatch(decoded, /^\s*aimedb\s*=/im);
    assert.equal((await stations.machineProfiles(root, cards)).machines[0].values.dns.AimeDB, '');
  }
});
test('an empty station does not add an active AimeDB entry when it is absent or already commented', async t => {
  for (const entry of ['', ';AimeDB=historical.invalid\r\n', '#AimeDB=historical.invalid\r\n']) {
    const root = await temporary(t, Buffer.from(fixture.replace('AimeDB=\r\n', entry))), initial = await stations.stationSnapshot(root, cards), baseline = await fsp.readFile(path.join(root, 'segatools.ini'));
    await stations.activateMachineProfile(root, cards, initial.activeMachineId, stopped);
    assert.deepEqual(await fsp.readFile(path.join(root, 'segatools.ini')), baseline);
    assert.equal((await stations.machineBackups(root)).length, 0);
  }
});
test('virtual card writes only the configured text file and retains a separate backup', async t => {
  const root = await temporary(t), baseline = await fsp.readFile(path.join(root, 'segatools.ini'));
  await fsp.writeFile(path.join(root, 'DEVICE/aime.txt'), 'untouched');
  await stations.setVirtualPlayerCard(root, cards, cards[1].id, stopped);
  assert.equal((await fsp.readFile(path.join(root, 'DEVICE/selected.txt'), 'utf8')).trim(), codes[1]);
  assert.equal(await fsp.readFile(path.join(root, 'DEVICE/aime.txt'), 'utf8'), 'untouched');
  assert.deepEqual(await fsp.readFile(path.join(root, 'segatools.ini')), baseline);
  const state = await stations.machineProfiles(root, cards); assert.equal(state.virtualCard.cardId, cards[1].id); assert.equal(state.virtualCard.path, path.join(root, 'DEVICE/selected.txt'));
  assert.equal((await fsp.readdir(path.join(saveDirectory(root), 'card-backups'))).length, 1);
});
test('virtual card default and explicit absolute txt paths are supported', async t => {
  const root = await temporary(t, Buffer.from('[dns]\ndefault=one.invalid\n[keychip]\nid=A123-45678901234\n'));
  await stations.setVirtualPlayerCard(root, cards, cards[1].id, stopped);
  assert.equal((await fsp.readFile(path.join(root, 'DEVICE/aime.txt'), 'utf8')).trim(), codes[1]);
  const external = path.join(root, 'custom', 'aime.txt');
  await fsp.appendFile(path.join(root, 'segatools.ini'), `[aime]\naimePath=${external}\n`);
  await stations.setVirtualPlayerCard(root, cards, cards[0].id, stopped);
  assert.equal((await fsp.readFile(external, 'utf8')).trim(), codes[0]);
});
test('game-running, non-txt and unknown-card virtual writes fail before changing files', async t => {
  const root = await temporary(t), target = path.join(root, 'DEVICE/selected.txt'), original = await fsp.readFile(target);
  await assert.rejects(stations.setVirtualPlayerCard(root, cards, cards[1].id, async () => { throw Error('游戏仍在运行'); }), /仍在运行/);
  await assert.rejects(stations.setVirtualPlayerCard(root, cards, 'f'.repeat(64), stopped), /有效卡片/);
  assert.deepEqual(await fsp.readFile(target), original);
  await fsp.writeFile(path.join(root, 'segatools.ini'), '[aime]\naimePath=DEVICE/wrong.ini\n');
  await assert.rejects(stations.setVirtualPlayerCard(root, cards, cards[1].id, stopped), /\.txt/);
  assert.equal(fs.existsSync(path.join(root, 'DEVICE/wrong.ini')), false);
});
test('corrupt stores and invalid field injection preserve existing local data', async t => {
  const root = await temporary(t), initial = await stations.stationSnapshot(root, cards), machine = initial.machines[0], original = await fsp.readFile(path.join(root, 'segatools.ini'));
  const values = structuredClone(machine.values); values.dns.default = 'two.invalid\n[vfs]\namfs=bad';
  await assert.rejects(stations.saveMachineProfile(root, cards, { id: machine.id, name: machine.name, values }, stopped), /字段无效/);
  await assert.rejects(stations.savePlayerProfile(root, cards, { name: '玩家', machineId: 'missing', cardId: cards[0].id }), /机台已变化/);
  const file = path.join(saveDirectory(root), 'stations.json'); await fsp.writeFile(file, '{bad');
  await assert.rejects(stations.stationSnapshot(root, cards), /原文件已保留/); assert.equal(await fsp.readFile(file, 'utf8'), '{bad');
  assert.deepEqual(await fsp.readFile(path.join(root, 'segatools.ini')), original);
});
test('managed save scope resolves selected station rather than active game config', async t => {
  const root = await temporary(t);
  await profiles.addPlayerCard(root, codes[0]); await profiles.addPlayerCard(root, codes[1]);
  const initial = await profiles.playerProfiles(root), machine = await stations.saveMachineProfile(root, cards, { name: '机台 2', values: secondValues(initial.machines[0].values) }, stopped);
  const id = await stations.savePlayerProfile(root, cards, { name: '玩家 3', machineId: machine.id, cardId: cards[1].id });
  await stations.selectPlayerProfile(root, cards, id);
  const next = await profiles.playerProfiles(root); assert.equal(next.selectedPlayerId, id); assert.equal(next.defaultCardId, cards[1].id); assert.equal(next.server.id, machine.server.id);
  const required = await profiles.requirePlayerScope(root, cards[1].id, machine.server.id);
  assert.equal(required.config.server, 'two.invalid'); assert.equal(required.config.accessCode, codes[1]); assert.equal(required.config.keychip, machine.values.keychip.id);
  await assert.rejects(profiles.requirePlayerScope(root, cards[1].id, serverIdentity('one.invalid').id), /配置已变化/);
});
test('queued rapid selection ends on the last player while preserving both profiles', async t => {
  const root = await temporary(t), initial = await stations.stationSnapshot(root, cards);
  await Promise.all([stations.selectPlayerProfile(root, cards, initial.players[0].id), stations.selectPlayerProfile(root, cards, initial.players[1].id)]);
  assert.equal((await stations.stationSnapshot(root, cards)).selectedPlayerId, initial.players[1].id);
  assert.equal((await stations.stationSnapshot(root, cards)).players.length, 2);
});

test('invalid imported and externally edited connection fields remain editable across reloads', async t => {
  const root = await temporary(t, Buffer.from(fixture.replace('A123-45678901234', 'placeholder')));
  const initial = await stations.stationSnapshot(root, cards);
  assert.equal((await stations.stationSnapshot(root, cards)).machines[0].values.keychip.id, 'placeholder');
  const machine = initial.machines[0];
  await stations.saveMachineProfile(root, cards, { id: machine.id, name: machine.name, values: secondValues(machine.values) }, stopped);
  await fsp.writeFile(path.join(root, 'segatools.ini'), fixture.replace('one.invalid', 'invalid server'));
  for (let i = 0; i < 2; i++) assert.equal((await stations.stationSnapshot(root, cards)).machines[0].values.dns.default, 'invalid server');
  await stations.saveMachineProfile(root, cards, { id: machine.id, name: machine.name, values: secondValues(machine.values) }, stopped);
  assert.equal((await stations.stationSnapshot(root, cards)).machines[0].values.dns.default, 'two.invalid');
});

test('configured Unicode card paths decode UTF8 and legacy GBK without changing unrelated INI bytes', async t => {
  for (const encodedName of [Buffer.from('卡片'), Buffer.from([0xbf, 0xa8, 0xc6, 0xac])]) {
    const ini = Buffer.concat([Buffer.from('[aime]\naimePath=DEVICE/'), encodedName, Buffer.from('.txt\n[dns]\ndefault=one.invalid\n')]);
    const root = await temporary(t, ini), target = path.join(root, 'DEVICE/卡片.txt');
    await fsp.writeFile(target, codes[1]);
    const state = await stations.stationSnapshot(root, cards);
    assert.equal(state.virtualCard.path, target); assert.equal(state.virtualCard.cardId, cards[1].id);
    assert.equal(state.players.find(p => p.id === state.selectedPlayerId).cardId, cards[1].id);
    await stations.setVirtualPlayerCard(root, cards, cards[0].id, stopped);
    assert.equal((await fsp.readFile(target, 'utf8')).trim(), codes[0]);
    assert.deepEqual(await fsp.readFile(path.join(root, 'segatools.ini')), ini);
  }
});

test('deleting a local unused station preserves game configuration and selected player', async t => {
  const root = await temporary(t), initial = await stations.stationSnapshot(root, cards);
  const ini = await fsp.readFile(path.join(root, 'segatools.ini')), txt = await fsp.readFile(path.join(root, 'DEVICE/selected.txt'));
  const spare = await stations.saveMachineProfile(root, cards, { name: '备用机台', values: secondValues(initial.machines[0].values) }, stopped);
  await stations.deleteMachineProfile(root, cards, spare.id);
  const next = await stations.stationSnapshot(root, cards);
  assert.deepEqual(next.machines.map(m => m.id), initial.machines.map(m => m.id));
  assert.equal(next.selectedPlayerId, initial.selectedPlayerId); assert.deepEqual(next.players, initial.players);
  assert.deepEqual(await fsp.readFile(path.join(root, 'segatools.ini')), ini);
  assert.deepEqual(await fsp.readFile(path.join(root, 'DEVICE/selected.txt')), txt);
  assert.deepEqual(await stations.machineBackups(root), []);
});

test('last, active and referenced stations cannot be removed; rebinding releases an inactive station', async t => {
  const root = await temporary(t), initial = await stations.stationSnapshot(root, cards), active = initial.machines[0];
  const file = path.join(saveDirectory(root), 'stations.json'), before = await fsp.readFile(file);
  await assert.rejects(stations.deleteMachineProfile(root, cards, active.id), /至少保留/);
  assert.deepEqual(await fsp.readFile(file), before);
  const spare = await stations.saveMachineProfile(root, cards, { name: '备用机台', values: secondValues(active.values) }, stopped);
  await assert.rejects(stations.deleteMachineProfile(root, cards, active.id), /另一机台设为当前/);
  const player = initial.players[1];
  await stations.savePlayerProfile(root, cards, { ...player, machineId: spare.id });
  const referenced = await fsp.readFile(file);
  await assert.rejects(stations.deleteMachineProfile(root, cards, spare.id), /修改使用此机台的玩家/);
  assert.deepEqual(await fsp.readFile(file), referenced);
  await stations.savePlayerProfile(root, cards, player);
  await stations.deleteMachineProfile(root, cards, spare.id);
  assert.equal((await stations.stationSnapshot(root, cards)).machines.length, 1);
});

test('player deletion changes only bindings, keeps cards and archives, and allows an empty player list', async t => {
  const root = await temporary(t);
  for (const code of codes) await profiles.addPlayerCard(root, code);
  const initial = await profiles.playerProfiles(root), ini = await fsp.readFile(path.join(root, 'segatools.ini'));
  const cardFile = path.join(saveDirectory(root), 'profiles.json'), originalCards = await fsp.readFile(cardFile);
  const archive = path.join(saveDirectory(root), 'archives', 'existing.json');
  await fsp.mkdir(path.dirname(archive), { recursive: true }); await fsp.writeFile(archive, '{"preserve":"archive"}');
  await stations.selectPlayerProfile(root, cards, initial.players[1].id);
  await stations.deletePlayerProfile(root, cards, initial.players[1].id);
  assert.equal((await stations.stationSnapshot(root, cards)).selectedPlayerId, initial.players[0].id);
  await stations.deletePlayerProfile(root, cards, initial.players[0].id);
  for (let i = 0; i < 2; i++) {
    const next = await profiles.playerProfiles(root);
    assert.equal(next.players.length, 0); assert.equal(next.selectedPlayerId, ''); assert.equal(next.cards.length, 2);
  }
  await assert.rejects(stations.selectedPlayerConnection(root, cards, cards[0].id), /新增并选择玩家/);
  assert.deepEqual(await fsp.readFile(cardFile), originalCards);
  assert.equal(await fsp.readFile(archive, 'utf8'), '{"preserve":"archive"}');
  assert.deepEqual(await fsp.readFile(path.join(root, 'segatools.ini')), ini);
  assert.equal(await fsp.readFile(path.join(root, 'DEVICE/selected.txt'), 'utf8'), codes[0]);
  const replacement = await stations.savePlayerProfile(root, cards, { name: '新玩家', machineId: initial.machines[0].id, cardId: cards[0].id });
  await stations.selectPlayerProfile(root, cards, replacement);
  assert.equal((await stations.stationSnapshot(root, cards)).selectedPlayerId, replacement);
});

test('deleting an unselected player preserves selection and invalid IDs preserve local data', async t => {
  const root = await temporary(t), initial = await stations.stationSnapshot(root, cards);
  await stations.deletePlayerProfile(root, cards, initial.players[1].id);
  assert.equal((await stations.stationSnapshot(root, cards)).selectedPlayerId, initial.players[0].id);
  const file = path.join(saveDirectory(root), 'stations.json'), original = await fsp.readFile(file);
  for (const id of ['../stations', 'missing']) {
    await assert.rejects(stations.deletePlayerProfile(root, cards, id));
    await assert.rejects(stations.deleteMachineProfile(root, cards, id));
  }
  assert.deepEqual(await fsp.readFile(file), original);
});

const hash = n => require('node:crypto').createHash('sha256').update(String(n)).digest('hex');
const emptyImportedValues = () => ({ dns: { default: '', AimeDB: '', replaceHost: '0' }, netenv: { enable: '0' }, keychip: { id: '', subnet: '' } });
const imported = (machine, overrides = {}) => ({ saveId: 'import-one', name: '导入昵称', cardId: '', machine, machineKey: hash('source-machine'), playerKey: hash('source-player'), ...overrides });
const stationFile = root => path.join(saveDirectory(root), 'stations.json');

test('complete source B import preserves active A, selected player, INI and virtual card while reusing source identity', async t => {
  const root = await temporary(t), initial = await stations.stationSnapshot(root, cards), ini = await fsp.readFile(path.join(root, 'segatools.ini')), txt = await fsp.readFile(path.join(root, 'DEVICE/selected.txt'));
  const values = secondValues(initial.machines[0].values);
  const created = await stations.ensureImportedPlayer(root, cards, imported(values, { cardId: cards[1].id, machineComplete: true }));
  assert.notEqual(created.machineId, initial.activeMachineId); assert.equal(created.serverId, serverIdentity('two.invalid', 'cards.two.invalid').id);
  let next = await stations.stationSnapshot(root, cards);
  assert.equal(next.activeMachineId, initial.activeMachineId); assert.equal(next.selectedPlayerId, initial.selectedPlayerId);
  assert.deepEqual(next.machines.find(m => m.id === created.machineId).values, values);
  assert.equal(next.machines.find(m => m.id === created.machineId).importSourceKey, hash('source-machine'));
  const player = next.players.find(p => p.id === created.playerId);
  assert.equal(player.name, '导入昵称'); assert.deepEqual(player.importedSaveIds, ['import-one']);
  await stations.savePlayerProfile(root, cards, { ...player, name: '保留手工名称' });
  const repeated = await stations.ensureImportedPlayer(root, cards, imported(values, { saveId: 'import-two', name: '后来的存档名', cardId: cards[1].id, machineComplete: true }));
  assert.equal(repeated.playerId, created.playerId); assert.equal(repeated.machineId, created.machineId);
  next = await stations.stationSnapshot(root, cards);
  assert.equal(next.machines.length, 2); assert.equal(next.players.find(p => p.id === created.playerId).name, '保留手工名称');
  assert.deepEqual(next.players.find(p => p.id === created.playerId).importedSaveIds, ['import-one', 'import-two']);
  assert.deepEqual(await fsp.readFile(path.join(root, 'segatools.ini')), ini); assert.deepEqual(await fsp.readFile(path.join(root, 'DEVICE/selected.txt')), txt);
  assert.deepEqual(await stations.machineBackups(root), []); assert.equal(fs.existsSync(path.join(saveDirectory(root), 'card-backups')), false);
});

test('pending imports retain unknown source fields, allow local editing, and concurrent repeats create one player and draft', async t => {
  const root = await temporary(t), initial = await stations.stationSnapshot(root, cards), source = emptyImportedValues();
  const results = await Promise.all([1, 2, 3, 1].map(n => stations.ensureImportedPlayer(root, cards, imported(source, { saveId: `pending-${n}`, name: 'x'.repeat(70) }))));
  assert.equal(new Set(results.map(r => r.machineId)).size, 1); assert.equal(new Set(results.map(r => r.playerId)).size, 1);
  const next = await stations.stationSnapshot(root, cards), player = next.players.find(p => p.id === results[0].playerId), machine = next.machines.find(m => m.id === player.machineId);
  assert.deepEqual(machine.values, source); assert.equal(machine.server, undefined); assert.equal(player.cardId, ''); assert.equal(player.name.length, 40);
  assert.deepEqual(player.importedSaveIds, ['pending-1', 'pending-2', 'pending-3']); assert.deepEqual(player.importSourceKeys, [hash('source-player')]);
  assert.equal(next.activeMachineId, initial.activeMachineId); assert.equal(next.selectedPlayerId, initial.selectedPlayerId);
  await stations.savePlayerProfile(root, cards, { ...player, name: '待关联玩家' });
  assert.equal((await stations.stationSnapshot(root, cards)).players.find(p => p.id === player.id).cardId, '');
  await assert.rejects(stations.savePlayerProfile(root, cards, { name: '普通玩家', machineId: machine.id, cardId: '' }), /普通玩家必须关联真实卡号/);
  await stations.selectPlayerProfile(root, cards, player.id);
  await assert.rejects(stations.selectedPlayerConnection(root, cards, ''), /关联真实卡号/);
  await assert.rejects(stations.selectedPlayerConnection(root, cards, cards[0].id), /关联真实卡号/);
  const legacyRoot = await temporary(t);
  await assert.rejects(stations.selectedPlayerConnection(legacyRoot, cards, ''), /关联真实卡号/);
  assert.equal(fs.existsSync(stationFile(legacyRoot)), false);
});

test('manually associating a pending player retains imported archive/source links and later cardless imports reuse it', async t => {
  const root = await temporary(t), initial = await stations.stationSnapshot(root, cards), values = secondValues(initial.machines[0].values);
  const result = await stations.ensureImportedPlayer(root, cards, imported(values, { machineComplete: true }));
  const pending = (await stations.stationSnapshot(root, cards)).players.find(p => p.id === result.playerId);
  await stations.savePlayerProfile(root, cards, { ...pending, cardId: cards[1].id, name: '已关联' });
  await stations.selectPlayerProfile(root, cards, result.playerId);
  const again = await stations.ensureImportedPlayer(root, cards, imported(values, { saveId: 'another-pending', machineComplete: true }));
  assert.equal(again.playerId, result.playerId); assert.equal(again.cardId, cards[1].id);
  const next = await stations.stationSnapshot(root, cards), player = next.players.find(p => p.id === result.playerId);
  assert.deepEqual(player.importedSaveIds, ['import-one', 'another-pending']); assert.deepEqual(player.importSourceKeys, [hash('source-player')]);
  assert.equal((await stations.selectedPlayerConnection(root, cards, cards[1].id)).server, 'two.invalid');
  assert.equal(next.activeMachineId, initial.activeMachineId); assert.equal(await fsp.readFile(path.join(root, 'DEVICE/selected.txt'), 'utf8'), codes[0]);
  const conflict = await stations.ensureImportedPlayer(root, cards, imported(values, { saveId: 'conflicting-card', machineComplete: true, allowLinkedCard: false }));
  assert.notEqual(conflict.playerId, result.playerId); assert.equal(conflict.cardId, '');
  const pendingConflict = await stations.ensureImportedPlayer(root, cards, imported(values, { saveId: 'conflicting-card-2', machineComplete: true, allowLinkedCard: false }));
  assert.equal(pendingConflict.playerId, conflict.playerId); assert.equal(pendingConflict.cardId, '');
  await assert.rejects(stations.ensureImportedPlayer(root, cards, imported(values, { machineComplete: true, allowLinkedCard: false })), /已属于其他玩家/);
});

test('partial source matches a unique short client ID but ambiguous client evidence creates a separate draft', async t => {
  const root = await temporary(t), initial = await stations.stationSnapshot(root, cards), active = initial.machines[0];
  const other = await stations.saveMachineProfile(root, cards, { name: '不同服务器同Client', values: { ...secondValues(active.values), keychip: { ...active.values.keychip } } }, stopped);
  const partial = emptyImportedValues(); partial.keychip.id = active.values.keychip.id.replace('-', '').slice(0, 11);
  const ambiguous = await stations.ensureImportedPlayer(root, cards, imported(partial));
  assert.notEqual(ambiguous.machineId, active.id); assert.notEqual(ambiguous.machineId, other.id);
  assert.equal(ambiguous.serverId, undefined);
  const disambiguated = await stations.ensureImportedPlayer(root, cards, imported(partial, { saveId: 'declared-source', machineKey: hash('known-declared'), playerKey: hash('known-player'), declaredServerId: other.server.id }));
  assert.equal(disambiguated.machineId, other.id); assert.equal(disambiguated.serverId, other.server.id);
  const partialUnique = emptyImportedValues(); partialUnique.dns.default = 'http://TWO.invalid/'; partialUnique.keychip.id = other.values.keychip.id.toLowerCase().replace('-', '');
  const unique = await stations.ensureImportedPlayer(root, cards, imported(partialUnique, { saveId: 'partial-unique', machineKey: hash('unique-source'), playerKey: hash('unique-player') }));
  assert.equal(unique.machineId, other.id);
  const state = await stations.stationSnapshot(root, cards); assert.equal(state.activeMachineId, active.id); assert.deepEqual(state.machines.find(m => m.id === other.id).values, other.values);
  // Complete snapshots require switches to agree; unknown partial switches never overwrite a configured station.
  const changedToggle = structuredClone(other.values); changedToggle.netenv.enable = '1';
  const complete = await stations.ensureImportedPlayer(root, cards, imported(changedToggle, { saveId: 'full-toggle', machineKey: hash('full-toggle'), playerKey: hash('full-toggle-player'), machineComplete: true }));
  assert.notEqual(complete.machineId, other.id);
});

test('verified declared server identity matches without DNS guesses, while shared-server unknown clients remain ambiguous', async t => {
  const root = await temporary(t), initial = await stations.stationSnapshot(root, cards), active = initial.machines[0];
  const noFields = await stations.ensureImportedPlayer(root, cards, imported(emptyImportedValues(), { declaredServerId: active.server.id }));
  assert.equal(noFields.machineId, active.id);
  const apiDraft = emptyImportedValues(); apiDraft.dns.default = 'http://127.0.0.1:8090/';
  const mapped = await stations.ensureImportedPlayer(root, cards, imported(apiDraft, { saveId: 'mapped-api', machineKey: hash('mapped-api'), playerKey: hash('mapped-api-user'), declaredServerId: active.server.id }));
  assert.equal(mapped.machineId, active.id); assert.equal(mapped.serverId, active.server.id);
  const otherValues = structuredClone(active.values); otherValues.keychip.id = 'C123-45678901234';
  const other = await stations.saveMachineProfile(root, cards, { name: '同服其他Client', values: otherValues }, stopped);
  const ambiguous = await stations.ensureImportedPlayer(root, cards, imported(emptyImportedValues(), { saveId: 'ambiguous-server', machineKey: hash('ambiguous-server'), playerKey: hash('ambiguous-server-user'), declaredServerId: active.server.id }));
  assert.notEqual(ambiguous.machineId, active.id); assert.notEqual(ambiguous.machineId, other.id); assert.equal(ambiguous.serverId, undefined);
  const clientKnown = emptyImportedValues(); clientKnown.keychip.id = 'C1234567890';
  const specific = await stations.ensureImportedPlayer(root, cards, imported(clientKnown, { saveId: 'specific-server', machineKey: hash('specific-server'), playerKey: hash('specific-server-user'), declaredServerId: active.server.id }));
  assert.equal(specific.machineId, other.id);
  const completeMismatch = await stations.ensureImportedPlayer(root, cards, imported(apiDraft, { saveId: 'complete-mismatch', machineKey: hash('complete-mismatch'), playerKey: hash('complete-mismatch-user'), declaredServerId: active.server.id, machineComplete: true }));
  assert.notEqual(completeMismatch.machineId, active.id); assert.notEqual(completeMismatch.machineId, other.id);
  assert.equal((await stations.stationSnapshot(root, cards)).activeMachineId, active.id);
});

test('identical complete machine copies reuse an existing configuration and editing source values invalidates its source marker', async t => {
  const root = await temporary(t), initial = await stations.stationSnapshot(root, cards), values = secondValues(initial.machines[0].values);
  const first = await stations.saveMachineProfile(root, cards, { name: '相同配置 1', values }, stopped);
  await stations.saveMachineProfile(root, cards, { name: '相同配置 2', values }, stopped);
  const assigned = await stations.ensureImportedPlayer(root, cards, imported(values, { machineComplete: true }));
  assert.equal(assigned.machineId, first.id);
  await stations.saveMachineProfile(root, cards, { id: first.id, name: '仅改名', values }, stopped);
  assert.equal((await stations.stationSnapshot(root, cards)).machines.find(m => m.id === first.id).importSourceKey, hash('source-machine'));
  const edited = structuredClone(values); edited.dns.default = 'three.invalid';
  await stations.saveMachineProfile(root, cards, { id: first.id, name: '人工修改来源', values: edited }, stopped);
  const next = await stations.stationSnapshot(root, cards);
  assert.equal(next.machines.find(m => m.id === first.id).importSourceKey, undefined);
  assert.equal(next.players.find(p => p.id === assigned.playerId).machineId, first.id);
  assert.deepEqual(next.players.find(p => p.id === assigned.playerId).importedSaveIds, ['import-one']);
  const newOriginal = await stations.ensureImportedPlayer(root, cards, imported(values, { saveId: 'original-again', machineComplete: true }));
  assert.notEqual(newOriginal.machineId, first.id);
  assert.deepEqual((await stations.stationSnapshot(root, cards)).machines.find(m => m.id === newOriginal.machineId).values, values);
});

test('invalid import identity, fields and association conflicts fail without replacing management files', async t => {
  const root = await temporary(t), values = emptyImportedValues(), request = imported(values);
  for (const override of [{ saveId: '../bad' }, { machineKey: 'x'.repeat(64) }, { playerKey: '../bad' }, { cardId: hash('unknown-card') }, { declaredServerId: 'invalid' }, { machineComplete: 1 }, { allowLinkedCard: 1 }, { name: 42 }, { name: 'x'.repeat(2001) }, { machine: { ...values, extra: {} } }, { machine: { ...values, dns: { ...values.dns, token: 'private' } } }, { machine: { ...values, netenv: { enable: 0 } } }]) {
    await assert.rejects(stations.ensureImportedPlayer(root, cards, { ...request, ...override }));
    assert.equal(fs.existsSync(stationFile(root)), false);
  }
  const assigned = await stations.ensureImportedPlayer(root, cards, request), before = await fsp.readFile(stationFile(root));
  const differentSource = { ...request, machineKey: hash('different-machine') };
  await assert.rejects(stations.ensureImportedPlayer(root, cards, differentSource), /已属于其他玩家/);
  assert.deepEqual(await fsp.readFile(stationFile(root)), before);
  const state = JSON.parse(before); const player = state.players.find(p => p.id === assigned.playerId);
  const mutations = [
    raw => { raw.players.find(p => p.id === player.id).importedSaveIds = []; },
    raw => { raw.players.find(p => p.id === player.id).importedSaveIds = ['../invalid']; },
    raw => { raw.players.find(p => p.id === player.id).importSourceKeys = ['bad']; },
    raw => { raw.players[0].importedSaveIds = ['import-one']; },
    raw => { raw.machines[0].importSourceKey = raw.machines[1].importSourceKey; },
  ];
  for (const mutate of mutations) {
    const raw = structuredClone(state); mutate(raw); const content = JSON.stringify(raw); await fsp.writeFile(stationFile(root), content);
    await assert.rejects(stations.stationSnapshot(root, cards), /原文件已保留/);
    assert.equal(await fsp.readFile(stationFile(root), 'utf8'), content);
  }
  await fsp.writeFile(stationFile(root), before);
});

test('import source and save count limits fail atomically; extra parser payload is never persisted', async t => {
  const root = await temporary(t), request = imported(emptyImportedValues(), { payload: { secret: 'raw-is-not-management-data' }, declaredScope: { unexpected: true } });
  const result = await stations.ensureImportedPlayer(root, cards, request);
  const file = stationFile(root), raw = JSON.parse(await fsp.readFile(file, 'utf8')), player = raw.players.find(p => p.id === result.playerId);
  assert.equal(JSON.stringify(raw).includes('raw-is-not-management-data'), false);
  player.importedSaveIds = Array.from({ length: 500 }, (_, n) => `saved-${n}`);
  const serialized = JSON.stringify(raw); await fsp.writeFile(file, serialized);
  await assert.rejects(stations.ensureImportedPlayer(root, cards, { ...request, saveId: 'overflow-save' }), /最多关联 500/);
  assert.equal(await fsp.readFile(file, 'utf8'), serialized);
  player.importedSaveIds = ['import-one']; player.importSourceKeys = Array.from({ length: 500 }, (_, n) => hash(`key-${n}`));
  const sources = JSON.stringify(raw); await fsp.writeFile(file, sources);
  await assert.rejects(stations.ensureImportedPlayer(root, cards, request), /最多保存 500 个导入来源/);
  assert.equal(await fsp.readFile(file, 'utf8'), sources);
});

test('pending deletion preserves archives and game files; subsequent Mod capture still belongs to active station', async t => {
  const root = await temporary(t), initial = await stations.stationSnapshot(root, cards), ini = await fsp.readFile(path.join(root, 'segatools.ini')), txt = await fsp.readFile(path.join(root, 'DEVICE/selected.txt'));
  const importedPlayer = await stations.ensureImportedPlayer(root, cards, imported(secondValues(initial.machines[0].values), { machineComplete: true }));
  await stations.selectPlayerProfile(root, cards, importedPlayer.playerId);
  const identity = { version: 1, userId: 42, accessCode: codes[1], clientId: 'A1234567890', machine: initial.machines[0].values };
  const captured = await stations.ensureCapturedPlayer(root, cards, identity);
  assert.equal(captured.machineId, initial.activeMachineId); assert.equal(captured.cardId, cards[1].id);
  assert.equal((await stations.stationSnapshot(root, cards)).selectedPlayerId, importedPlayer.playerId);
  await assert.rejects(stations.deleteMachineProfile(root, cards, importedPlayer.machineId), /使用此机台的玩家/);
  const archive = path.join(saveDirectory(root), 'archives', 'import-one.json');
  await fsp.mkdir(path.dirname(archive), { recursive: true }); await fsp.writeFile(archive, '{"original":"preserved"}');
  await stations.deletePlayerProfile(root, cards, importedPlayer.playerId);
  await stations.deleteMachineProfile(root, cards, importedPlayer.machineId);
  assert.equal(await fsp.readFile(archive, 'utf8'), '{"original":"preserved"}');
  assert.deepEqual(await fsp.readFile(path.join(root, 'segatools.ini')), ini); assert.deepEqual(await fsp.readFile(path.join(root, 'DEVICE/selected.txt')), txt);
  assert.deepEqual(await stations.machineBackups(root), []);
});

test('attachment targets the captured player ID and adds only archive ownership without changing selection or game files', async t => {
  const root = await temporary(t), initial = await stations.stationSnapshot(root, cards), ini = await fsp.readFile(path.join(root, 'segatools.ini')), txt = await fsp.readFile(path.join(root, 'DEVICE/selected.txt'));
  const machine = await stations.saveMachineProfile(root, cards, { name: '机台 B', values: secondValues(initial.machines[0].values) }, stopped);
  const target = initial.players[1];
  await stations.savePlayerProfile(root, cards, { ...target, name: '保留昵称', machineId: machine.id });
  await stations.selectPlayerProfile(root, cards, target.id);
  const destination = (await stations.stationSnapshot(root, cards)).selectedPlayerId;
  // A different UI selection after import starts does not redirect this attachment.
  await stations.selectPlayerProfile(root, cards, initial.players[0].id);
  const before = await stations.stationSnapshot(root, cards), result = await stations.attachImportedSaveToPlayer(root, cards, { playerId: destination, saveId: 'selected-import' });
  assert.deepEqual(result, { playerId: target.id, machineId: machine.id, serverId: machine.server.id, cardId: target.cardId });
  const after = await stations.stationSnapshot(root, cards);
  const expected = structuredClone(before); expected.players.find(p => p.id === target.id).importedSaveIds = ['selected-import'];
  assert.deepEqual(after, expected);
  const persisted = await fsp.readFile(stationFile(root));
  await stations.attachImportedSaveToPlayer(root, cards, { playerId: target.id, saveId: 'selected-import' });
  assert.deepEqual(await fsp.readFile(stationFile(root)), persisted);
  assert.deepEqual(await fsp.readFile(path.join(root, 'segatools.ini')), ini); assert.deepEqual(await fsp.readFile(path.join(root, 'DEVICE/selected.txt')), txt);
  assert.equal(fs.existsSync(path.join(saveDirectory(root), 'profiles.json')), false);
  assert.equal(fs.existsSync(path.join(saveDirectory(root), 'archives')), false);
  assert.deepEqual(await stations.machineBackups(root), []);
});

test('attachment preserves pending source metadata and serializes duplicate and conflicting archive ownership', async t => {
  const root = await temporary(t), initial = await stations.stationSnapshot(root, cards);
  const pending = await stations.ensureImportedPlayer(root, cards, imported(emptyImportedValues()));
  const before = await stations.stationSnapshot(root, cards);
  const replies = await Promise.all([1, 2, 1].map(n => stations.attachImportedSaveToPlayer(root, cards, { playerId: pending.playerId, saveId: `attached-${n}` })));
  assert.ok(replies.every(result => result.cardId === '' && result.serverId === undefined));
  const after = await stations.stationSnapshot(root, cards), expected = structuredClone(before);
  expected.players.find(p => p.id === pending.playerId).importedSaveIds = ['import-one', 'attached-1', 'attached-2'];
  assert.deepEqual(after, expected);
  const competing = await Promise.allSettled(initial.players.map(player => stations.attachImportedSaveToPlayer(root, cards, { playerId: player.id, saveId: 'one-owner-only' })));
  assert.equal(competing.filter(r => r.status === 'fulfilled').length, 1); assert.equal(competing.filter(r => r.status === 'rejected').length, 1);
  assert.match(competing.find(r => r.status === 'rejected').reason.message, /已属于其他玩家/);
  const owned = await stations.stationSnapshot(root, cards);
  assert.equal(owned.players.filter(p => p.importedSaveIds?.includes('one-owner-only')).length, 1);
  assert.equal(owned.selectedPlayerId, initial.selectedPlayerId); assert.equal(owned.activeMachineId, initial.activeMachineId);
  const rejectedState = await fsp.readFile(stationFile(root));
  await assert.rejects(stations.attachImportedSaveToPlayer(root, cards, { playerId: initial.players[0].id, saveId: 'import-one' }), /已属于其他玩家/);
  assert.deepEqual(await fsp.readFile(stationFile(root)), rejectedState);
});

test('attachment invalid or deleted destinations do not migrate or recreate players, and capacity failure preserves the store', async t => {
  const root = await temporary(t);
  for (const input of [null, { playerId: '../bad', saveId: 'valid' }, { playerId: 'valid', saveId: '../bad' }, { playerId: 'missing', saveId: 'valid' }]) {
    await assert.rejects(stations.attachImportedSaveToPlayer(root, cards, input));
    assert.equal(fs.existsSync(stationFile(root)), false);
  }
  const initial = await stations.stationSnapshot(root, cards), target = initial.players[1];
  await stations.deletePlayerProfile(root, cards, target.id);
  const missing = await fsp.readFile(stationFile(root));
  await assert.rejects(stations.attachImportedSaveToPlayer(root, cards, { playerId: target.id, saveId: 'removed-import' }), /玩家已变化/);
  assert.deepEqual(await fsp.readFile(stationFile(root)), missing);
  const state = JSON.parse(missing); state.players[0].importedSaveIds = Array.from({ length: 500 }, (_, n) => `archive-${n}`);
  const full = JSON.stringify(state); await fsp.writeFile(stationFile(root), full);
  await assert.rejects(stations.attachImportedSaveToPlayer(root, cards, { playerId: state.players[0].id, saveId: 'over-capacity' }), /最多关联 500/);
  assert.equal(await fsp.readFile(stationFile(root), 'utf8'), full);
  await stations.attachImportedSaveToPlayer(root, cards, { playerId: state.players[0].id, saveId: 'archive-0' });
  assert.equal(await fsp.readFile(stationFile(root), 'utf8'), full);
});
