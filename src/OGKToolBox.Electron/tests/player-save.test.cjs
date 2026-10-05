const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const zlib = require('node:zlib');
const net = require('node:net');
const crypto = require('node:crypto');
const ts = require('typescript');
const Module = require('node:module');
const modules = new Map();
function load(name) {
  const file = path.resolve(__dirname, `../electron/${name}.ts`);
  return loadFile(file);
}
function loadFile(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const m = new Module(file, module); m.filename = file; m.paths = module.paths;
  m.require = id => id.startsWith('.') ? loadFile(path.resolve(path.dirname(file), `${id}.ts`)) : require(id);
  modules.set(file, m);
  m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, file);
  return m.exports;
}
const { summarizeSave, parseSave, persistSave, listSaves, deletePlayerArchives, saveDirectory, captureWarnings } = load('player-save');
const { captureEvents, syncCaptures, refreshFromGame, refreshFromRequests, readGameApi, captureState, setCapture } = load('player-capture');
const { validatePlayerConnection, playerConnectionDefaults, discoverPlayerServer, lookupPlayerCard, createCardLookup, parseCardLookup, fetchPlayerFromConfiguration } = load('player-bootstrap');
const ownConnection = { server: 'server.invalid', keychip: 'A123-45678901234', accessCode: '12345678901234567890', version: '1.50' };
function aimeCipher(bytes, encrypt = true) {
  const cipher = (encrypt ? crypto.createCipheriv : crypto.createDecipheriv)('aes-128-ecb', Buffer.from('Copyright(C)SEGA'), null);
  cipher.setAutoPadding(false); return Buffer.concat([cipher.update(bytes), cipher.final()]);
}
function cardResponse(userId, command = 0x10) {
  const bytes = Buffer.alloc(0x130); bytes.writeUInt16LE(0xa13e); bytes.writeUInt16LE(0x3087, 2); bytes.writeUInt16LE(command, 4); bytes.writeUInt16LE(bytes.length, 6); bytes.writeUInt16LE(1, 8); bytes.writeUInt32LE(userId, 32); return aimeCipher(bytes);
}
const score = { musicId: 101, level: 3, techScoreMax: 1005000, battleScoreMax: 1234567, isAllBreake: true, isFullBell: false };
const fixture = { userData: { userName: 'TEST', userId: 42 }, userMusicList: [{ userMusicDetailList: [score] }], userCardList: [{ cardId: 1 }], userItemList: [] };
const session = 'a'.repeat(32);
function event(nextIndex = 0, next = -1) { return { api: 'GetUserMusicApi', at: new Date().toISOString(), request: { userId: 42, nextIndex, maxCount: 100 }, response: { userId: 42, nextIndex: next, userMusicList: [{ userMusicDetailList: [score] }] }, connection: { baseUrl: 'http://127.0.0.1/ongeki/', encryptVersion: 0, userAgent: 'fixture#42' } }; }
async function temporary(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ogk-save-test-'));
  t.after(async () => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('ogk-save-test-')); await fsp.rm(dir, { recursive: true, force: true }); });
  return dir;
}
async function capture(root, events) {
  const dir = path.join(saveDirectory(root), 'captures', session); await fsp.mkdir(dir, { recursive: true });
  for (let i = 0; i < events.length; i++) await fsp.writeFile(path.join(dir, `${String(i + 1).padStart(6, '0')}.json`), JSON.stringify(events[i]));
}
test('capture status expires old heartbeats and reinstall clears obsolete status, retaining archives', async t => {
  const root = await temporary(t), dir = saveDirectory(root);
  await fsp.mkdir(path.join(root, 'BepInEx', 'core'), { recursive: true });
  await fsp.writeFile(path.join(root, 'BepInEx', 'core', 'BepInEx.dll'), 'fixture');
  const bundled = path.join(root, 'fixture-plugin.dll'); await fsp.writeFile(bundled, 'fixture');
  await setCapture(root, true, bundled);
  const statusFile = path.join(dir, 'capture-status.txt');
  await fsp.writeFile(statusFile, '\ufeffready');
  assert.equal((await captureState(root)).status, 'ready');
  const old = new Date(Date.now() - 60000); await fsp.utimes(statusFile, old, old);
  assert.equal((await captureState(root)).status, 'inactive');
  await fsp.writeFile(statusFile, 'unsupported: MissingMethodException');
  await fsp.utimes(statusFile, old, old);
  assert.match((await captureState(root)).status, /^unsupported/);
  await persistSave(root, fixture, 'json');
  const installed = await setCapture(root, true, bundled);
  assert.equal(installed.status, ''); assert.equal(installed.enabled, true);
  assert.equal((await listSaves(root)).length, 1);
  await setCapture(root, false, bundled);
  assert.equal((await captureState(root)).enabled, false);
});
test('capture status completes only the current login after all required pages arrive', async t => {
  const root = await temporary(t), dir = saveDirectory(root);
  const fields = { GetUserDataApi: ['userData', {}], GetUserMusicApi: ['userMusicList', []], GetUserCardApi: ['userCardList', []], GetUserCharacterApi: ['userCharacterList', []], GetUserItemApi: ['userItemList', []], GetUserOptionApi: ['userOption', {}] };
  const events = Object.entries(fields).map(([api, [field, value]]) => ({ api, at: new Date().toISOString(), request: { userId: 42, nextIndex: 0 }, response: { userId: 42, [field]: value, ...(field.endsWith('List') ? { nextIndex: 0 } : {}) } }));
  await capture(root, events.slice(0, -1));
  await fsp.writeFile(path.join(dir, 'capture-status.txt'), 'capturing');
  await fsp.writeFile(path.join(dir, 'capture-session.txt'), session);
  assert.equal((await captureState(root)).status, 'capturing');
  await capture(root, events);
  assert.equal((await captureState(root)).status, 'captured');
  events[1].response.nextIndex = 100;
  await capture(root, events);
  assert.equal((await captureState(root)).status, 'capturing', 'unfinished page chain stays collecting');
  events[1].response.nextIndex = 0;
  await capture(root, events);
  await fsp.writeFile(path.join(dir, 'capture-session.txt'), 'b'.repeat(32));
  assert.equal((await captureState(root)).status, 'capturing', 'previous complete login cannot complete a new login');
  await fsp.writeFile(path.join(dir, 'capture-session.txt'), session);
  const old = new Date(Date.now() - 60000);
  await fsp.utimes(path.join(dir, 'capture-status.txt'), old, old);
  assert.equal((await captureState(root)).status, 'inactive', 'completed capture does not keep a stopped game connected');
});

test('import handles BOM, nested music pages and resource counts', () => {
  const result = summarizeSave(parseSave('\ufeff' + JSON.stringify(fixture)), 'json');
  assert.equal(result.playerName, 'TEST'); assert.equal(result.scores.length, 1);
  assert.equal(result.scores[0].allBreak, true); assert.equal(result.scores[0].fullBell, false);
  assert.ok(result.collections.some(item => item.name === 'userCardList' && item.count === 1));
});

const munetFixture = () => ({
  gameId: 'ongeki',
  userData: { id: 42, userName: 'MuNET Fixture', newPlayerRating: 12345, jewelCount: 7 },
  userMusicDetailList: [
    { id: 1, userId: 42, ...score },
    { id: 2, userId: 42, musicId: 202, level: 10, techScoreMax: 1000000, battleScoreMax: 1200000, platinumScoreMax: 3000, platinumScoreStar: 4, isFullCombo: true, isFullBell: false, isAllBreake: false, playCount: 2 }
  ],
  userCardList: [{ id: 3, userId: 42, cardId: 7 }],
  userCharacterList: [{ id: 4, userId: 42, characterId: 1 }],
  userItemList: [{ id: 5, userId: 42, itemKind: 13, itemId: 1, stock: 2 }],
  userPlaylogList: [
    { id: 6, userId: 42, musicId: 202, level: 10, techScore: 990000, playDate: '2026-10-03', userPlayDate: '2026-10-03 10:00:00.0' },
    { id: 7, userId: 42, musicId: 202, level: 10, techScore: 1000000, playDate: '2026-10-03', userPlayDate: '2026-10-03 11:00:00.0' }
  ]
});

test('flat MuNET exports normalize server LUNATIC and retain precise separate play times', () => {
  const raw = munetFixture(), before = JSON.stringify(raw);
  const result = summarizeSave(raw, 'json');
  assert.equal(result.playerName, 'MuNET Fixture'); assert.equal(result.newPlayerRating, 12345);
  assert.deepEqual(result.scores.map(s => [s.musicId, s.difficulty, s.techScore]), [[101, 3, 1005000], [202, 4, 1000000]]);
  assert.equal(result.scores[1].platinumScore, 3000); assert.equal(result.scores[1].platinumScoreStar, 4); assert.equal(result.scores[1].fullCombo, true);
  assert.equal(result.inventory.cardCount, 1); assert.equal(result.inventory.items.find(i => i.itemKind === 13).stock, 2);
  assert.ok(result.collections.some(c => c.name === 'userCharacterList' && c.count === 1));
  assert.equal(result.recentPlaysRecorded, true); assert.equal(result.recentPlays.length, 2);
  assert.deepEqual(result.recentPlays.map(p => [p.musicId, p.difficulty, p.techScore]), [[202, 4, 1000000], [202, 4, 990000]]);
  assert.equal(result.recentPlays[0].playedAt, new Date('2026-10-03 11:00:00.0').toISOString());
  assert.equal(JSON.stringify(raw), before);
});

test('invalid preferred play timestamps fall back to valid legacy timestamps', () => {
  for (const userPlayDate of ['', 'invalid', 0, -1, null]) {
    const raw = { userPlaylogList: [{ musicId: 202, level: 10, techScore: 990000, userPlayDate, playDate: '2026-10-03T10:00:00Z' }] };
    const result = summarizeSave(raw, 'json');
    assert.equal(result.recentPlays.length, 1); assert.equal(result.recentPlays[0].playedAt, '2026-10-03T10:00:00.000Z');
    assert.equal(result.recentPlays[0].difficulty, 4);
  }
  const result = summarizeSave({ userPlaylogList: [{ musicId: 202, userPlayDate: 'invalid', playDate: '', playedAt: '2026-10-03T11:00:00Z' }, { musicId: 203, userPlayDate: 'invalid', playDate: '' }] }, 'json');
  assert.equal(result.recentPlays.length, 1); assert.equal(result.recentPlays[0].musicId, 202);
});

test('normalized LUNATIC combines legacy aliases locally without accepting invalid difficulties or owners', () => {
  const raw = munetFixture();
  raw.userMusicDetailList.push({ ...raw.userMusicDetailList[1], level: 4, techScoreMax: 990000, platinumScoreMax: 3100, isFullBell: true });
  const result = summarizeSave(raw, 'json');
  assert.equal(result.scores.length, 2); assert.equal(result.scores[1].techScore, 1000000);
  assert.equal(result.scores[1].platinumScore, 3100); assert.equal(result.scores[1].fullCombo, true); assert.equal(result.scores[1].fullBell, true);
  for (const level of [5, 11, 10.5, -1]) {
    const invalid = munetFixture(); invalid.userMusicDetailList[1].level = level;
    assert.throws(() => summarizeSave(invalid, 'json'), /成绩字段无效/);
  }
  const otherOwner = munetFixture(); otherOwner.userMusicDetailList[1].userId = 84;
  assert.throws(() => summarizeSave(otherOwner, 'json'), /多位玩家/);
});

test('inventory preserves per-kind stock, zero/missing quantities and unique card count without adding repeated pages', () => {
  const raw = { userData: { userName: 'Fixture', jewelCount: 10, medalCount: 0, shizukuCount: 3 }, userCardList: [{ cardId: 5, digitalStock: 10 }, { cardId: 5 }, { cardId: 6 }], pages: [
    { itemKind: 13, userItemList: [{ itemId: 1, stock: 9 }, { itemId: 2, stock: -1 }] },
    { itemKind: 13, userItemList: [{ itemId: 1, stock: 3 }] },
    { userItemList: [{ itemKind: 14, itemId: 1, stock: 0, isValid: false }, { itemKind: 11, itemId: 99, name: 'Imported ticket' }] }
  ] };
  const result = summarizeSave(raw, 'json');
  const item = (kind, id) => result.inventory.items.find(item => item.itemKind === kind && item.itemId === id);
  assert.equal(result.inventory.cardCount, 2);
  assert.equal(result.inventory.itemsRecorded, true);
  assert.equal(item(13, 1).stock, 3);
  assert.equal(item(13, 2).stock, undefined);
  assert.equal(item(14, 1).stock, 0); assert.equal(item(14, 1).isValid, false);
  assert.equal(item(11, 99).stock, undefined); assert.equal(item(11, 99).name, 'Imported ticket');
  assert.equal(item(5, 0).stock, 10); assert.equal(item(18, 0).stock, 0); assert.equal(item(21, 0).stock, 3);
  assert.ok(result.warnings.some(value => value.includes('字段无效')));
  assert.deepEqual(summarizeSave({ summary: result, raw }, 'json').inventory, result.inventory);
  assert.equal(summarizeSave({ userItemList: [], userCardList: [] }, 'json').inventory.cardCount, 0);
  assert.equal(summarizeSave([score], 'json').inventory.cardCount, undefined);
  assert.equal(summarizeSave({ items: [{ itemKind: 4, itemId: 1, quantity: '2' }] }, 'json').inventory.items[0].stock, 2);
});

test('older archives derive inventory without rewriting files, names follow compatible packages and item-kind namespaces', async t => {
  const root = await temporary(t), gameData = path.join(root, 'mu3_Data', 'StreamingAssets', 'GameData');
  async function metadata(parent, id, major, minor, category, file, text) {
    const pkg = path.join(parent, id); await fsp.mkdir(path.join(pkg, category, 'arbitrary-folder'), { recursive: true });
    await fsp.writeFile(path.join(pkg, 'DataConfig.xml'), `<DataConfig><version><major>${major}</major><minor>${minor}</minor></version></DataConfig>`);
    await fsp.writeFile(path.join(pkg, category, 'arbitrary-folder', file), `<ItemData><Name><id>1</id><str>${text}</str></Name></ItemData>`);
  }
  await metadata(gameData, 'A000', 1, 50, 'expupitem', 'ExpUpItem.xml', 'Base');
  await metadata(path.join(root, 'option'), 'A001', 1, 50, 'expupitem', 'ExpUpItem.xml', '强化 &amp; 小');
  await metadata(gameData, 'A001', 1, 50, 'expupitem', 'ExpUpItem.xml', 'Duplicate must not win');
  await metadata(path.join(root, 'option'), 'A999', 1, 60, 'expupitem', 'ExpUpItem.xml', 'Wrong version');
  await metadata(path.join(root, 'option'), 'AOMN', 1, 50, 'intimateupitem', 'IntimateUpItem.xml', '<![CDATA[亲密度 <小>]]>');
  const saved = await persistSave(root, { ...fixture, userItemList: [{ itemKind: 13, itemId: 1, stock: 2 }, { itemKind: 14, itemId: 1, stock: 3 }, { itemKind: 99, itemId: 8, stock: 1 }] }, 'game');
  const file = path.join(saveDirectory(root), 'archives', `${saved.id}.json`), archive = JSON.parse(await fsp.readFile(file, 'utf8'));
  delete archive.summary.inventory; archive.summary.sessionId = session; archive.summary.updatedAt = '2026-01-01T00:00:00.000Z';
  const before = JSON.stringify(archive); await fsp.writeFile(file, before);
  const [loaded] = await listSaves(root);
  assert.equal(loaded.id, saved.id); assert.equal(loaded.sessionId, session); assert.equal(loaded.updatedAt, archive.summary.updatedAt);
  assert.equal(loaded.inventory.cardCount, 1);
  assert.deepEqual(loaded.inventory.items.map(item => [item.itemKind, item.name, item.stock]), [[13, '强化 & 小', 2], [14, '亲密度 <小>', 3], [99, undefined, 1]]);
  assert.equal(await fsp.readFile(file, 'utf8'), before);
  assert.deepEqual((await listSaves(root))[0].inventory, loaded.inventory);
  const other = await temporary(t);
  await persistSave(other, { ...fixture, userItemList: [{ itemKind: 13, itemId: 1, stock: 1 }] }, 'json');
  assert.equal((await listSaves(other))[0].inventory.items[0].name, undefined);
});
test('duplicate difficulties retain independent best scores and flags', () => {
  const result = summarizeSave([score, { ...score, techScoreMax: 900000, battleScoreMax: 2000000, isFullBell: true }], 'json');
  assert.equal(result.scores.length, 1); assert.equal(result.scores[0].techScore, 1005000);
  assert.equal(result.scores[0].battleScore, 2000000); assert.equal(result.scores[0].fullBell, true);
});
test('reject malformed, unrelated and mixed-player files, ignore rivals', () => {
  assert.throws(() => parseSave('{broken'), /JSON/);
  assert.throws(() => summarizeSave({ musicId: 1, name: 'song' }, 'json'), /未识别/);
  assert.throws(() => summarizeSave([ { userId: 1, ...score }, { userId: 2, ...score } ], 'json'), /多位玩家/);
  assert.throws(() => summarizeSave([{ ...score, level: 9 }], 'json'), /无效/);
  assert.equal(summarizeSave({ ...fixture, userRivalMusicList: [{ userId: 99, ...score }] }, 'json').scores.length, 1);
});

test('validated API envelopes own their payload, not extra userId metadata on score rows', () => {
  const page = event();
  page.response.userMusicList[0].userMusicDetailList = [{ ...score, userId: 7001 }, { ...score, musicId: 102, userId: 7002 }];
  const raw = { format: 'ogk-player-save-v1', events: [page] };
  for (const source of ['direct', 'game', 'json']) {
    const summary = summarizeSave(raw, source);
    assert.deepEqual(summary.scores.map(item => item.musicId), [101, 102]);
    assert.equal(summary.scores[0].techScore, score.techScoreMax);
    assert.deepEqual(summarizeSave({ summary, raw }, 'json').scores, summary.scores);
  }
  // Unwrapped imports have no independently checked protocol owner.
  assert.throws(() => summarizeSave(page.response.userMusicList[0].userMusicDetailList, 'json'), /多位玩家/);
});

test('API envelope validation rejects mismatched or mixed owners without creating an archive', async t => {
  const root = await temporary(t);
  const mismatched = event(); mismatched.response.userId = 84;
  const other = event(); other.request.userId = 84; other.response.userId = 84;
  await assert.rejects(persistSave(root, { events: [mismatched] }, 'direct'), /身份不匹配/);
  await assert.rejects(persistSave(root, { events: [event(), other] }, 'game'), /多位玩家/);
  const invalid = event(); invalid.request.userId = 0; invalid.response.userId = 0;
  await assert.rejects(persistSave(root, { events: [invalid] }, 'json'), /身份不匹配/);
  assert.deepEqual(await listSaves(root), []);
});
test('failed import does not replace earlier archives; originals survive', async t => {
  const root = await temporary(t); const saved = await persistSave(root, fixture, 'json');
  await assert.rejects(persistSave(root, { unrelated: true }, 'json'));
  assert.equal((await listSaves(root)).length, 1);
  const data = JSON.parse(await fsp.readFile(path.join(saveDirectory(root), 'archives', `${saved.id}.json`), 'utf8'));
  assert.deepEqual(data.raw, fixture);
});
test('capture checks continuity, deduplicates retry pages, rejects identity mismatch', async t => {
  const root = await temporary(t); await capture(root, [event(0, 100), event(100, -1), event(0, 100)]);
  const events = await captureEvents(root, session); assert.equal(events.length, 2);
  assert.ok(!captureWarnings(events).some(w => w.startsWith('Music')));
  assert.ok(captureWarnings([event(100, -1)]).some(w => /分页未收齐/.test(w)));
  await syncCaptures(root); const before = await listSaves(root); await syncCaptures(root);
  assert.equal((await listSaves(root))[0].updatedAt, before[0].updatedAt);
  const bad = event(); bad.response.userId = 99; await capture(root, [bad]);
  await assert.rejects(captureEvents(root, session), /身份不匹配/);
});
test('outside-game reader follows pages, cancellation and cycles never publish partial data', async t => {
  const root = await temporary(t); await capture(root, [event()]);
  const calls = [];
  const result = await refreshFromGame(root, session, undefined, async (seed, request) => { calls.push(request.nextIndex); return event(request.nextIndex, request.nextIndex === 0 ? 100 : -1).response; });
  assert.deepEqual(calls, [0, 100]); assert.equal(result.source, 'direct');
  const count = (await listSaves(root)).length;
  await assert.rejects(refreshFromGame(root, session, undefined, async () => event(0, 100).response), /分页没有结束/);
  await assert.rejects(refreshFromGame(root, session, AbortSignal.abort()), /取消/);
  assert.equal((await listSaves(root)).length, count);
});
test('outside-game reads normalize LUNATIC while archived protocol responses retain level 10', async t => {
  const root = await temporary(t), seed = event();
  seed.response.userMusicList[0].userMusicDetailList = [{ ...score, level: 10 }];
  const saved = await refreshFromRequests(root, [seed], undefined, async () => seed.response);
  assert.equal(saved.source, 'direct'); assert.equal(saved.scores[0].difficulty, 4);
  const archive = JSON.parse(await fsp.readFile(path.join(saveDirectory(root), 'archives', saved.id + '.json'), 'utf8'));
  assert.equal(archive.raw.events[0].response.userMusicList[0].userMusicDetailList[0].level, 10);
});
test('item categories use encoded initial cursors; zero terminates a page stream', async t => {
  const root = await temporary(t);
  const item = kind => ({ ...event(), api: 'GetUserItemApi', request: { userId: 42, nextIndex: kind * 10000000000, maxCount: 100 }, response: { userId: 42, nextIndex: 0, itemKind: kind, userItemList: [{ itemId: 1 }] } });
  await capture(root, [item(2), item(3)]);
  const events = await captureEvents(root, session);
  assert.ok(!captureWarnings(events).some(w => w.startsWith('Item')));
  const requests = [];
  await refreshFromGame(root, session, undefined, async (seed, request) => { requests.push(request.nextIndex); return seed.response; });
  assert.deepEqual(requests, [20000000000, 30000000000]);
});
test('HTTP adapter uses game POST/deflate and refuses redirects, encryption and different player', async t => {
  let mode = 'ok'; let received;
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      received = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(zlib.inflateSync(Buffer.concat(chunks))) };
      if (mode === 'redirect') { res.writeHead(302, { Location: 'http://invalid.invalid/' }); res.end(); return; }
      res.writeHead(200, { 'Content-Encoding': 'deflate' });
      res.end(zlib.deflateSync(Buffer.from(JSON.stringify({ userId: mode === 'wrong' ? 9 : 42, nextIndex: -1, userMusicList: [] }))));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const seed = event(); seed.connection.baseUrl = `http://127.0.0.1:${server.address().port}/ongeki/`;
  await readGameApi(seed, seed.request); assert.equal(received.method, 'POST'); assert.equal(received.url, '/ongeki/GetUserMusicApi'); assert.equal(received.body.userId, 42); assert.ok(Number.isInteger(received.body.nonce_));
  mode = 'wrong'; await assert.rejects(readGameApi(seed, seed.request), error => error.diagnostic?.api === 'GetUserMusicApi' && error.diagnostic.stage === 'identity' && error.diagnostic.reason === 'identity_mismatch');
  mode = 'redirect'; await assert.rejects(readGameApi(seed, seed.request), /HTTP 302/);
  seed.connection.encryptVersion = 1; await assert.rejects(readGameApi(seed, seed.request), /加密/);
});
test('own connection validates server, keychip and card independently of captures', () => {
  const input = validatePlayerConnection({ ...ownConnection, accessCode: '12345 67890-12345 67890' });
  assert.equal(input.keychipShort, 'A1234567890'); assert.equal(input.accessCode, ownConnection.accessCode);
  assert.equal(input.server.origin, 'http://server.invalid'); assert.equal(input.aimePort, 22345);
  for (const server of ['file:///tmp/file', 'https://user:secret@server.invalid/', 'https://server.invalid/path']) assert.throws(() => validatePlayerConnection({ ...ownConnection, server }), /服务器/);
  assert.throws(() => validatePlayerConnection({ ...ownConnection, keychip: 'bad' }), /Keychip/);
  assert.throws(() => validatePlayerConnection({ ...ownConnection, accessCode: '12' }), /20 位/);
  assert.equal(parseCardLookup(cardResponse(42)), 42);
  assert.throws(() => parseCardLookup(cardResponse(0xffffffff)), /尚未注册/);
  assert.throws(() => parseCardLookup(cardResponse(42, 0x06)), /未接受/);
  assert.throws(() => parseCardLookup(Buffer.alloc(15)), /不完整/);
});
test('load only local connection configuration and card file, without writing them', async t => {
  const root = await temporary(t); await fsp.mkdir(path.join(root, 'cards'));
  await assert.rejects(playerConnectionDefaults(root), /无法读取 segatools.ini/);
  const ini = '\ufeff[DNS]\r\nDefault=server.invalid\r\n;AimeDB=ignored.invalid\r\nAimeDB=card.invalid\r\n[KEYCHIP]\r\nID=A123-45678901234\r\n[Aime]\r\nAimePath="cards\\own.txt"\r\n';
  await fsp.writeFile(path.join(root, 'segatools.ini'), ini); await fsp.writeFile(path.join(root, 'cards', 'own.txt'), ownConnection.accessCode);
  assert.deepEqual(await playerConnectionDefaults(root), { ...ownConnection, aimeServer: 'card.invalid' });
  assert.equal(await fsp.readFile(path.join(root, 'segatools.ini'), 'utf8'), ini);
  await fsp.rm(path.join(root, 'cards', 'own.txt'));
  assert.equal((await playerConnectionDefaults(root)).accessCode, '');
  assert.equal(fs.existsSync(saveDirectory(root)), false);
});

test('only Nageki may omit its keychip and uses the public Segatools identity in the card request', () => {
  for (const server of ['nageki-net.com', 'NAGEKI-NET.COM', 'http://nageki-net.com/', 'https://nageki-net.com./']) {
    const input = { ...ownConnection, server, keychip: '  ' };
    assert.equal(validatePlayerConnection(input).keychipShort, 'A69E01A8888');
    const packet = aimeCipher(createCardLookup(input, 321), false);
    assert.equal(packet.subarray(20, 31).toString('ascii'), 'A69E01A8888');
    assert.equal(packet.subarray(32, 42).toString('hex'), ownConnection.accessCode);
  }
  for (const server of ['server.invalid', 'nageki-net.com.evil.invalid', 'not-nageki-net.com', '127.0.0.1']) {
    assert.throws(() => validatePlayerConnection({ ...ownConnection, server, keychip: '' }), /Keychip/);
  }
  assert.equal(validatePlayerConnection({ ...ownConnection, server: 'nageki-net.com' }).keychipShort, 'A1234567890');
  assert.throws(() => validatePlayerConnection({ ...ownConnection, server: 'nageki-net.com', keychip: 'bad' }), /Keychip/);
  assert.throws(() => validatePlayerConnection({ ...ownConnection, server: 'nageki-net.com', keychip: '', accessCode: '' }), /20 位/);
});

test('Nageki blank, absent and commented keychips reach discovery and save reads without changing INI or card', async t => {
  const root = await temporary(t), requests = [];
  const apiServer = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      assert.equal(req.url, '/sys/servlet/PowerOn');
      const fields = new URLSearchParams(zlib.inflateSync(Buffer.from(Buffer.concat(chunks).toString(), 'base64')).toString());
      requests.push(fields.get('serial'));
      res.end('stat=1&place_id=321&uri=http://fixture.invalid/ongeki/');
    });
  });
  await new Promise(resolve => apiServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => apiServer.close(resolve)));
  // Redirect only the test transport into loopback; the real validation and discovery receive Nageki + empty keychip.
  const originalRequest = http.request;
  t.mock.method(http, 'request', (url, options, callback) => {
    assert.equal(url.hostname, 'nageki-net.com');
    return originalRequest.call(http, new URL(`http://127.0.0.1:${apiServer.address().port}${url.pathname}`), options, callback);
  });
  const services = {
    discover: discoverPlayerServer,
    lookup: async (input, place) => { assert.equal(input.keychip, ''); assert.equal(place, 321); assert.equal(validatePlayerConnection(input).keychipShort, 'A69E01A8888'); return 42; },
    read: async (seed, request) => {
      assert.equal(request.userId, 42);
      if (seed.api === 'GetUserDataApi') return { userId: 42, userData: { userName: 'Nageki fixture' } };
      if (seed.api === 'GetUserMusicApi') return { userId: 42, nextIndex: 0, userMusicList: [{ userMusicDetailList: [score] }] };
      if (seed.api === 'GetUserOptionApi') return { userId: 42, userOption: {} };
      if (seed.api === 'GetUserActivityApi') return { userId: 42, kind: 2, userActivityList: [] };
      const key = { GetUserCardApi: 'userCardList', GetUserCharacterApi: 'userCharacterList', GetUserItemApi: 'userItemList' }[seed.api];
      assert.ok(key); return { userId: 42, nextIndex: 0, [key]: [] };
    }
  };
  const cardFile = path.join(root, 'card.txt'); await fsp.writeFile(cardFile, ownConnection.accessCode);
  for (const keychipSection of ['', '[keychip]\n;id=A123-45678901234\n', '[keychip]\nid=\n']) {
    const ini = `[dns]\ndefault=nageki-net.com\n[aime]\naimePath=card.txt\n${keychipSection}`;
    await fsp.writeFile(path.join(root, 'segatools.ini'), ini);
    const defaults = await playerConnectionDefaults(root);
    assert.equal(defaults.keychip, '');
    const result = await fetchPlayerFromConfiguration(root, defaults, undefined, services);
    assert.equal(result.scores[0].techScore, score.techScoreMax);
    assert.equal(await fsp.readFile(path.join(root, 'segatools.ini'), 'utf8'), ini);
    assert.equal(await fsp.readFile(cardFile, 'utf8'), ownConnection.accessCode);
  }
  assert.deepEqual(requests, ['A69E01A8888', 'A69E01A8888', 'A69E01A8888']);
  assert.equal((await listSaves(root)).length, 1); // Identical results from the three empty-keychip forms reuse one snapshot.
});
test('fresh install discovers endpoint and resolves each own card, reads paged saves without module or captured identity', async t => {
  const root = await temporary(t); let responseId = 42, returnUnknownCard = false, mode = 'normal';
  const allnetRequests = [], cardRequests = [], gameRequests = [];
  const sockets = new Set();
  const cardServer = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let packet = Buffer.alloc(0);
    socket.on('data', chunk => {
      packet = Buffer.concat([packet, chunk]); if (packet.length < 48) return;
      assert.equal(packet.length, 48); const decoded = aimeCipher(packet, false);
      cardRequests.push({ command: decoded.readUInt16LE(4), card: decoded.subarray(32, 42).toString('hex'), keychip: decoded.subarray(20, 31).toString('ascii'), place: decoded.readUInt32LE(16) });
      const result = cardResponse(returnUnknownCard ? 0xffffffff : responseId);
      socket.write(result.subarray(0, 7)); setTimeout(() => socket.end(result.subarray(7)), 5);
    });
  });
  const apiServer = http.createServer((req, res) => {
    const chunks = []; req.on('data', b => chunks.push(b)); req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.url === '/sys/servlet/PowerOn') {
        allnetRequests.push(Object.fromEntries(new URLSearchParams(zlib.inflateSync(Buffer.from(body.toString(), 'base64')).toString())));
        if (mode === 'redirect') { res.writeHead(302, { Location: 'http://unrelated.invalid/' }); res.end(); return; }
        const text = `stat=1&place_id=321&uri=http://127.0.0.1:${apiServer.address().port}/discovered/`;
        res.setHeader('Pragma', 'DFI'); res.end(zlib.deflateSync(Buffer.from(text)).toString('base64')); return;
      }
      const request = JSON.parse(zlib.inflateSync(body)), api = req.url.split('/').at(-1);
      gameRequests.push({ api, request }); assert.equal(request.userId, responseId);
      const response = { userId: responseId };
      if (api === 'GetUserDataApi') response.userData = { userName: 'Fixture', userId: responseId };
      else if (api === 'GetUserOptionApi') response.userOption = {};
      else if (api === 'GetUserActivityApi') { response.kind=2; response.userActivityList=[{kind:2,id:1,sortNumber:1750000000}]; }
      else {
        response.nextIndex = 0;
        if (api === 'GetUserMusicApi') { response.userMusicList = [{ userMusicDetailList: [{ ...score, userId: responseId + 1000, musicId: request.nextIndex === 0 ? 1 : 2 }] }]; response.nextIndex = request.nextIndex === 0 ? 100 : 0; }
        else if (api === 'GetUserCardApi') response.userCardList = [];
        else if (api === 'GetUserCharacterApi') response.userCharacterList = [];
        else if (api === 'GetUserItemApi') { response.userItemList = []; response.itemKind = request.nextIndex / 10000000000; }
        else assert.fail(`Unexpected write or unsupported API: ${api}`);
      }
      res.setHeader('Content-Encoding', 'deflate'); res.end(zlib.deflateSync(Buffer.from(JSON.stringify(response))));
    });
  });
  await Promise.all([new Promise(r => cardServer.listen(0, '127.0.0.1', r)), new Promise(r => apiServer.listen(0, '127.0.0.1', r))]);
  t.after(async () => { sockets.forEach(s => s.destroy()); await Promise.all([new Promise(r => cardServer.close(r)), new Promise(r => apiServer.close(r))]); });
  const input = { ...ownConnection, server: `127.0.0.1:${apiServer.address().port}`, aimeServer: `127.0.0.1:${cardServer.address().port}` };
  const localIni = keychip => `[dns]\ndefault=${input.server}\nAimeDB=${input.aimeServer}\n[keychip]\nid=${keychip}\n[aime]\naimePath=own-card.txt\n`;
  await fsp.writeFile(path.join(root, 'segatools.ini'), localIni(input.keychip));
  await fsp.writeFile(path.join(root, 'own-card.txt'), ownConnection.accessCode);
  const defaults = await playerConnectionDefaults(root);
  const first = await fetchPlayerFromConfiguration(root, { ...await playerConnectionDefaults(root), accessCode: defaults.accessCode });
  assert.deepEqual(first.scope, { serverId: serverIdentity(input.server, input.aimeServer).id, cardId: cardIdentity(defaults.accessCode) });
  assert.equal(first.recentPlays[0].musicId, 1); assert.equal(first.recentPlays[0].difficulty, undefined);
  assert.equal(first.scores.length, 2); assert.equal(first.source, 'direct'); assert.equal(first.sessionId, undefined);
  assert.equal(fs.existsSync(path.join(saveDirectory(root), 'captures')), false);
  assert.equal(fs.existsSync(path.join(root, 'BepInEx')), false);
  assert.equal(cardRequests[0].command, 0x0f); assert.equal(cardRequests[0].card, ownConnection.accessCode);
  assert.equal(cardRequests[0].keychip, 'A1234567890'); assert.equal(cardRequests[0].place, 321);
  assert.equal(allnetRequests[0].serial, 'A1234567890'); assert.equal(allnetRequests[0].game_id, 'SDDT');
  assert.deepEqual(gameRequests.filter(r => r.api === 'GetUserMusicApi').map(r => r.request.nextIndex), [0, 100]);
  assert.equal(gameRequests.filter(r => r.api === 'GetUserItemApi').length, 14);
  responseId = 84;
  // Each fetch rereads the game configuration, while the manual card applies only to this fetch.
  const changedIni = localIni('B456-78901234567');
  await fsp.writeFile(path.join(root, 'segatools.ini'), changedIni);
  await fetchPlayerFromConfiguration(root, { ...await playerConnectionDefaults(root), accessCode: '98765432109876543210' });
  assert.equal(cardRequests[1].keychip, 'B4567890123'); assert.equal(cardRequests[1].card, '98765432109876543210');
  assert.equal(allnetRequests[1].serial, 'B4567890123');
  assert.equal(await fsp.readFile(path.join(root, 'segatools.ini'), 'utf8'), changedIni);
  assert.equal(await fsp.readFile(path.join(root, 'own-card.txt'), 'utf8'), ownConnection.accessCode);
  const before = await listSaves(root), gameCount = gameRequests.length; returnUnknownCard = true;
  await assert.rejects(fetchPlayerFromConfiguration(root, { ...await playerConnectionDefaults(root), accessCode: defaults.accessCode }), /尚未注册/);
  assert.equal(gameRequests.length, gameCount); assert.equal((await listSaves(root)).length, before.length);
  mode = 'redirect'; await assert.rejects(discoverPlayerServer(input), /HTTP 302/);
  assert.equal(cardRequests.length, 3);
});
test('card lookup cancellation stops an unresponsive connection', async t => {
  const sockets = new Set(); const server = net.createServer(s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { sockets.forEach(s => s.destroy()); await new Promise(r => server.close(r)); });
  const abort = new AbortController(), input = { ...ownConnection, aimeServer: `127.0.0.1:${server.address().port}` };
  const request = lookupPlayerCard(input, 0, abort.signal); abort.abort();
  await assert.rejects(request, /取消/);
});

const { importManagedPlayerSave, deleteManagedPlayerSaves, playerProfiles, addPlayerCard, reorderPlayerCards, scopedPlayerSaves, requirePlayerScope, bindPlayerSave, refreshManagedPlayerSave, fetchManagedPlayerSave } = load('player-profiles');
const { cardIdentity, serverIdentity, saveOwnerKey } = load('player-identity');
const importMachineA = { dns: { default: 'server-a.invalid', AimeDB: '', replaceHost: '0' }, netenv: { enable: '1' }, keychip: { id: 'A123-45678901234', subnet: '192.168.162.0' } };
const importMachineB = { dns: { default: 'server-b.invalid', AimeDB: 'card-b.invalid', replaceHost: '1' }, netenv: { enable: '0' }, keychip: { id: 'B234-56789012345', subnet: '192.168.99.0' } };
const { importedSaveSource } = load('player-import-source');
const { deletePlayerProfile, saveMachineProfile, savePlayerProfile, selectPlayerProfile } = load('machine-profiles');
test('import source uses explicit snapshots over historical metadata and exposes only source drafts otherwise', () => {
  const raw = {...munetFixture(), machine: importMachineB}; raw.userData.lastClientId = 'C3456789012';
  const before = JSON.stringify(raw), source = importedSaveSource(raw);
  assert.deepEqual(source.machine, importMachineB); assert.equal(source.machineComplete, true); assert.equal(JSON.stringify(raw), before);
  const partial = {...munetFixture()}; partial.userData.lastClientId = 'C3456789012';
  const result = importedSaveSource(partial);
  assert.equal(result.machineComplete, false); assert.equal(result.machine.keychip.id, 'C3456789012');
  assert.equal(result.machine.dns.default, ''); assert.equal(result.machine.keychip.subnet, '');
  const updated = structuredClone(partial); updated.userMusicDetailList[0].techScoreMax++;
  assert.equal(importedSaveSource(updated).machineKey, result.machineKey); assert.equal(importedSaveSource(updated).playerKey, result.playerKey);
  updated.userData.id = 84; assert.notEqual(importedSaveSource(updated).playerKey, result.playerKey);
});
test('invalid or ambiguous source evidence cannot silently adopt the current machine', () => {
  assert.throws(() => importedSaveSource({...fixture, machine:{...importMachineA, dns:{...importMachineA.dns, extra:'bad'}}}), /配置无效/);
  assert.throws(() => importedSaveSource({...fixture, machine:importMachineA, machineSnapshot:importMachineB}), /不一致/);
  const a = event(), b = event(); b.connection.baseUrl = 'http://different.invalid/ongeki/';
  assert.throws(() => importedSaveSource({events:[a,b]}), /多个服务器/);
  a.connection.baseUrl = 'http://user:secret@invalid.invalid/ongeki/';
  assert.throws(() => importedSaveSource({events:[a]}), /地址无效/);
});
async function profileRoot(t) {
  const root = await temporary(t);
  await fsp.writeFile(path.join(root, 'segatools.ini'), '[dns]\ndefault=server-a.invalid\n[keychip]\nid=A123-45678901234\n[aime]\naimePath=card.txt');
  await fsp.writeFile(path.join(root, 'card.txt'), ownConnection.accessCode);
  return root;
}
async function clearPlayerRoster(root) {
  const state = await playerProfiles(root);
  for (const player of state.players) await deletePlayerProfile(root, state.cards, player.id);
  assert.equal((await playerProfiles(root)).players.length, 0);
  return state;
}

test('without any players MuNET import creates a pending source player and retains raw level 10 without copying current configuration', async t => {
  const root = await profileRoot(t), state = await playerProfiles(root), dir = saveDirectory(root);
  await clearPlayerRoster(root);
  const files = [path.join(root, 'segatools.ini'), path.join(root, 'card.txt'), path.join(dir, 'profiles.json')];
  const before = await Promise.all(files.map(file => fsp.readFile(file)));
  const raw = munetFixture(); raw.userData.lastClientId = 'C3456789012'; const original = JSON.stringify(raw);
  const saved = await importManagedPlayerSave(root, raw, state.server.id);
  assert.equal(saved.source, 'json'); assert.equal(saved.scope, undefined); assert.equal(saved.serverId, undefined); assert.ok(saved.localPlayerId);
  assert.equal(saved.scores[1].difficulty, 4);
  const archive = JSON.parse(await fsp.readFile(path.join(dir, 'archives', saved.id + '.json'), 'utf8'));
  assert.deepEqual(archive.raw, raw); assert.equal(archive.raw.userMusicDetailList[1].level, 10);
  assert.equal(JSON.stringify(raw), original);
  assert.deepEqual(await Promise.all(files.map(file => fsp.readFile(file))), before);
  assert.equal((await listSaves(root)).length, 1);
  const next = await playerProfiles(root), player = next.players.find(player => player.id === saved.localPlayerId), machine = next.machines.find(machine => machine.id === player.machineId);
  assert.equal(next.players.length, 1); assert.equal(next.machines.length, 2); assert.equal(next.cards.length, 1);
  assert.equal(player.name, 'MuNET Fixture'); assert.equal(player.cardId, ''); assert.deepEqual(player.importedSaveIds, [saved.id]);
  assert.equal(machine.values.keychip.id, 'C3456789012'); assert.equal(machine.values.dns.default, ''); assert.equal(machine.values.keychip.subnet, '');
  assert.equal(next.activeMachineId, state.activeMachineId); assert.equal(next.selectedPlayerId, player.id);
  const repeated = await importManagedPlayerSave(root, raw, null);
  assert.equal(repeated.localPlayerId, player.id); assert.notEqual(repeated.id, saved.id);
  assert.equal((await playerProfiles(root)).players.length, 1);
  const rows = await scopedPlayerSaves(root); assert.ok(rows.every(save => save.localPlayerId === player.id));
  await assert.rejects(deleteManagedPlayerSaves(root, [saved.id], {localPlayerId: state.selectedPlayerId}), /玩家已变化/);
  await assert.rejects(deleteManagedPlayerSaves(root, [saved.id], null), /分组已变化/);
  await deleteManagedPlayerSaves(root, [saved.id], {localPlayerId: player.id}); assert.equal((await listSaves(root)).length, 1);
});
test('card profiles retain defaults, deduplicate concurrent additions and persist order without changing game configuration', async t => {
  const root = await profileRoot(t), ini = await fsp.readFile(path.join(root, 'segatools.ini'));
  const first = await playerProfiles(root); assert.equal(first.cards.length, 1); assert.equal(first.server.label, 'server-a.invalid');
  const other = '98765432109876543210';
  const [second, duplicate] = await Promise.all([addPlayerCard(root, other), addPlayerCard(root, '9876 5432 1098 7654 3210')]);
  assert.equal(second, duplicate);
  await reorderPlayerCards(root, [second, first.cards[0].id]);
  assert.deepEqual((await playerProfiles(root)).cards.map(c => c.id), [second, first.cards[0].id]);
  assert.equal((await playerProfiles(root)).defaultCardId, first.cards[0].id);
  await assert.rejects(reorderPlayerCards(root, [second, second]), /列表已变化/);
  await assert.rejects(addPlayerCard(root, '123'), /20 位/);
  assert.deepEqual(await fsp.readFile(path.join(root, 'segatools.ini')), ini);
  assert.equal(await fsp.readFile(path.join(root, 'card.txt'), 'utf8'), ownConnection.accessCode);
  assert.deepEqual((await playerProfiles(await temporary(t))).cards, []);
});
test('save ownership isolates cards and servers; legacy archives remain unassigned unless exact owner evidence is unambiguous', async t => {
  const root = await profileRoot(t), profiles = await playerProfiles(root);
  const scopeA = { cardId: profiles.cards[0].id, serverId: profiles.server.id };
  const scopeB = { cardId: await addPlayerCard(root, '98765432109876543210'), serverId: profiles.server.id };
  const serverB = { ...scopeA, serverId: serverIdentity('server-b.invalid').id };
  const raw = { events: [event()] };
  await persistSave(root, raw, 'game', 'legacy');
  await persistSave(root, fixture, 'json', 'imported');
  assert.ok((await scopedPlayerSaves(root)).every(save => !save.scope));
  await persistSave(root, raw, 'direct', 'direct-a', scopeA);
  const legacyFile = path.join(saveDirectory(root), 'archives', 'legacy.json'), original = await fsp.readFile(legacyFile);
  let saves = await scopedPlayerSaves(root);
  assert.deepEqual(saves.find(s => s.id === 'legacy').scope, scopeA);
  assert.equal(saves.find(s => s.id === 'imported').scope, undefined);
  const otherRaw = { events: [{ ...event(), connection: { ...event().connection, baseUrl: 'http://server-b.invalid/ongeki/' } }] };
  await persistSave(root, otherRaw, 'direct', 'other-server', serverB);
  const otherPlayer = { events: [{ ...event(), request: { ...event().request, userId: 84 }, response: { ...event().response, userId: 84 } }] };
  await persistSave(root, otherPlayer, 'direct', 'other-card', scopeB);
  saves = await scopedPlayerSaves(root);
  assert.deepEqual(saves.find(s => s.id === 'other-server').scope, serverB);
  assert.deepEqual(saves.find(s => s.id === 'other-card').scope, scopeB);
  // Same exact API/user claimed by two server profiles must not auto-assign an old archive.
  await persistSave(root, raw, 'direct', 'ambiguous', serverB);
  assert.equal((await scopedPlayerSaves(root)).find(s => s.id === 'legacy').scope, undefined);
  assert.deepEqual(await fsp.readFile(legacyFile), original);
  assert.equal(saveOwnerKey({ events: [event(), { ...event(), request: { userId: 84 } }] }), undefined);
  assert.equal(JSON.stringify(saves).includes(ownConnection.accessCode), false);
});
test('unassigned binding is explicit and preserves raw archives; stale server operations fail before network access', async t => {
  const root = await profileRoot(t), profiles = await playerProfiles(root), cardId = profiles.cards[0].id, serverId = profiles.server.id;
  await persistSave(root, fixture, 'json', 'unassigned');
  const file = path.join(saveDirectory(root), 'archives', 'unassigned.json'), before = await fsp.readFile(file);
  await bindPlayerSave(root, 'unassigned', cardId, serverId);
  assert.deepEqual((await scopedPlayerSaves(root))[0].scope, { cardId, serverId });
  await assert.rejects(bindPlayerSave(root, 'unassigned', cardId, serverId), /未分组/);
  assert.deepEqual(await fsp.readFile(file), before);
  await fsp.writeFile(path.join(root, 'segatools.ini'), '[dns]\ndefault=server-b.invalid');
  await assert.rejects(requirePlayerScope(root, cardId, serverId), /配置已变化/);
  await assert.rejects(fetchManagedPlayerSave(root, cardId, serverId), /配置已变化/);
  assert.notEqual((await playerProfiles(root)).server.id, serverId);
  assert.equal((await scopedPlayerSaves(root))[0].scope.serverId, serverId);
});
test('corrupt card management data is preserved and never silently replaced', async t => {
  const root = await profileRoot(t); await playerProfiles(root);
  const file = path.join(saveDirectory(root), 'profiles.json'); await fsp.writeFile(file, '{broken');
  await assert.rejects(playerProfiles(root), /原文件已保留/);
  await assert.rejects(addPlayerCard(root, '98765432109876543210'), /原文件已保留/);
  assert.equal(await fsp.readFile(file, 'utf8'), '{broken');
});
test('server grouping normalizes equivalent DNS and separates Aime endpoints and protocols', () => {
  assert.equal(serverIdentity('SERVER-A.invalid.').id, serverIdentity('http://server-a.invalid/').id);
  assert.equal(serverIdentity('server-a.invalid').id, serverIdentity('server-a.invalid', 'server-a.invalid:22345').id);
  assert.notEqual(serverIdentity('server-a.invalid').id, serverIdentity('https://server-a.invalid').id);
  assert.notEqual(serverIdentity('server-a.invalid').id, serverIdentity('server-a.invalid', 'card-b.invalid').id);
  assert.throws(() => serverIdentity('http://name:secret@server.invalid'), /配置无效/);
  assert.equal(cardIdentity('1234-5678-9012-3456-7890'), cardIdentity(ownConnection.accessCode));
});

test('managed refresh refuses another card, unassigned session and JSON archive before making game requests', async t => {
  const root = await profileRoot(t), profiles = await playerProfiles(root), cardId = profiles.cards[0].id, serverId = profiles.server.id;
  const otherId = await addPlayerCard(root, '98765432109876543210');
  await persistSave(root, { sessionId: session, events: [event()] }, 'game', 'own', { cardId, serverId });
  await assert.rejects(refreshManagedPlayerSave(root, 'own', otherId, serverId), /请选择/);
  await persistSave(root, fixture, 'json', 'imported');
  await bindPlayerSave(root, 'imported', cardId, serverId);
  await assert.rejects(refreshManagedPlayerSave(root, 'imported', cardId, serverId), /请选择/);
  await persistSave(root, { sessionId: 'b'.repeat(32), events: [{ ...event(), connection: undefined }] }, 'game', 'unknown');
  await assert.rejects(refreshManagedPlayerSave(root, 'unknown', cardId, serverId), /请选择/);
});

const { saveFingerprint } = load('player-save-fingerprint');
function completeSelectionCapture(at = '2030-01-01T00:00:00.000Z', sessionId = session) {
  const responses = [
    ['GetUserDataApi', { userData: { userName: 'TEST' } }],
    ['GetUserMusicApi', { nextIndex: 0, userMusicList: [{ userMusicDetailList: [score] }] }],
    ['GetUserCardApi', { nextIndex: 0, userCardList: [{ cardId: 1 }] }],
    ['GetUserCharacterApi', { nextIndex: 0, userCharacterList: [] }],
    ['GetUserItemApi', { nextIndex: 0, userItemList: [] }],
    ['GetUserOptionApi', { userOption: {} }]
  ];
  return { sessionId, events: responses.map(([api, response]) => ({ api, at, request: { userId: 42, nextIndex: 0 }, response: { userId: 42, ...response }, connection: event().connection })) };
}
test('capture selection revision is published only after all required read pages complete', async t => {
  const root = await temporary(t), id = `game-${session}`, raw = completeSelectionCapture();
  const partial = structuredClone(raw); partial.events.pop();
  const first = await persistSave(root, partial, 'game', id);
  assert.equal(first.latestCapture, undefined);
  raw.events[2].at = '2030-01-01T00:01:00.000Z';
  const completed = await persistSave(root, raw, 'game', id);
  assert.deepEqual(completed.latestCapture, { id, at: raw.events[2].at });
  assert.deepEqual((await listSaves(root))[0].latestCapture, completed.latestCapture);
  assert.equal((await listSaves(root)).length, 1);
});
test('a completed deduplicated Mod session retains the original archive and supplies a selection revision', async t => {
  const root = await temporary(t), raw = completeSelectionCapture(), first = await persistSave(root, raw, 'direct', 'retained');
  const file = path.join(saveDirectory(root), 'archives', 'retained.json'), original = JSON.parse(await fsp.readFile(file, 'utf8'));
  const completed = await persistSave(root, raw, 'game', `game-${session}`);
  assert.equal(completed.unchanged, true);
  assert.deepEqual(completed.latestCapture, { id: `game-${session}`, at: raw.events[0].at });
  for (const key of ['id', 'source', 'updatedAt', 'sequence']) assert.equal(completed[key], first[key]);
  const stored = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.deepEqual(stored.raw, original.raw); assert.equal(stored.fingerprint, original.fingerprint);
  assert.equal((await listSaves(root)).length, 1);
  const unchanged = await fsp.readFile(file);
  await persistSave(root, raw, 'game', `game-${session}`);
  assert.deepEqual(await fsp.readFile(file), unchanged);
});
test('a partial capture alias cannot mark a deduplicated complete archive as newly completed', async t => {
  const root = await temporary(t), complete = completeSelectionCapture();
  await persistSave(root, complete, 'direct', 'retained');
  const partial = structuredClone(complete); partial.events[1].response.nextIndex = 100;
  assert.equal(saveFingerprint(partial), saveFingerprint(complete));
  const result = await persistSave(root, partial, 'game', `game-${session}`);
  assert.equal(result.id, 'retained'); assert.equal(result.unchanged, true);
  assert.equal(result.latestCapture, undefined);
  assert.equal((await listSaves(root))[0].latestCapture, undefined);
  const completed = await persistSave(root, complete, 'game', `game-${session}`);
  assert.deepEqual(completed.latestCapture, { id: `game-${session}`, at: complete.events[0].at });
});
test('later completed revisions of the same archive advance once and stale session scans cannot regress them', async t => {
  const root = await temporary(t), old = completeSelectionCapture(), id = `game-${session}`;
  const first = await persistSave(root, old, 'game', id);
  const newer = completeSelectionCapture('2030-01-02T00:00:00.000Z');
  const next = await persistSave(root, newer, 'game', id);
  assert.equal(next.id, first.id); assert.equal(next.sequence, first.sequence); assert.equal(next.updatedAt, first.updatedAt);
  assert.deepEqual(next.latestCapture, { id, at: newer.events[0].at });
  const file = path.join(saveDirectory(root), 'archives', `${id}.json`), before = await fsp.readFile(file);
  await persistSave(root, old, 'game', id);
  assert.deepEqual(await fsp.readFile(file), before);
  const stale = completeSelectionCapture(old.events[0].at, 'b'.repeat(32));
  const replayed = await persistSave(root, stale, 'game', `game-${stale.sessionId}`);
  assert.deepEqual(replayed.latestCapture, next.latestCapture);
  assert.equal((await listSaves(root)).length, 1);
});
test('imported markers, mismatched sessions and invalid event dates do not confirm a Mod capture', async t => {
  const root = await temporary(t), raw = completeSelectionCapture();
  raw.latestCapture = { id: `game-${session}`, at: raw.events[0].at };
  assert.equal((await persistSave(root, raw, 'json', 'imported')).latestCapture, undefined);
  // Distinct response data prevents deduplication from inheriting archive metadata.
  raw.events[0].response.userData.userName = 'OTHER';
  assert.equal((await persistSave(root, raw, 'game', `game-${'b'.repeat(32)}`)).latestCapture, undefined);
  raw.events[0].at = 'not-a-date'; raw.events[0].response.userData.userName = 'INVALID DATE';
  assert.equal((await persistSave(root, raw, 'game', `game-${session}`)).latestCapture, undefined);
});
test('repeated fetch compares full player data, ignores transport changes and keeps snapshot id and time', async t => {
  const root = await profileRoot(t), profiles = await playerProfiles(root), scope = { cardId: profiles.cards[0].id, serverId: profiles.server.id };
  const raw = { events: [event(), { ...event(), api: 'GetUserCharacterApi', response: { userId: 42, nextIndex: 0, userCharacterList: [{ characterId: 1, level: 4 }] } }] };
  const first = await persistSave(root, raw, 'direct', 'first', scope), file = path.join(saveDirectory(root), 'archives', 'first.json');
  const original = await fsp.readFile(file);
  const same = structuredClone(raw); same.events.reverse(); same.events.forEach(e => { e.at = '2030-01-01T00:00:00Z'; e.connection.userAgent = 'different'; e.request.maxCount = 200; });
  const duplicate = await persistSave(root, same, 'direct', 'duplicate', scope);
  assert.equal(duplicate.unchanged, true); assert.equal(duplicate.id, first.id); assert.equal(duplicate.updatedAt, first.updatedAt);
  assert.deepEqual(await fsp.readFile(file), original); assert.equal((await listSaves(root)).length, 1);
  const changed = structuredClone(raw); changed.events[1].response.userCharacterList[0].level = 5;
  const second = await persistSave(root, changed, 'direct', 'changed', scope);
  assert.equal(second.unchanged, undefined); assert.equal((await listSaves(root)).length, 2);
  // Returning to an earlier state still creates a snapshot; comparison is against the latest, not all history.
  const returned = await persistSave(root, raw, 'direct', 'returned', scope);
  assert.equal(returned.unchanged, undefined); assert.equal((await listSaves(root)).length, 3);
  const otherScope = { ...scope, serverId: serverIdentity('other.invalid').id };
  assert.equal((await persistSave(root, raw, 'direct', 'other', otherScope)).unchanged, undefined);
});
test('real reads matching a local edit retain read provenance and leave export history intact', async t => {
  for (const source of ['direct', 'game']) {
    const root = await temporary(t), scope = { serverId: 'a'.repeat(64), cardId: 'b'.repeat(64) };
    const raw = completeSelectionCapture();
    const old = structuredClone(raw); old.events[1].response.userMusicList[0].userMusicDetailList[0].techScoreMax = 800000;
    await persistSave(root, old, 'direct', 'original', scope);
    const edited = { ...raw, saveEdit: { version: 1, parentId: 'original', playerId: 'player-a', createdAt: '2030-01-01T00:00:00Z', resources: [{ key: 'data:point', value: 100 }], scores: [] } };
    await persistSave(root, edited, 'json', 'local-edit', scope);
    const localFile = path.join(saveDirectory(root), 'archives', 'local-edit.json'), originalLocal = await fsp.readFile(localFile);
    assert.equal(saveFingerprint(edited), saveFingerprint(raw));
    const id = source === 'game' ? `game-${session}` : 'fresh-direct';
    const read = await persistSave(root, raw, source, id, scope);
    assert.equal(read.id, id); assert.equal(read.source, source); assert.equal(read.edit, undefined);
    if (source === 'game') assert.deepEqual(read.latestCapture, { id, at: raw.events[0].at });
    assert.deepEqual(await fsp.readFile(localFile), originalLocal);
    assert.equal((await listSaves(root)).length, 3);
    assert.equal((await persistSave(root, raw, source, id, scope)).unchanged, true);
    assert.equal((await listSaves(root)).length, 3);
  }
});

test('fingerprint preserves positional deck arrays and every resource, while normalizing keyed records', () => {
  const a = { events: [{ api: 'GetUserItemApi', response: { nextIndex: -1, userItemList: [{ itemId: 1, stock: 2 }, { itemId: 2, stock: 3 }] } }] };
  const b = structuredClone(a); b.events[0].response.userItemList.reverse(); b.events[0].response.nextIndex = 0;
  assert.equal(saveFingerprint(a), saveFingerprint(b));
  b.events[0].response.userItemList[0].stock++;
  assert.notEqual(saveFingerprint(a), saveFingerprint(b));
  assert.notEqual(saveFingerprint({ userDeck: [1, 2, 3] }), saveFingerprint({ userDeck: [3, 2, 1] }));
});
test('parallel identical fetches publish only one snapshot', async t => {
  const root = await profileRoot(t), profiles = await playerProfiles(root), scope = { cardId: profiles.cards[0].id, serverId: profiles.server.id };
  const [a, b] = await Promise.all([persistSave(root, {events:[event()]}, 'direct', 'parallel-a', scope), persistSave(root, {events:[event()]}, 'direct', 'parallel-b', scope)]);
  assert.equal(a.id, b.id); assert.equal(b.unchanged, true); assert.equal((await listSaves(root)).length, 1);
});
test('delete validates the whole selection and scope before removal, preserving cards and unrelated archives', async t => {
  const root = await profileRoot(t), profiles = await playerProfiles(root), scope = { cardId: profiles.cards[0].id, serverId: profiles.server.id };
  await persistSave(root, {events:[event()]}, 'direct', 'owned', scope);
  await persistSave(root, fixture, 'json', 'json');
  const profileFile = path.join(saveDirectory(root), 'profiles.json'), cards = await fsp.readFile(profileFile);
  await assert.rejects(deleteManagedPlayerSaves(root, ['owned', 'json'], scope), /分组已变化/);
  await assert.rejects(deleteManagedPlayerSaves(root, ['owned'], null), /分组已变化/);
  await assert.rejects(deletePlayerArchives(root, ['owned', 'absent']), /记录已变化/);
  await assert.rejects(deletePlayerArchives(root, ['../profiles']), /有效存档/);
  assert.equal((await listSaves(root)).length, 2);
  await deleteManagedPlayerSaves(root, ['owned'], scope);
  assert.deepEqual((await listSaves(root)).map(s=>s.id), ['json']);
  await deleteManagedPlayerSaves(root, ['json'], null);
  assert.equal((await listSaves(root)).length, 0);
  assert.deepEqual(await fsp.readFile(profileFile), cards);
});
test('deleted capture sessions cannot return after polling or restart, including deduplicated session aliases', async t => {
  const root = await temporary(t), firstId = `game-${session}`, secondId = `game-${'b'.repeat(32)}`;
  await capture(root, [event()]); await syncCaptures(root);
  const duplicate = await persistSave(root, { sessionId: 'b'.repeat(32), events: [event()] }, 'game', secondId);
  assert.equal(duplicate.id, firstId); assert.equal(duplicate.unchanged, true);
  await deletePlayerArchives(root, [firstId]);
  await capture(root, [event(), event(100, 0)]); await syncCaptures(root);
  assert.equal((await listSaves(root)).length, 0);
  assert.equal((await persistSave(root, {events:[event()]}, 'game', secondId)).ignored, true);
  assert.equal((await listSaves(root)).length, 0);
  // A genuinely new session is still allowed.
  await persistSave(root, {events:[event()]}, 'game', `game-${'c'.repeat(32)}`);
  assert.equal((await listSaves(root)).length, 1);
});

test('JSON import uses the selected local player and preserves foreign machine/card data only in the original raw', async t => {
  const root = await profileRoot(t), state = await playerProfiles(root), dir = saveDirectory(root);
  const files = [path.join(dir, 'profiles.json'), path.join(root, 'segatools.ini'), path.join(root, 'card.txt')], before = await Promise.all(files.map(file => fsp.readFile(file)));
  const raw = {...munetFixture(), machine: importMachineB, accessCode: '00123456789012345678'};
  const a = await importManagedPlayerSave(root, raw, state.server.id);
  assert.equal(a.localPlayerId, state.selectedPlayerId); assert.deepEqual(a.scope, {cardId: state.defaultCardId, serverId: state.server.id});
  assert.equal(a.serverId, state.server.id); assert.equal(a.scores[1].difficulty, 4);
  const archived = JSON.parse(await fsp.readFile(path.join(dir, 'archives', `${a.id}.json`), 'utf8'));
  assert.deepEqual(archived.raw, raw); assert.equal(archived.raw.userMusicDetailList[1].level, 10);
  const next = await playerProfiles(root);
  assert.deepEqual(next.machines, state.machines); assert.equal(next.players.length, state.players.length); assert.equal(next.cards.length, state.cards.length);
  assert.equal(next.selectedPlayerId, state.selectedPlayerId); assert.equal(next.activeMachineId, state.activeMachineId);
  assert.deepEqual(next.players[0], {...state.players[0], importedSaveIds: [a.id]});
  assert.deepEqual(await Promise.all(files.map(file => fsp.readFile(file))), before);
  assert.equal((await scopedPlayerSaves(root)).find(save => save.id === a.id).localPlayerId, state.selectedPlayerId);
  await assert.rejects(deleteManagedPlayerSaves(root, [a.id], null), /分组已变化/);
  await deleteManagedPlayerSaves(root, [a.id], {localPlayerId: state.selectedPlayerId});
  assert.equal((await listSaves(root)).length, 0);
});

async function alternateImportPlayer(root) {
  const state = await playerProfiles(root), cardId = await addPlayerCard(root, '98765432109876543210');
  const machine = await saveMachineProfile(root, (await playerProfiles(root)).cards, {name: '目标机台 B', values: importMachineB}, async () => { throw Error('local draft must not activate'); });
  const playerId = await savePlayerProfile(root, (await playerProfiles(root)).cards, {name: '明确目标 B', machineId: machine.id, cardId});
  return {state, cardId, machine, playerId};
}
test('explicit JSON destination overrides current selection without interpreting source machine or card metadata', async t => {
  const root = await profileRoot(t), target = await alternateImportPlayer(root), dir = saveDirectory(root);
  const before = await playerProfiles(root), gameFiles = [path.join(root, 'segatools.ini'), path.join(root, 'card.txt'), path.join(dir, 'profiles.json')];
  const bytes = await Promise.all(gameFiles.map(file => fsp.readFile(file)));
  const raw = {...fixture, accessCode: '00123456789012345678', machine: {dns: {default: 'file:///not-a-source-to-interpret'}}};
  const saved = await importManagedPlayerSave(root, raw, target.state.server.id, target.playerId);
  assert.equal(saved.localPlayerId, target.playerId); assert.deepEqual(saved.scope, {cardId: target.cardId, serverId: target.machine.server.id});
  assert.equal(saved.serverId, target.machine.server.id);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(dir, 'archives', `${saved.id}.json`))).raw, raw);
  const after = await playerProfiles(root), expected = structuredClone(before);
  expected.players.find(player => player.id === target.playerId).importedSaveIds = [saved.id];
  assert.deepEqual(after, expected); assert.deepEqual(await Promise.all(gameFiles.map(file => fsp.readFile(file))), bytes);
});

test('selection changed while a JSON archive is being written cannot migrate its initial destination', async t => {
  const root = await profileRoot(t), target = await alternateImportPlayer(root), before = await playerProfiles(root);
  let entered, release;
  const paused = new Promise(resolve => { entered = resolve; }), resume = new Promise(resolve => { release = resolve; });
  const originalWrite = fsp.writeFile, archiveDir = path.join(saveDirectory(root), 'archives'); let intercepted = false;
  fsp.writeFile = async function(file, ...args) {
    if (!intercepted && typeof file === 'string' && path.dirname(file) === archiveDir && file.endsWith('.tmp')) {
      intercepted = true; entered(); await resume;
    }
    return originalWrite.call(this, file, ...args);
  };
  let pending;
  try {
    pending = importManagedPlayerSave(root, fixture, before.server.id);
    const timer = new Promise((_, reject) => { const id = setTimeout(() => reject(Error('archive write pause was not reached')), 2000); paused.finally(() => clearTimeout(id)); });
    await Promise.race([paused, timer]);
    await selectPlayerProfile(root, before.cards, target.playerId);
    release();
    const saved = await pending;
    assert.equal(saved.localPlayerId, before.selectedPlayerId); assert.deepEqual(saved.scope, {cardId: before.defaultCardId, serverId: before.server.id});
    const after = await playerProfiles(root);
    assert.equal(after.selectedPlayerId, target.playerId); assert.equal(after.activeMachineId, before.activeMachineId);
    assert.equal(after.machines.length, before.machines.length); assert.equal(after.players.length, before.players.length);
    assert.ok(after.players.find(player => player.id === before.selectedPlayerId).importedSaveIds.includes(saved.id));
    assert.equal(after.players.find(player => player.id === target.playerId).importedSaveIds, undefined);
  } finally {
    release(); fsp.writeFile = originalWrite;
    if (pending) await pending.catch(() => {});
  }
});

test('deleted, missing, and empty JSON destinations reject without falling back when any players exist', async t => {
  const root = await profileRoot(t), target = await alternateImportPlayer(root);
  await deletePlayerProfile(root, (await playerProfiles(root)).cards, target.playerId);
  const dir = saveDirectory(root), stationFile = path.join(dir, 'stations.json'), profileFile = path.join(dir, 'profiles.json');
  const before = await Promise.all([stationFile, profileFile].map(file => fsp.readFile(file)));
  for (const id of [target.playerId, 'missing-player', '', '../invalid']) await assert.rejects(importManagedPlayerSave(root, {...fixture, machine: importMachineB, accessCode: '00123456789012345678'}, null, id));
  assert.deepEqual(await Promise.all([stationFile, profileFile].map(file => fsp.readFile(file))), before);
  assert.equal((await listSaves(root)).length, 0);
  const state = JSON.parse(before[0]); state.selectedPlayerId = ''; const noSelection = JSON.stringify(state); await fsp.writeFile(stationFile, noSelection);
  await assert.rejects(importManagedPlayerSave(root, fixture, null), /玩家|选择/);
  assert.equal(await fsp.readFile(stationFile, 'utf8'), noSelection); assert.equal((await listSaves(root)).length, 0);
});

test('selected-player import at the 500 archive-reference limit rolls back only its new archive', async t => {
  const root = await profileRoot(t), state = await playerProfiles(root), dir = saveDirectory(root), stationFile = path.join(dir, 'stations.json');
  await persistSave(root, fixture, 'json', 'keep-older');
  const store = JSON.parse(await fsp.readFile(stationFile, 'utf8'));
  store.players.find(player => player.id === state.selectedPlayerId).importedSaveIds = Array.from({length:500}, (_, n) => `existing-import-${n}`);
  await fsp.writeFile(stationFile, JSON.stringify(store));
  const files = [stationFile, path.join(dir, 'profiles.json'), path.join(dir, 'archives', 'keep-older.json'), path.join(root, 'segatools.ini'), path.join(root, 'card.txt')];
  const before = await Promise.all(files.map(file => fsp.readFile(file)));
  await assert.rejects(importManagedPlayerSave(root, {...fixture, machine: importMachineB, accessCode: '00123456789012345678'}, state.server.id, state.selectedPlayerId), /最多关联 500/);
  assert.deepEqual(await Promise.all(files.map(file => fsp.readFile(file))), before);
  assert.deepEqual((await listSaves(root)).map(save => save.id), ['keep-older']);
  assert.deepEqual((await fsp.readdir(path.join(dir, 'archives'))).sort(), ['keep-older.json']);
});


test('empty-roster fallback matches normalized access codes to the correct existing card', async t => {
  const root = await profileRoot(t), profiles = await playerProfiles(root), serverId = profiles.server.id;
  const other = await addPlayerCard(root, '98765432109876543210');
  await clearPlayerRoster(root);
  const raw = { ...fixture, machine: importMachineA, userData: { ...fixture.userData, access_code: '1234-5678 9012 3456 7890' }, rivalList: [{ accessCode: '98765432109876543210' }] };
  const ini = await fsp.readFile(path.join(root, 'segatools.ini'));
  const imported = await importManagedPlayerSave(root, raw, serverId);
  assert.deepEqual(imported.scope, { serverId, cardId: profiles.defaultCardId });
  assert.notEqual(imported.scope.cardId, other);
  assert.equal(imported.localPlayerId, (await playerProfiles(root)).selectedPlayerId);
  assert.deepEqual((await scopedPlayerSaves(root)).find(s => s.id === imported.id).scope, imported.scope);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(saveDirectory(root), 'archives', `${imported.id}.json`))).raw, raw);
  assert.equal((await playerProfiles(root)).cards.length, 2);
  assert.deepEqual(await fsp.readFile(path.join(root, 'segatools.ini')), ini);
});

test('empty-roster fallback adds a new source card once and keeps imported snapshots separate', async t => {
  const root = await profileRoot(t), profiles = await playerProfiles(root), accessCode = '00123456789012345678';
  await clearPlayerRoster(root);
  const raw = { ...fixture, machine: importMachineA, accessCode };
  const [a, b] = await Promise.all([importManagedPlayerSave(root, raw, profiles.server.id), importManagedPlayerSave(root, raw, profiles.server.id)]);
  assert.notEqual(a.id, b.id); assert.equal(a.scope.cardId, cardIdentity(accessCode)); assert.deepEqual(a.scope, b.scope);
  assert.equal((await playerProfiles(root)).cards.filter(card => card.accessCode === accessCode).length, 1);
  assert.equal(a.localPlayerId, b.localPlayerId);
  assert.equal((await listSaves(root)).length, 2);
  await fsp.writeFile(path.join(root, 'segatools.ini'), '[dns]\ndefault=server-b.invalid');
  const serverB = (await playerProfiles(root)).server.id;
  await clearPlayerRoster(root);
  const c = await importManagedPlayerSave(root, raw, serverB);
  assert.equal(c.scope.cardId, a.scope.cardId); assert.equal(c.scope.serverId, a.scope.serverId);
});

test('empty-roster fallback keeps ambiguous, masked or numeric card identities pending and invalid imports add no cards', async t => {
  const root = await profileRoot(t), profiles = await playerProfiles(root), serverId = profiles.server.id;
  await clearPlayerRoster(root);
  const before = await fsp.readFile(path.join(saveDirectory(root), 'profiles.json'));
  for (const identity of [{ accessCode: '1234 **** **** **** ****' }, { accessCode: 12345678901234567890 }, { accessCode: ownConnection.accessCode, cardNumber: '98765432109876543210' }, { cardId: ownConnection.accessCode }]) {
    await clearPlayerRoster(root);
    assert.equal((await importManagedPlayerSave(root, { ...fixture, ...identity }, serverId)).scope, undefined);
  }
  await clearPlayerRoster(root);
  assert.equal((await importManagedPlayerSave(root, { ...fixture, accessCode: ownConnection.accessCode }, null)).scope, undefined);
  await assert.rejects(importManagedPlayerSave(root, { accessCode: '98765432109876543210' }, serverId), /未识别/);
  assert.deepEqual(await fsp.readFile(path.join(saveDirectory(root), 'profiles.json')), before);
});

test('empty-roster fallback retains verified export groups and refuses conflicting card evidence', async t => {
  const root = await profileRoot(t), profiles = await playerProfiles(root), scope = { serverId: profiles.server.id, cardId: profiles.defaultCardId };
  const saved = await persistSave(root, fixture, 'direct', 'original', scope);
  const exported = { summary: saved, raw: fixture };
  await clearPlayerRoster(root);
  assert.deepEqual((await importManagedPlayerSave(root, exported, scope.serverId)).scope, scope);
  const conflict = { ...exported, raw: { ...fixture, accessCode: '98765432109876543210' } };
  await clearPlayerRoster(root);
  assert.equal((await importManagedPlayerSave(root, conflict, scope.serverId)).scope, undefined);
  assert.equal((await playerProfiles(root)).cards.length, 1);
  await fsp.writeFile(path.join(root, 'segatools.ini'), '[dns]\ndefault=server-b.invalid');
  await clearPlayerRoster(root);
  const imported = await importManagedPlayerSave(root, {...exported, machine: importMachineA}, (await playerProfiles(root)).server.id);
  assert.deepEqual(imported.scope, scope); assert.ok(imported.localPlayerId);
});

test('empty-roster fallback uses only a unique exact endpoint/player mapping and never invents a card', async t => {
  const root = await profileRoot(t), profiles = await playerProfiles(root), scope = { serverId: profiles.server.id, cardId: profiles.defaultCardId };
  const raw = { events: [event()] };
  await persistSave(root, raw, 'direct', 'direct-map', scope);
  await clearPlayerRoster(root);
  assert.deepEqual((await importManagedPlayerSave(root, raw, scope.serverId)).scope, scope);
  await clearPlayerRoster(root);
  assert.equal((await importManagedPlayerSave(root, fixture, scope.serverId)).scope, undefined);
  const masked = { ...raw, accessCode: '1234 **** **** **** ****' };
  await clearPlayerRoster(root);
  assert.equal((await importManagedPlayerSave(root, masked, scope.serverId)).scope, undefined);
  const other = { serverId: scope.serverId, cardId: await addPlayerCard(root, '98765432109876543210') };
  await persistSave(root, raw, 'direct', 'other-map', other);
  await clearPlayerRoster(root);
  assert.equal((await importManagedPlayerSave(root, raw, scope.serverId)).scope, undefined);
  await fsp.writeFile(path.join(root, 'segatools.ini'), '[dns]\ndefault=server-b.invalid');
  await clearPlayerRoster(root);
  assert.equal((await importManagedPlayerSave(root, raw, (await playerProfiles(root)).server.id)).scope, undefined);
});

test('only an empty roster creates a source player on the imported machine without activating it', async t => {
  const root = await profileRoot(t), initial = await playerProfiles(root), before = await fsp.readFile(path.join(root, 'segatools.ini'));
  await clearPlayerRoster(root);
  const raw = {...fixture, machine:importMachineB, accessCode:ownConnection.accessCode};
  const saved = await importManagedPlayerSave(root, raw, initial.server.id), state = await playerProfiles(root);
  const player = state.players.find(player => player.id === saved.localPlayerId), machine = state.machines.find(machine => machine.id === player.machineId);
  assert.deepEqual(machine.values, importMachineB); assert.notEqual(machine.id, initial.activeMachineId);
  assert.equal(state.activeMachineId, initial.activeMachineId); assert.equal(state.selectedPlayerId, player.id);
  assert.equal(state.players.length, 1); assert.equal(state.cards.length, 1);
  assert.deepEqual(saved.scope, {cardId:initial.defaultCardId,serverId:serverIdentity(importMachineB.dns.default,importMachineB.dns.AimeDB).id});
  assert.deepEqual(await fsp.readFile(path.join(root, 'segatools.ini')), before);
});

test('pending imports become card-associated only after an explicit local player edit', async t => {
  const root = await profileRoot(t), state = await playerProfiles(root);
  await clearPlayerRoster(root);
  const saved = await importManagedPlayerSave(root, {...fixture,machine:importMachineB}, null), next = await playerProfiles(root);
  const player = next.players.find(player => player.id === saved.localPlayerId), ini = await fsp.readFile(path.join(root, 'segatools.ini'));
  const archiveFile = path.join(saveDirectory(root), 'archives', saved.id + '.json'), archive = await fsp.readFile(archiveFile);
  assert.equal(saved.scope, undefined); assert.equal(player.cardId, '');
  const {savePlayerProfile,selectPlayerProfile} = load('machine-profiles');
  await savePlayerProfile(root, next.cards, {id:player.id,name:'玩家 2',machineId:player.machineId,cardId:state.defaultCardId});
  const scoped = (await scopedPlayerSaves(root)).find(save => save.id === saved.id);
  assert.equal(scoped.scope.cardId, state.defaultCardId); assert.equal(scoped.localPlayerId, player.id);
  await selectPlayerProfile(root, next.cards, player.id);
  const connection = await requirePlayerScope(root,state.defaultCardId,scoped.scope.serverId);
  assert.equal(connection.config.server,importMachineB.dns.default);
  assert.deepEqual(await fsp.readFile(archiveFile),archive); assert.deepEqual(await fsp.readFile(path.join(root,'segatools.ini')),ini);
  await deleteManagedPlayerSaves(root,[saved.id],{localPlayerId:player.id}); assert.equal((await listSaves(root)).length,0);
});

test('invalid source imports create no card, player, machine or archive', async t => {
  const root = await profileRoot(t); await playerProfiles(root);
  await clearPlayerRoster(root);
  const paths = ['profiles.json','stations.json'].map(file => path.join(saveDirectory(root),file));
  const before = await Promise.all(paths.map(file=>fsp.readFile(file)));
  await assert.rejects(importManagedPlayerSave(root,{...fixture,accessCode:'00123456789012345678',machine:{...importMachineA,dns:{...importMachineA.dns,default:'file:///invalid'}}},null),/配置无效/);
  assert.deepEqual(await Promise.all(paths.map(file=>fsp.readFile(file))),before); assert.equal((await listSaves(root)).length,0);
});

test('top-level import failure at profile capacity rolls back only its new card and archive', async t => {
  const root = await profileRoot(t), initial = await playerProfiles(root);
  await clearPlayerRoster(root);
  await persistSave(root, fixture, 'json', 'older-archive');
  const dir = saveDirectory(root), stationFile = path.join(dir, 'stations.json'), store = JSON.parse(await fsp.readFile(stationFile, 'utf8'));
  for (let index = 1; index < 100; index++) store.machines.push({id:`fixture-machine-${index}`,name:`机台 ${index+1}`,values:{...importMachineA,keychip:{...importMachineA.keychip,id:`D${String(index).padStart(10,'0')}`}}});
  await fsp.writeFile(stationFile, JSON.stringify(store));
  const files = [stationFile,path.join(dir,'profiles.json'),path.join(dir,'archives','older-archive.json'),path.join(root,'segatools.ini'),path.join(root,'card.txt')];
  const before = await Promise.all(files.map(file=>fsp.readFile(file)));
  await assert.rejects(importManagedPlayerSave(root,{...fixture,machine:importMachineB,accessCode:'00123456789012345678'},null),/100 个机台/);
  assert.deepEqual(await Promise.all(files.map(file=>fsp.readFile(file))),before);
  assert.deepEqual((await listSaves(root)).map(save=>save.id),['older-archive']);
  assert.equal((await playerProfiles(root)).cards.length,initial.cards.length);
});

test('recent activity uses actual music timestamps without inventing difficulty or best scores', async t => {
  const root = await temporary(t);
  const activity = { ...event(), api: 'GetUserActivityApi', request: {userId:42,kind:2}, response: {userId:42,kind:2,userActivityList:[{kind:2,id:101,sortNumber:1750000000},{kind:2,id:202,sortNumber:1750000010},{kind:1,id:999,sortNumber:1750000020}]} };
  const raw = {events:[event(), activity]};
  const saved = await persistSave(root,raw,'direct');
  assert.deepEqual(saved.recentPlays.map(p=>p.musicId),[202,101]);
  assert.equal(saved.recentPlays[0].playedAt,new Date(1750000010000).toISOString());
  assert.equal(saved.recentPlays[0].difficulty,undefined);assert.equal(saved.recentPlays[0].techScore,undefined);
  assert.equal(saved.scores.length,1);
  const file=path.join(saveDirectory(root),'archives',saved.id+'.json'),legacy=JSON.parse(await fsp.readFile(file,'utf8'));
  delete legacy.summary.recentPlays;delete legacy.summary.recentPlaysRecorded;const before=JSON.stringify(legacy);await fsp.writeFile(file,before);
  assert.equal((await listSaves(root))[0].recentPlays.length,2);assert.equal(await fsp.readFile(file,'utf8'),before);
  const imported=summarizeSave({userPlaylogList:[{musicId:101,level:2,techScore:841927,playDate:'2026-09-30T10:00:00Z'},{musicId:202,level:3,techScore:900000,playDate:'invalid'}]},'json');
  assert.equal(imported.recentPlays.length,1);assert.equal(imported.scores.length,0);assert.equal(imported.recentPlays[0].techScore,841927);
  const playActivity={...activity,request:{userId:42,kind:1},response:{userId:42,kind:1,userActivityList:[]}};
  await capture(root,[activity,playActivity]);assert.equal((await captureEvents(root,session)).length,2);
});

test('unsupported optional activity keeps core reads, cancellation and identity failures still stop', async t => {
  const root=await temporary(t), activity={...event(),api:'GetUserActivityApi',request:{userId:42,kind:2}};
  const result=await refreshFromRequests(root,[event(),activity],undefined,async seed=>{if(seed.api==='GetUserActivityApi')throw new Error('HTTP 404');return event().response;});
  assert.equal(result.scores.length,1);assert.equal(result.recentPlaysRecorded,false);
  await assert.rejects(refreshFromRequests(root,[activity],undefined,async()=>{throw new Error('玩家身份不匹配');}),/身份/);
  await assert.rejects(refreshFromRequests(root,[activity],AbortSignal.abort(),async()=>{throw new Error('HTTP 404');}),/取消/);
});

test('rating fields survive parsing, legacy max-score sentinel and in-memory archive upgrades', async t => {
  const raw = {userData:{userName:'RATING',newPlayerRating:16543},userMusicList:[{userMusicDetailList:[{...score,techScoreMax:1010001,techScoreRank:12,platinumScoreStar:6}]}]};
  const summary = summarizeSave(raw,'json');
  assert.equal(summary.newPlayerRating,16543);assert.equal(summary.ratingVersion,1);
  assert.equal(summary.scores[0].techScore,1010000);assert.equal(summary.scores[0].techScoreRank,12);assert.equal(summary.scores[0].platinumScoreStar,6);
  const root=await temporary(t),saved=await persistSave(root,raw,'json');
  const file=path.join(saveDirectory(root),'archives',saved.id+'.json');const stored=JSON.parse(await fsp.readFile(file,'utf8'));
  delete stored.summary.ratingVersion;delete stored.summary.newPlayerRating;delete stored.summary.scores[0].techScoreRank;delete stored.summary.scores[0].platinumScoreStar;
  const original=JSON.stringify(stored);await fsp.writeFile(file,original);
  const upgraded=(await listSaves(root))[0];assert.equal(upgraded.newPlayerRating,16543);assert.equal(upgraded.scores[0].platinumScoreStar,6);
  assert.equal(upgraded.id,saved.id);assert.equal(upgraded.updatedAt,saved.updatedAt);assert.equal(await fsp.readFile(file,'utf8'),original);
  const invalid=summarizeSave({...raw,userData:{newPlayerRating:-1},userMusicList:[{userMusicDetailList:[{...score,techScoreRank:13,platinumScoreStar:7}]}]},'json');
  assert.equal(invalid.newPlayerRating,undefined);assert.equal(invalid.scores[0].techScoreRank,undefined);assert.equal(invalid.scores[0].platinumScoreStar,undefined);
  assert.equal(summarizeSave({...raw,userData:{newPlayerRating:0}},'json').newPlayerRating,0);
});

test('game full-score repetition counters remain raw while local display clamps at the technical maximum', () => {
  const raw = {userData:{userName:'COUNTER'}, userMusicDetailList:[{...score,techScoreMax:1019999}]};
  assert.equal(summarizeSave(raw,'json').scores[0].techScore,1010000);
  assert.equal(raw.userMusicDetailList[0].techScoreMax,1019999);
  assert.throws(() => summarizeSave({...raw,userMusicDetailList:[{...score,techScoreMax:1020000}]},'json'),/成绩字段无效/);
});

test('saved edit provenance does not become a second score source and stale remote rating is excluded', () => {
  const saveEdit = {version:1,parentId:'original',playerId:'player-a',createdAt:'2026-10-03T00:00:00Z',resources:[{key:'data:point',value:100}],scores:[{musicId:101,difficulty:3,techScore:1010000,platinumScore:0,battleScore:0,fullCombo:true,fullBell:true,allBreak:true}]};
  const raw = {userData:{userName:'EDITOR',point:100,newPlayerRating:20000},userMusicDetailList:[{...score,techScoreMax:900000}],saveEdit};
  const result = summarizeSave(raw,'json');
  assert.equal(result.scores[0].techScore,900000);
  assert.equal(result.newPlayerRating,undefined);
  assert.deepEqual(result.edit,saveEdit);
  assert.equal(result.inventory.items.find(item=>item.itemKind===6).stock,100);
  assert.throws(()=>summarizeSave({...raw,saveEdit:{...saveEdit,resources:[...saveEdit.resources,...saveEdit.resources]}},'json'),/修改存档字段无效/);
});

test('nested toolbox exports keep saved edit metadata and reject excessively nested wrappers', () => {
  const edit = { version: 1, parentId: 'source', playerId: 'player', createdAt: '2026-10-03T00:00:00Z', resources: [{ key: 'data:point', value: 150 }], scores: [] };
  const payload = { userData: { userName: 'Nested fixture', point: 150, newPlayerRating: 12345 }, userMusicDetailList: [{ ...score }], saveEdit: edit };
  const wrap = value => ({ summary: { scores: [], playerName: 'Stale wrapper', newPlayerRating: 99999 }, raw: value });
  const summary = summarizeSave(wrap(wrap(payload)), 'json');
  assert.deepEqual(summary.edit, edit); assert.equal(summary.newPlayerRating, undefined); assert.equal(summary.playerName, 'Nested fixture');
  assert.equal(summary.scores.length, 1);
  let deep = payload; for (let i = 0; i < 25; i++) deep = wrap(deep);
  assert.throws(() => summarizeSave(deep, 'json'), /嵌套过深/);
});
