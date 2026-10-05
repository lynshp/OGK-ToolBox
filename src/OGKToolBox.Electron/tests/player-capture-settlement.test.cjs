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
const { capturedSettlements, settlementsForCapture, applyCapturedSettlements } = load(path.join(__dirname, '../electron/player-capture-settlement.ts'));
const { syncCaptures } = load(path.join(__dirname, '../electron/player-capture.ts'));
const { listSaves, deletePlayerArchives, saveDirectory } = load(path.join(__dirname, '../electron/player-save.ts'));
const { hasCompletedCaptureUpdate } = load(path.join(__dirname, '../src/player-save-selection.ts'));
const machine = { dns: { default: 'server.invalid', AimeDB: '', replaceHost: '0' }, netenv: { enable: '1' }, keychip: { id: 'A123-45678901234', subnet: '192.168.162.0' } };
const identity = { version: 1, userId: 42, accessCode: '12345678901234567890', clientId: 'A1234567890', machine };
const connection = { baseUrl: 'https://server.invalid/game/', encryptVersion: 0, userAgent: 'anonymous' };
function capture(session = 'a'.repeat(32), at = '2026-10-05T01:00:00Z') {
  const event = (api, field, rows, extra = {}) => ({ api, at, connection, request: { userId: 42, ...extra }, response: { userId: 42, [field]: rows, ...(Array.isArray(rows) ? { length: rows.length, nextIndex: 0 } : {}) } });
  return { session, identity: structuredClone(identity), events: [
    event('GetUserDataApi', 'userData', { userName: 'Anonymous', point: 100, jewelCount: 5, newPlayerRating: 1000 }),
    event('GetUserOptionApi', 'userOption', { speed: 5 }),
    event('GetUserMusicApi', 'userMusicList', [{ musicId: 1, length: 1, userMusicDetailList: [{ musicId: 1, level: 3, techScoreMax: 900000, playCount: 1 }] }, { musicId: 2, length: 1, userMusicDetailList: [{ musicId: 2, level: 3, techScoreMax: 800000 }] }], { nextIndex: 0 }),
    event('GetUserCardApi', 'userCardList', [{ cardId: 1, level: 5 }, { cardId: 2, level: 3 }], { nextIndex: 0 }),
    event('GetUserCharacterApi', 'userCharacterList', [{ characterId: 1, level: 1 }], { nextIndex: 0 }),
    event('GetUserItemApi', 'userItemList', [{ itemId: 1, stock: 5, isValid: true }, { itemId: 2, stock: 9, isValid: true }], { nextIndex: 110000000000 }),
  ] };
}
function settlement(id = 'b'.repeat(32), at = '2026-10-05T02:00:00Z') {
  return { id, sessionId: 'a'.repeat(32), at, identity: structuredClone(identity), baseUrl: connection.baseUrl.slice(0, -1), body: {
    userData: [{ userName: 'Anonymous', point: 120, newPlayerRating: 1100 }], userOption: [{ speed: 6 }],
    userMusicDetailList: [{ musicId: 1, level: 3, techScoreMax: 950000, playCount: 2 }, { musicId: 3, level: 10, techScoreMax: 980000 }], isNewMusicDetailList: '01',
    userCardList: [{ cardId: 1, level: 8 }], isNewCardList: '0',
    userCharacterList: [{ characterId: 1, level: 2 }], isNewCharacterList: '0',
    userItemList: [{ itemKind: 11, itemId: 1, stock: 3, isValid: true }, { itemKind: 12, itemId: 3, stock: 2, isValid: true }], isNewItemList: '01',
    userChapterList: [{ chapterId: 1, jewelCount: 20 }], isNewChapterList: '1',
    userRatinglogList: [{ dataVersion: '1.50.0', highestRating: 1300 }], isNewRatinglogList: '1',
    userActivityList: [{ kind: 2, id: 3, sortNumber: 100, param1: 10, param2: 980000, param3: 0, param4: 0 }, { kind: 0, id: 0, sortNumber: 0, param1: 0, param2: 0, param3: 0, param4: 0 }],
  } };
}
async function temporary(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ogk-settlement-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, 'segatools.ini'), '[dns]\ndefault=server.invalid\nAimeDB=\nreplaceHost=0\n[netenv]\nenable=1\n[keychip]\nid=A123-45678901234\nsubnet=192.168.162.0\n');
  return root;
}
async function writeCapture(root, value) {
  const dir = path.join(saveDirectory(root), 'captures', value.session); await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'identity.json'), JSON.stringify(value.identity));
  for (const [i, event] of value.events.entries()) await fsp.writeFile(path.join(dir, String(i + 1).padStart(6, '0') + '.json'), JSON.stringify(event));
}
async function writeSettlement(root, value, mutate = value => value) {
  const dir = path.join(saveDirectory(root), 'upsert-observations'); await fsp.mkdir(dir, { recursive: true });
  const wrapper = { version: 1, api: 'UpsertUserAllApi', source: 'game-transport-success-response', observationPath: 'net-http-request-completed', acceptance: 'transport-success-return-code', compressionRequested: true,
    returnCode: 1, at: value.at, loginGeneration: 'c'.repeat(32), sessionId: value.sessionId, identity: value.identity, machine: value.identity.machine, connection,
    serializedRequest: JSON.stringify({ userId: 42, clientId: identity.clientId, accessCode: identity.accessCode, upsertUserAll: value.body }), serializedResponse: JSON.stringify({ returnCode: 1 }) };
  await fsp.writeFile(path.join(dir, value.id + '.json'), JSON.stringify(mutate(wrapper)));
}

test('accepted save overlays deltas, including consumed resources, while retaining untouched login records', () => {
  const login = capture(), original = structuredClone(login), result = applyCapturedSettlements(login, [settlement()]);
  assert.deepEqual(login, original);
  const response = api => result.raw.events.find(event => event.api === api).response;
  assert.equal(response('GetUserDataApi').userData.point, 120);
  assert.equal(response('GetUserDataApi').userData.jewelCount, 5);
  assert.equal(response('GetUserItemApi').userItemList[0].stock, 3);
  assert.equal(response('GetUserItemApi').userItemList[1].stock, 9);
  assert.deepEqual(response('GetUserCardApi').userCardList, [{ cardId: 1, level: 8 }, { cardId: 2, level: 3 }]);
  const songs = response('GetUserMusicApi').userMusicList;
  assert.equal(songs[0].userMusicDetailList[0].techScoreMax, 950000);
  assert.equal(songs[1].userMusicDetailList[0].techScoreMax, 800000);
  assert.equal(songs[2].userMusicDetailList[0].level, 10);
  assert.deepEqual(result.raw.captureWarnings, []);
  assert.notEqual(result.id, 'game-' + login.session);
});
test('sequential saves accumulate changes and empty delta lists do not erase inventories', () => {
  const first = settlement(), second = settlement('d'.repeat(32), '2026-10-05T03:00:00Z');
  second.body.userItemList = []; second.body.isNewItemList = ''; second.body.userMusicDetailList = []; second.body.isNewMusicDetailList = '';
  second.body.userData[0].point = 140;
  const result = applyCapturedSettlements(capture(), [first, second]);
  assert.equal(result.raw.events.find(e => e.api === 'GetUserDataApi').response.userData.point, 140);
  assert.equal(result.raw.events.find(e => e.api === 'GetUserItemApi').response.userItemList[0].stock, 3);
  assert.equal(result.raw.events.find(e => e.api === 'GetUserMusicApi').response.userMusicList.length, 3);
});
test('invalid flag lengths or duplicated row keys cannot publish a partially applied save', () => {
  for (const mutate of [s => s.body.isNewItemList = '', s => s.body.userData = [], s => { s.body.userMusicDetailList.push(s.body.userMusicDetailList[0]); s.body.isNewMusicDetailList += '0'; }]) {
    const value = settlement(); mutate(value); assert.throws(() => applyCapturedSettlements(capture(), [value]), /原存档保留/);
  }
});
test('matching requires the exact session, card, endpoint and a complete preceding login', () => {
  const login = capture(), value = settlement();
  assert.equal(settlementsForCapture(login, [login], [value]).length, 1);
  for (const mutate of [s => s.identity.accessCode = '23456789012345678901', s => s.baseUrl = 'https://other.invalid/game', s => s.sessionId = 'e'.repeat(32), s => s.at = '2026-10-04T00:00:00Z']) {
    const other = structuredClone(value); mutate(other); assert.deepEqual(settlementsForCapture(login, [login], [other]), []);
  }
  const partial = capture(); partial.events.pop(); assert.deepEqual(settlementsForCapture(partial, [partial], [value]), []);
});
test('legacy observations select the unique latest preceding login, never every login of the same player', () => {
  const old = capture('e'.repeat(32), '2026-10-05T00:00:00Z'), current = capture(), value = settlement(); delete value.sessionId;
  assert.deepEqual(settlementsForCapture(old, [old, current], [value]), []);
  assert.equal(settlementsForCapture(current, [old, current], [value]).length, 1);
  const ambiguous = capture('f'.repeat(32)); assert.deepEqual(settlementsForCapture(current, [current, ambiguous], [value]), []);
});
test('observation reader rejects failures and mismatched request identities', async t => {
  const root = await temporary(t), value = settlement();
  await writeSettlement(root, value); assert.equal((await capturedSettlements(root)).length, 1);
  for (const mutate of [w => ({ ...w, returnCode: 0 }), w => ({ ...w, serializedResponse: '{"returnCode":0}' }), w => ({ ...w, acceptance: 'unknown' }), w => ({ ...w, serializedRequest: JSON.stringify({ ...JSON.parse(w.serializedRequest), accessCode: '23456789012345678901' }) })]) {
    await writeSettlement(root, value, mutate); assert.deepEqual(await capturedSettlements(root), []);
  }
});
test('real sync publishes a new completed revision after settlement, preserves login archives, and does not repeat or resurrect it', async t => {
  const root = await temporary(t), login = capture(); await writeCapture(root, login); await syncCaptures(root);
  const before = await listSaves(root); assert.equal(before.length, 1);
  const loginFile = path.join(saveDirectory(root), 'archives', before[0].id + '.json'), bytes = await fsp.readFile(loginFile);
  await writeSettlement(root, settlement()); await syncCaptures(root);
  const after = await listSaves(root); assert.equal(after.length, 2);
  const newest = after[0]; assert.equal(newest.scores.find(s => s.musicId === 1).techScore, 950000);
  assert.equal(newest.scores.find(s => s.musicId === 3).difficulty, 4);
  assert.ok(newest.latestCapture); assert.equal(newest.sessionId, login.session);
  assert.ok(hasCompletedCaptureUpdate(before, after, newest.scope.serverId, newest.scope.cardId));
  assert.deepEqual(await fsp.readFile(loginFile), bytes);
  await syncCaptures(root); assert.deepEqual(await listSaves(root), after);
  await deletePlayerArchives(root, after.map(s => s.id));
  await writeSettlement(root, settlement('d'.repeat(32), '2026-10-05T03:00:00Z')); await syncCaptures(root);
  assert.deepEqual(await listSaves(root), []);
});
