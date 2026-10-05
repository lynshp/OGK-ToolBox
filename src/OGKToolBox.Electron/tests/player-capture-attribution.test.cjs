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
  const mod = new Module(file, module); mod.filename = file; mod.paths = module.paths;
  mod.require = name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name);
  cache.set(file, mod);
  mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, file);
  return mod.exports;
}
const stations = load(path.join(__dirname, '../electron/machine-profiles.ts'));
const profiles = load(path.join(__dirname, '../electron/player-profiles.ts'));
const { cardIdentity, serverIdentity } = load(path.join(__dirname, '../electron/player-identity.ts'));
const { saveDirectory, persistSave, listSaves, deletePlayerArchives, captureWarnings } = load(path.join(__dirname, '../electron/player-save.ts'));
const { syncCaptures, captureState, captureEvents, refreshFromGame } = load(path.join(__dirname, '../electron/player-capture.ts'));
const codes = ['12345678901234567890', '23456789012345678901', '34567890123456789012'];
const machineA = { dns: { default: 'server-a.invalid', AimeDB: '', replaceHost: '0' }, netenv: { enable: '1' }, keychip: { id: 'A123-45678901234', subnet: '192.168.162.0' } };
const machineB = { dns: { default: 'server-b.invalid', AimeDB: 'cards-b.invalid:22345', replaceHost: '1' }, netenv: { enable: '0' }, keychip: { id: 'B234-56789012345', subnet: '192.168.99.0' } };
const identity = (machine = machineB, accessCode = codes[1], userId = 42) => ({ version: 1, userId, accessCode, clientId: machine.keychip.id.replace('-', '').slice(0, 11), machine: structuredClone(machine) });
const scope = (machine, code) => ({ serverId: serverIdentity(machine.dns.default, machine.dns.AimeDB).id, cardId: cardIdentity(code) });
const ini = m => '[vfs]\noption=unchanged\n[aime]\naimePath=DEVICE/aime.txt\n[dns]\ndefault=' + m.dns.default + '\nAimeDB=' + m.dns.AimeDB + '\nreplaceHost=' + m.dns.replaceHost + '\n[netenv]\nenable=' + m.netenv.enable + '\n[keychip]\nid=' + m.keychip.id + '\nsubnet=' + m.keychip.subnet + '\n';
async function temporary(t, machine = machineA) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ogk-capture-owner-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('ogk-capture-owner-')); await fsp.rm(root, { recursive: true, force: true }); });
  await fsp.writeFile(path.join(root, 'segatools.ini'), ini(machine));
  await fsp.mkdir(path.join(root, 'DEVICE')); await fsp.writeFile(path.join(root, 'DEVICE/aime.txt'), codes[0]);
  return root;
}
async function gameFiles(root) { return { ini: await fsp.readFile(path.join(root, 'segatools.ini')), card: await fsp.readFile(path.join(root, 'DEVICE/aime.txt')) }; }
async function unchangedGame(root, before) {
  assert.deepEqual(await gameFiles(root), before); assert.equal((await stations.machineBackups(root)).length, 0);
  assert.equal(await fsp.stat(path.join(saveDirectory(root), 'card-backups')).then(() => true, () => false), false);
}
async function configured(t, machine = machineA) { const root = await temporary(t, machine), state = await profiles.playerProfiles(root); return { root, state, before: await gameFiles(root) }; }
async function managementFiles(root) { const dir = saveDirectory(root); return { profiles: await fsp.readFile(path.join(dir, 'profiles.json')), stations: await fsp.readFile(path.join(dir, 'stations.json')) }; }
const noActivation = () => { throw new Error('capture must not activate a machine'); };
const capturedEvent = (userId = 42) => ({ api: 'GetUserDataApi', at: '2026-10-03T00:00:00Z', request: { userId }, response: { userId, userData: { userName: 'Captured ' + userId } }, connection: { baseUrl: 'https://routed-api.invalid/ongeki/', encryptVersion: 1, userAgent: 'anonymous' } });
async function writeCapture(root, session, owner, userId = owner?.userId ?? 42) {
  const dir = path.join(saveDirectory(root), 'captures', session); await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, '000001.json'), JSON.stringify(capturedEvent(userId)));
  if (owner) await fsp.writeFile(path.join(dir, 'identity.json'), JSON.stringify(owner));
  return dir;
}
async function selectedAActiveB(t) {
  const { root, state } = await configured(t), machine = await stations.saveMachineProfile(root, state.cards, { name: '机台 2', values: machineB }, noActivation);
  const file = path.join(saveDirectory(root), 'stations.json'), store = JSON.parse(await fsp.readFile(file, 'utf8'));
  store.activeMachineId = machine.id; await fsp.writeFile(file, JSON.stringify(store)); await fsp.writeFile(path.join(root, 'segatools.ini'), ini(machineB));
  return { root, state: await profiles.playerProfiles(root), before: await gameFiles(root), machine };
}

test('Mod captures server LUNATIC into the actual player and retains raw data without activating a machine', async t => {
  const { root, state, before, machine } = await selectedAActiveB(t), session = 'a'.repeat(32);
  const dir = await writeCapture(root, session, identity());
  const music = { api: 'GetUserMusicApi', at: '2026-10-03T01:00:00Z', request: { userId: 42, nextIndex: 0, maxCount: 100 }, response: { userId: 42, nextIndex: 0, userMusicList: [{ musicId: 202, userMusicDetailList: [{ musicId: 202, level: 10, techScoreMax: 1000000, platinumScoreMax: 3000, platinumScoreStar: 4 }] }] }, connection: capturedEvent().connection };
  const original = JSON.stringify(music); await fsp.writeFile(path.join(dir, '000002.json'), original);
  await syncCaptures(root);
  const rows = await profiles.scopedPlayerSaves(root); assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].scope, scope(machineB, codes[1])); assert.equal(rows[0].playerName, 'Captured 42');
  assert.equal(rows[0].scores[0].difficulty, 4); assert.equal(rows[0].scores[0].techScore, 1000000);
  assert.equal(rows[0].scores[0].platinumScoreStar, 4); assert.equal(rows[0].source, 'game');
  const archive = JSON.parse(await fsp.readFile(path.join(saveDirectory(root), 'archives', rows[0].id + '.json'), 'utf8'));
  assert.equal(archive.raw.events.find(e => e.api === 'GetUserMusicApi').response.userMusicList[0].userMusicDetailList[0].level, 10);
  assert.equal(await fsp.readFile(path.join(dir, '000002.json'), 'utf8'), original);
  const next = await profiles.playerProfiles(root);
  assert.equal(next.players.find(p => p.cardId === cardIdentity(codes[1])).machineId, machine.id);
  assert.equal(next.selectedPlayerId, state.selectedPlayerId); assert.equal(next.activeMachineId, state.activeMachineId);
  await syncCaptures(root); assert.equal((await listSaves(root)).length, 1);
  await unchangedGame(root, before);
});

test('actual captured card binds to active B while selected toolbox player A stays unchanged', async t => {
  const { root, state, before, machine } = await selectedAActiveB(t), source = identity(), original = JSON.stringify(source);
  assert.equal(state.server.id, scope(machineA, codes[0]).serverId);
  assert.deepEqual(await profiles.capturedPlayerScope(root, source), scope(machineB, codes[1]));
  const next = await profiles.playerProfiles(root), player = next.players.find(p => p.cardId === cardIdentity(codes[1]));
  assert.equal(player.machineId, machine.id); assert.equal(player.name, '玩家 2');
  assert.equal(next.selectedPlayerId, state.selectedPlayerId); assert.equal(next.activeMachineId, state.activeMachineId);
  assert.equal(next.machines.length, 2); assert.equal(next.cards.length, 2); assert.equal(next.players.length, 2); assert.equal(JSON.stringify(source), original);
  const stored = await managementFiles(root); await profiles.capturedPlayerScope(root, identity()); assert.deepEqual(await managementFiles(root), stored);
  await unchangedGame(root, before);
});

test('first migration initializes only the old catalog, then adds a real card player to the existing active machine', async t => {
  const root = await temporary(t, machineB), before = await gameFiles(root), dir = saveDirectory(root);
  await fsp.mkdir(dir, { recursive: true }); await fsp.writeFile(path.join(dir, 'profiles.json'), JSON.stringify({ version: 1, cards: [{ id: cardIdentity(codes[0]), accessCode: codes[0] }], bindings: {} }));
  await profiles.capturedPlayerScope(root, identity()); const next = await profiles.playerProfiles(root);
  assert.equal(next.machines.length, 1); assert.equal(next.players.length, 2);
  assert.ok(next.players.every(p => p.machineId === next.activeMachineId));
  assert.equal(next.players.find(p => p.id === next.selectedPlayerId).cardId, cardIdentity(codes[0]));
  await unchangedGame(root, before);
});

test('empty modern player list selects the new real card player without making or activating another machine', async t => {
  const { root, state, before } = await configured(t, machineB);
  await stations.deletePlayerProfile(root, state.cards, state.selectedPlayerId); await profiles.capturedPlayerScope(root, identity());
  const next = await profiles.playerProfiles(root);
  assert.equal(next.players.length, 1); assert.equal(next.selectedPlayerId, next.players[0].id);
  assert.equal(next.players[0].cardId, cardIdentity(codes[1])); assert.equal(next.players[0].machineId, state.activeMachineId); assert.equal(next.machines.length, 1);
  await unchangedGame(root, before);
});

test('concurrent repeated captured cards reuse active-machine bindings and retain the existing selection', async t => {
  const { root, state, before } = await configured(t, machineB);
  const results = await Promise.all(Array.from({ length: 5 }, () => profiles.capturedPlayerScope(root, identity())));
  assert.ok(results.every(result => JSON.stringify(result) === JSON.stringify(scope(machineB, codes[1]))));
  await Promise.all([profiles.capturedPlayerScope(root, identity(machineB, codes[2], 84)), profiles.capturedPlayerScope(root, identity(machineB, codes[2], 84))]);
  const next = await profiles.playerProfiles(root);
  assert.equal(next.cards.length, 3); assert.equal(next.machines.length, 1); assert.equal(next.players.length, 3);
  assert.ok(next.players.every(p => p.machineId === state.activeMachineId)); assert.equal(next.selectedPlayerId, state.selectedPlayerId);
  await unchangedGame(root, before);
});

test('historical cross-server metadata is rejected before adding a card or player after the current INI changes', async t => {
  const { root, state } = await configured(t); await fsp.writeFile(path.join(root, 'segatools.ini'), ini(machineB));
  await profiles.playerProfiles(root); const before = await gameFiles(root), managed = await managementFiles(root);
  await assert.rejects(profiles.capturedPlayerScope(root, identity(machineA, codes[1])), /采集服务器与当前机台不同/);
  assert.deepEqual(await managementFiles(root), managed); const next = await profiles.playerProfiles(root);
  assert.equal(next.cards.length, 1); assert.equal(next.players.length, 1); assert.equal(next.machines.length, 1); assert.equal(next.activeMachineId, state.activeMachineId);
  await unchangedGame(root, before);
});

test('same-server keychip and network snapshot differences never create a machine copy', async t => {
  const { root, state, before } = await configured(t), snapshot = structuredClone(machineA);
  snapshot.keychip.id = machineB.keychip.id; snapshot.keychip.subnet = '192.168.88.0'; snapshot.netenv.enable = '0'; snapshot.dns.replaceHost = '1';
  assert.deepEqual(await profiles.capturedPlayerScope(root, identity(snapshot, codes[1])), scope(machineA, codes[1]));
  const next = await profiles.playerProfiles(root); assert.equal(next.machines.length, 1); assert.deepEqual(next.machines[0].values, machineA);
  assert.equal(next.players.find(p => p.cardId === cardIdentity(codes[1])).machineId, state.activeMachineId);
  await unchangedGame(root, before);
});

test('identical nonactive machine copies do not divert automatic attribution away from the current active machine', async t => {
  const { root, state, before } = await configured(t), cardId = await profiles.addPlayerCard(root, codes[1]), cards = (await profiles.playerProfiles(root)).cards;
  const copy = await stations.saveMachineProfile(root, cards, { name: '机台 2', values: machineA }, noActivation);
  await stations.savePlayerProfile(root, cards, { name: '玩家 2', machineId: copy.id, cardId });
  await profiles.capturedPlayerScope(root, identity(machineA, codes[1])); const next = await profiles.playerProfiles(root);
  assert.equal(next.machines.length, 2); assert.equal(next.players.length, 3);
  assert.ok(next.players.some(p => p.machineId === copy.id && p.cardId === cardId));
  assert.ok(next.players.some(p => p.machineId === state.activeMachineId && p.cardId === cardId));
  assert.equal(next.selectedPlayerId, state.selectedPlayerId); await unchangedGame(root, before);
});

test('invalid identity and unknown or nonstring snapshot fields are rejected before any migration or management write', async t => {
  const root = await temporary(t), before = await gameFiles(root);
  const bad = [null, { ...identity(), version: 2 }, { ...identity(), userId: 0 }, { ...identity(), userId: '42' }, { ...identity(), accessCode: 23456789012345678901 }, { ...identity(), accessCode: '2345 **** **** **** ****' }, { ...identity(), clientId: 'A1234567890' }, { ...identity(), clientId: '' }, { ...identity(), extra: true }];
  for (const modify of [m => { m.extra = {}; }, m => { m.dns.secret = 'forbidden'; }, m => { delete m.dns.AimeDB; }, m => { m.keychip.id = null; }, m => { m.dns.default = 'http://name:secret@server.invalid'; }, m => { m.netenv.enable = '2'; }, m => { m.keychip.subnet = '192.168.999.0'; }]) { const value = identity(); modify(value.machine); bad.push(value); }
  for (const value of bad) await assert.rejects(profiles.capturedPlayerScope(root, value), /采集身份|采集机台/);
  assert.equal(await fsp.stat(saveDirectory(root)).then(() => true, () => false), false); await unchangedGame(root, before);
});

test('unset keychip validates the observed short ID and still binds to the existing active machine', async t => {
  const { root, state, before } = await configured(t, machineB), snapshot = structuredClone(machineB); snapshot.keychip.id = '';
  assert.deepEqual(await profiles.capturedPlayerScope(root, { ...identity(), clientId: 'Z9999999999', machine: snapshot }), scope(machineB, codes[1]));
  const next = await profiles.playerProfiles(root); assert.equal(next.machines.length, 1); assert.equal(next.players.find(p => p.cardId === cardIdentity(codes[1])).machineId, state.activeMachineId);
  await unchangedGame(root, before);
});

test('corrupt stations fail before card creation and the serial queue recovers after repair', async t => {
  const { root, state, before } = await configured(t, machineB), file = path.join(saveDirectory(root), 'stations.json'), good = await fsp.readFile(file), managed = await managementFiles(root);
  await fsp.writeFile(file, '{broken'); await assert.rejects(profiles.capturedPlayerScope(root, identity()), /原文件已保留/);
  assert.equal(await fsp.readFile(file, 'utf8'), '{broken'); assert.deepEqual((await managementFiles(root)).profiles, managed.profiles);
  await fsp.writeFile(file, good); await profiles.capturedPlayerScope(root, identity());
  assert.equal((await profiles.playerProfiles(root)).selectedPlayerId, state.selectedPlayerId); await unchangedGame(root, before);
});

test('real sync assigns captured A while toolbox player B is selected', async t => {
  const { root, state, before } = await configured(t), cardId = await profiles.addPlayerCard(root, codes[1]), cards = (await profiles.playerProfiles(root)).cards;
  const machine = await stations.saveMachineProfile(root, cards, { name: '机台 2', values: machineB }, noActivation), playerId = await stations.savePlayerProfile(root, cards, { name: '玩家 2', machineId: machine.id, cardId });
  await stations.selectPlayerProfile(root, cards, playerId); await writeCapture(root, 'a'.repeat(32), identity(machineA, codes[0])); await syncCaptures(root);
  assert.deepEqual((await profiles.scopedPlayerSaves(root))[0].scope, scope(machineA, codes[0]));
  const next = await profiles.playerProfiles(root); assert.equal(next.selectedPlayerId, playerId); assert.equal(next.activeMachineId, state.activeMachineId); assert.equal(next.machines.length, 2);
  await unchangedGame(root, before);
});

test('real sync without identity does not guess the selected or virtual card', async t => {
  const { root, before } = await configured(t), managed = await managementFiles(root); await writeCapture(root, 'a'.repeat(32)); await syncCaptures(root);
  const rows = await profiles.scopedPlayerSaves(root); assert.equal(rows.length, 1); assert.equal(rows[0].scope, undefined); assert.equal(rows[0].serverId, undefined);
  assert.deepEqual(await managementFiles(root), managed); await unchangedGame(root, before);
});

test('real sync reprocesses a late identity sidecar without changing the existing captured read page', async t => {
  const { root, state, before } = await configured(t, machineB), dir = await writeCapture(root, 'a'.repeat(32));
  await syncCaptures(root); assert.equal((await profiles.scopedPlayerSaves(root))[0].scope, undefined); const page = await fsp.readFile(path.join(dir, '000001.json'));
  await fsp.writeFile(path.join(dir, 'identity.json'), JSON.stringify(identity())); await syncCaptures(root);
  const rows = await profiles.scopedPlayerSaves(root), next = await profiles.playerProfiles(root);
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].scope, scope(machineB, codes[1])); assert.equal(next.cards.length, 2); assert.equal(next.players.length, 2); assert.equal(next.machines.length, 1);
  assert.equal(next.selectedPlayerId, state.selectedPlayerId); assert.deepEqual(await fsp.readFile(path.join(dir, '000001.json')), page); await unchangedGame(root, before);
});

test('real sync mismatched identity preserves raw unassigned while adding no management data', async t => {
  const { root, before } = await configured(t, machineB), managed = await managementFiles(root); await writeCapture(root, 'a'.repeat(32), identity(machineB, codes[1], 84), 42);
  await assert.rejects(syncCaptures(root), /采集登录与存档的玩家身份不匹配/);
  assert.deepEqual(await managementFiles(root), managed); const rows = await profiles.scopedPlayerSaves(root); assert.equal(rows.length, 1); assert.equal(rows[0].scope, undefined);
  await unchangedGame(root, before);
});

test('real sync historical cross-server identity preserves raw and never adds the old card to the current machine', async t => {
  const { root, before } = await configured(t, machineB), managed = await managementFiles(root); await writeCapture(root, 'a'.repeat(32), identity(machineA, codes[1]));
  await assert.doesNotReject(syncCaptures(root));
  assert.deepEqual(await managementFiles(root), managed); assert.equal((await profiles.scopedPlayerSaves(root))[0].scope, undefined); await unchangedGame(root, before);
});

test('an old server session does not mark Mod reads as failed or block a new current-server capture', async t => {
  const { root, state, before } = await configured(t, machineB);
  const old = await writeCapture(root, 'a'.repeat(32), identity(machineA, codes[1]));
  const oldBytes = await fsp.readFile(path.join(old, '000001.json'));
  await writeCapture(root, 'b'.repeat(32), identity(machineB, codes[2], 84), 84);
  await assert.doesNotReject(syncCaptures(root));
  const rows = await profiles.scopedPlayerSaves(root), next = await profiles.playerProfiles(root);
  assert.equal(rows.length, 2); assert.equal(rows.filter(row => row.scope).length, 1);
  assert.deepEqual(rows.find(row => row.scope).scope, scope(machineB, codes[2]));
  assert.equal(next.cards.length, 2); assert.ok(!next.cards.some(card => card.id === cardIdentity(codes[1])));
  assert.equal(next.players.length, 2); assert.equal(next.selectedPlayerId, state.selectedPlayerId);
  const managed = await managementFiles(root);
  await assert.doesNotReject(syncCaptures(root));
  assert.deepEqual(await managementFiles(root), managed); assert.deepEqual(await profiles.scopedPlayerSaves(root), rows);
  assert.deepEqual(await fsp.readFile(path.join(old, '000001.json')), oldBytes);
  await unchangedGame(root, before);
});

test('a deferred unchanged session is attributed only after returning to its actual source server', async t => {
  const { root, state } = await configured(t, machineB), session = 'a'.repeat(32);
  const dir = await writeCapture(root, session, identity(machineA, codes[1])), page = await fsp.readFile(path.join(dir, '000001.json'));
  const initial = await managementFiles(root);
  await assert.doesNotReject(syncCaptures(root)); await assert.doesNotReject(syncCaptures(root));
  assert.deepEqual(await managementFiles(root), initial); assert.equal((await profiles.scopedPlayerSaves(root))[0].scope, undefined);
  await fsp.writeFile(path.join(root, 'segatools.ini'), ini(machineA));
  const before = await gameFiles(root);
  await assert.doesNotReject(syncCaptures(root));
  const rows = await profiles.scopedPlayerSaves(root), next = await profiles.playerProfiles(root);
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].scope, scope(machineA, codes[1]));
  assert.equal(next.cards.length, 2); assert.equal(next.players.length, 2); assert.equal(next.machines.length, 1);
  assert.equal(next.activeMachineId, state.activeMachineId); assert.equal(next.selectedPlayerId, state.selectedPlayerId);
  assert.deepEqual(await fsp.readFile(path.join(dir, '000001.json')), page); await unchangedGame(root, before);
});

test('a source change before the second machine check cannot add a captured card or player', { timeout: 5000 }, async t => {
  const { root, state } = await configured(t), initial = await managementFiles(root), originalRead = fsp.readFile;
  let release, entered, running, reads = 0;
  const paused = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  try {
    fsp.readFile = async function(file, ...rest) {
      // The first snapshot reads INI once for its machine and once for the
      // virtual card. Pause the next read at the final machine source check.
      if (file === path.join(root, 'segatools.ini') && ++reads === 3) { entered(); await gate; }
      return originalRead.call(this, file, ...rest);
    };
    running = profiles.capturedPlayerScope(root, identity(machineA, codes[1]));
    const rejected = assert.rejects(running, error => error instanceof stations.CapturedPlayerServerMismatchError);
    await paused;
    assert.deepEqual((await managementFiles(root)).profiles, initial.profiles);
    await fsp.writeFile(path.join(root, 'segatools.ini'), ini(machineB));
    release(); await rejected;
    const next = await profiles.playerProfiles(root);
    assert.equal(next.cards.length, 1); assert.equal(next.players.length, 1); assert.equal(next.machines.length, 1);
    assert.equal(next.selectedPlayerId, state.selectedPlayerId); assert.equal(next.activeMachineId, state.activeMachineId);
    assert.deepEqual((await managementFiles(root)).profiles, initial.profiles);
    const before = await gameFiles(root); await unchangedGame(root, before);
  } finally {
    fsp.readFile = originalRead; release();
    if (running) await running.catch(() => {});
  }
});

test('real sync tombstones prevent late metadata from creating a card or player', async t => {
  const { root, before } = await configured(t, machineB), session = 'a'.repeat(32), dir = await writeCapture(root, session);
  await syncCaptures(root); await deletePlayerArchives(root, ['game-' + session]); const managed = await managementFiles(root);
  await fsp.writeFile(path.join(dir, 'identity.json'), JSON.stringify(identity())); await syncCaptures(root);
  assert.equal((await listSaves(root)).length, 0); assert.deepEqual(await managementFiles(root), managed); await unchangedGame(root, before);
});

test('deferred historical session updates preserve previously attributed archives including direct capture aliases', async t => {
  for (const aliased of [false, true]) {
    const { root } = await configured(t), session = 'a'.repeat(32), dir = await writeCapture(root, session, identity(machineA, codes[0]));
    if (aliased) await persistSave(root, { events: [capturedEvent()] }, 'direct', 'original-direct', scope(machineA, codes[0]));
    await syncCaptures(root);
    const original = (await listSaves(root))[0], file = path.join(saveDirectory(root), 'archives', original.id + '.json'), archive = await fsp.readFile(file);
    if (aliased) { assert.equal(original.id, 'original-direct'); assert.ok(original.captureIds.includes('game-' + session)); }
    await fsp.writeFile(path.join(root, 'segatools.ini'), ini(machineB)); await profiles.playerProfiles(root);
    const before = await gameFiles(root), managed = await managementFiles(root), userId = 42;
    await fsp.writeFile(path.join(dir, '000002.json'), JSON.stringify({ api: 'GetUserMusicApi', at: '2026-10-03T01:00:00Z', request: { userId }, response: { userId, userMusicList: [] }, connection: capturedEvent().connection }));
    await assert.doesNotReject(syncCaptures(root));
    assert.deepEqual(await fsp.readFile(file), archive); const rows = await listSaves(root); assert.equal(rows.length, 1); assert.deepEqual(rows[0].scope, scope(machineA, codes[0]));
    assert.deepEqual(await managementFiles(root), managed); await unchangedGame(root, before);
  }
});

test('real sync continues valid sessions alongside invalid ones and retries after identity repair', async t => {
  const { root, state, before } = await configured(t, machineB), bad = await writeCapture(root, 'a'.repeat(32), identity(machineB, codes[2], 84), 42);
  await writeCapture(root, 'b'.repeat(32), identity(machineB, codes[1], 84)); await assert.rejects(syncCaptures(root), /玩家身份不匹配/);
  let rows = await profiles.scopedPlayerSaves(root), next = await profiles.playerProfiles(root); assert.equal(rows.length, 2); assert.equal(rows.filter(row => row.scope).length, 1);
  assert.equal(next.cards.length, 2); assert.equal(next.players.length, 2); assert.equal(next.machines.length, 1);
  await fsp.writeFile(path.join(bad, 'identity.json'), JSON.stringify(identity(machineB, codes[2], 42))); await syncCaptures(root);
  rows = await profiles.scopedPlayerSaves(root); next = await profiles.playerProfiles(root); assert.equal(rows.length, 2); assert.ok(rows.every(row => row.scope));
  assert.equal(next.cards.length, 3); assert.equal(next.players.length, 3); assert.equal(next.machines.length, 1); assert.equal(next.selectedPlayerId, state.selectedPlayerId);
  await unchangedGame(root, before);
});

test('real sync concurrent and repeated identical sessions preserve aliases without duplicate bindings', async t => {
  const { root, state, before } = await configured(t, machineB);
  await writeCapture(root, 'a'.repeat(32), identity()); await writeCapture(root, 'b'.repeat(32), identity()); await Promise.all(Array.from({ length: 5 }, () => syncCaptures(root)));
  const managed = await managementFiles(root), rows = await listSaves(root); assert.equal(rows.length, 1); assert.deepEqual(rows[0].scope, scope(machineB, codes[1]));
  assert.deepEqual(rows[0].captureIds.sort(), ['game-' + 'a'.repeat(32), 'game-' + 'b'.repeat(32)]);
  await Promise.all([syncCaptures(root), syncCaptures(root)]); assert.deepEqual(await managementFiles(root), managed);
  const next = await profiles.playerProfiles(root); assert.equal(next.cards.length, 2); assert.equal(next.players.length, 2); assert.equal(next.machines.length, 1); assert.equal(next.selectedPlayerId, state.selectedPlayerId);
  await unchangedGame(root, before);
});

test('late identity plus an existing identical scoped direct archive leaves only the attributed archive', async t => {
  const { root, before } = await configured(t, machineB), dir = await writeCapture(root, 'a'.repeat(32)); await syncCaptures(root);
  const event = capturedEvent(); event.connection.baseUrl = 'https://previous-api.invalid/ongeki/';
  await persistSave(root, { events: [event] }, 'direct', 'direct-before-identity', scope(machineB, codes[1]));
  await fsp.writeFile(path.join(dir, 'identity.json'), JSON.stringify(identity())); await syncCaptures(root);
  const rows = await profiles.scopedPlayerSaves(root); assert.equal(rows.length, 1); assert.equal((await listSaves(root)).length, 1);
  assert.equal(rows[0].id, 'direct-before-identity'); assert.deepEqual(rows[0].scope, scope(machineB, codes[1]));
  await unchangedGame(root, before);
});

test('deletion completed during a late identity read prevents archive and management resurrection', { timeout: 5000 }, async t => {
  const { root, before } = await configured(t, machineB), session = 'e'.repeat(32), dir = await writeCapture(root, session);
  await syncCaptures(root); await fsp.writeFile(path.join(dir, 'identity.json'), JSON.stringify(identity()));
  const managed = await managementFiles(root), originalRead = fsp.readFile;
  let release, entered, running;
  const paused = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  try {
    fsp.readFile = async function(file, ...rest) {
      if (file === path.join(dir, 'identity.json')) { entered(); await gate; }
      return originalRead.call(this, file, ...rest);
    };
    running = syncCaptures(root); await paused;
    await deletePlayerArchives(root, [`game-${session}`]);
    release(); await running;
    assert.equal((await listSaves(root)).length, 0);
    assert.deepEqual(await managementFiles(root), managed);
    await unchangedGame(root, before);
  } finally {
    fsp.readFile = originalRead; release();
    if (running) await running.catch(() => {});
  }
  await syncCaptures(root); assert.equal((await listSaves(root)).length, 0);
  assert.deepEqual(await managementFiles(root), managed);
});

test('captured persistence and best merge share profiles then archives lock order', { timeout: 5000 }, async t => {
  const { root, state, before } = await configured(t, machineB), targetScope = scope(machineB, codes[0]);
  const snapshot = score => ({ events: [capturedEvent(), {
    ...capturedEvent(), api: 'GetUserMusicApi', request: { userId: 42, nextIndex: 0, maxCount: 100 },
    response: { userId: 42, nextIndex: 0, userMusicList: [{ userMusicDetailList: [{ musicId: 101, level: 3, techScoreMax: score }] }] }
  }] });
  await persistSave(root, snapshot(900000), 'json', 'merge-target', targetScope);
  await persistSave(root, snapshot(970000), 'json', 'merge-source', { ...targetScope, serverId: serverIdentity('history.invalid').id });
  const session = 'f'.repeat(32), raw = { sessionId: session, events: [capturedEvent()] };
  const [merged, captured, repeated] = await Promise.all([
    profiles.mergePlayerBest(root, 'merge-target', ['merge-source'], targetScope.cardId, targetScope.serverId),
    profiles.persistCapturedPlayerSave(root, raw, session, identity()),
    profiles.persistCapturedPlayerSave(root, raw, session, identity())
  ]);
  assert.match(merged.id, /^best-/); assert.equal(merged.scores[0].techScore, 970000);
  assert.deepEqual(captured.scope, scope(machineB, codes[1])); assert.equal(repeated.id, captured.id); assert.equal(repeated.unchanged, true);
  const next = await profiles.playerProfiles(root);
  assert.equal(next.cards.length, 2); assert.equal(next.players.length, 2); assert.equal(next.machines.length, 1);
  assert.equal(next.selectedPlayerId, state.selectedPlayerId); assert.equal(next.activeMachineId, state.activeMachineId);
  assert.equal((await listSaves(root)).length, 4); await unchangedGame(root, before);
});

test('isolated Preview and Upsert observations never create player archives or enable ordinary refresh', async t => {
  const { root, before } = await configured(t), managed = await managementFiles(root);
  const dir = path.join(saveDirectory(root), 'preview-observations'); await fsp.mkdir(dir);
  await fsp.writeFile(path.join(dir, 'a'.repeat(32) + '.json'), JSON.stringify({
    version: 1, ...capturedEvent(84), api: 'GetUserPreviewApi',
    response: { userId: 84, userName: 'Preview only', isLogin: false, banStatus: 0, isWarningConfirmed: true },
    machine: machineB
  }));
  // Diagnostics are not part of the save parser, including malformed records.
  await fsp.writeFile(path.join(dir, 'b'.repeat(32) + '.json'), 'not-json');
  const upsertDir = path.join(saveDirectory(root), 'upsert-observations'); await fsp.mkdir(upsertDir);
  await fsp.writeFile(path.join(upsertDir, 'a'.repeat(32) + '.json'), JSON.stringify({
    version: 1, api: 'UpsertUserAllApi', serializedRequest: JSON.stringify({ userId: 84, upsertUserAll: { userData: [{ userName: 'Observation only' }] } }),
    serializedResponse: '{"returnCode":1}', machine: machineB
  }));
  await fsp.writeFile(path.join(upsertDir, 'b'.repeat(32) + '.json'), 'not-json');
  await syncCaptures(root);
  assert.equal((await listSaves(root)).length, 0);
  const status = await captureState(root); assert.equal(status.sessions, 0); assert.equal(status.canRefresh, false);
  assert.deepEqual(await managementFiles(root), managed);
  await unchangedGame(root, before);
});

test('Preview and Upsert diagnostics leave core capture completion and the ordinary refresh request set unchanged', async t => {
  const { root, before } = await configured(t, machineB), session = 'c'.repeat(32);
  const dir = await writeCapture(root, session, identity());
  const core = {
    GetUserMusicApi: { userMusicList: [], nextIndex: 0 }, GetUserCardApi: { userCardList: [] },
    GetUserCharacterApi: { userCharacterList: [] }, GetUserItemApi: { userItemList: [] }, GetUserOptionApi: { userOption: {} }
  };
  let index = 2;
  for (const [api, response] of Object.entries(core)) await fsp.writeFile(path.join(dir, String(index++).padStart(6, '0') + '.json'),
    JSON.stringify({ ...capturedEvent(), api, ...(api === 'GetUserMusicApi' ? { request: { userId: 42, nextIndex: 0, maxCount: 100 } } : {}), response: { userId: 42, ...response } }));
  await syncCaptures(root);
  const original = await listSaves(root), managed = await managementFiles(root);
  assert.equal(original.length, 1); assert.deepEqual(captureWarnings(await captureEvents(root, session)), []);
  const diagnosticDir = path.join(saveDirectory(root), 'preview-observations'); await fsp.mkdir(diagnosticDir);
  await fsp.writeFile(path.join(diagnosticDir, 'd'.repeat(32) + '.json'), JSON.stringify({
    version: 1, ...capturedEvent(), api: 'GetUserPreviewApi',
    response: { userId: 42, userName: 'Preview later', isLogin: false, banStatus: 0, isWarningConfirmed: true }, machine: machineB
  }));
  const upsertDir = path.join(saveDirectory(root), 'upsert-observations'); await fsp.mkdir(upsertDir);
  await fsp.writeFile(path.join(upsertDir, 'e'.repeat(32) + '.json'), JSON.stringify({
    version: 1, api: 'UpsertUserAllApi', serializedRequest: JSON.stringify({ userId: 42, upsertUserAll: { userActivityList: [null, {}, { kind: 0 }] } }),
    serializedResponse: '{"returnCode":1}', machine: machineB
  }));
  await syncCaptures(root); assert.deepEqual(await listSaves(root), original);
  const calls = [];
  const refreshed = await refreshFromGame(root, session, undefined, async event => {
    calls.push(event.api); assert.notEqual(event.api, 'GetUserPreviewApi'); assert.notEqual(event.api, 'UpsertUserAllApi'); return event.response;
  }, original[0].scope);
  assert.deepEqual(calls, ['GetUserDataApi', ...Object.keys(core)]); assert.deepEqual(refreshed.warnings, original[0].warnings);
  assert.deepEqual(await managementFiles(root), managed);
  await unchangedGame(root, before);
});
