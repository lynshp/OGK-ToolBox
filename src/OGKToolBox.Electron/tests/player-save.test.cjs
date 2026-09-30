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
  if (modules.has(name)) return modules.get(name).exports;
  const file = path.resolve(__dirname, `../electron/${name}.ts`);
  const m = new Module(file, module); m.filename = file; m.paths = module.paths;
  m.require = id => id.startsWith('./player-') ? load(id.slice(2)) : require(id);
  modules.set(name, m);
  m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, file);
  return m.exports;
}
const { summarizeSave, parseSave, persistSave, listSaves, deletePlayerArchives, saveDirectory, captureWarnings } = load('player-save');
const { captureEvents, syncCaptures, refreshFromGame, refreshFromRequests, readGameApi, captureState, setCapture } = load('player-capture');
const { validatePlayerConnection, playerConnectionDefaults, discoverPlayerServer, lookupPlayerCard, createCardLookup, parseCardLookup, fetchPlayerFromLocalConfiguration } = load('player-bootstrap');
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
test('import handles BOM, nested music pages and resource counts', () => {
  const result = summarizeSave(parseSave('\ufeff' + JSON.stringify(fixture)), 'json');
  assert.equal(result.playerName, 'TEST'); assert.equal(result.scores.length, 1);
  assert.equal(result.scores[0].allBreak, true); assert.equal(result.scores[0].fullBell, false);
  assert.ok(result.collections.some(item => item.name === 'userCardList' && item.count === 1));
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
  mode = 'wrong'; await assert.rejects(readGameApi(seed, seed.request), /身份不匹配/);
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
    const result = await fetchPlayerFromLocalConfiguration(root, defaults.accessCode, undefined, services);
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
  const first = await fetchPlayerFromLocalConfiguration(root, defaults.accessCode);
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
  await fetchPlayerFromLocalConfiguration(root, '98765432109876543210');
  assert.equal(cardRequests[1].keychip, 'B4567890123'); assert.equal(cardRequests[1].card, '98765432109876543210');
  assert.equal(allnetRequests[1].serial, 'B4567890123');
  assert.equal(await fsp.readFile(path.join(root, 'segatools.ini'), 'utf8'), changedIni);
  assert.equal(await fsp.readFile(path.join(root, 'own-card.txt'), 'utf8'), ownConnection.accessCode);
  const before = await listSaves(root), gameCount = gameRequests.length; returnUnknownCard = true;
  await assert.rejects(fetchPlayerFromLocalConfiguration(root, defaults.accessCode), /尚未注册/);
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
async function profileRoot(t) {
  const root = await temporary(t);
  await fsp.writeFile(path.join(root, 'segatools.ini'), '[dns]\ndefault=server-a.invalid\n[keychip]\nid=A123-45678901234\n[aime]\naimePath=card.txt');
  await fsp.writeFile(path.join(root, 'card.txt'), ownConnection.accessCode);
  return root;
}
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

test('JSON imports keep server identity and cannot be removed from another server or the unknown-source group', async t => {
  const root = await profileRoot(t), firstServer = (await playerProfiles(root)).server.id;
  const a = await importManagedPlayerSave(root, fixture, firstServer);
  assert.equal(a.serverId, firstServer); assert.equal(a.scope, undefined);
  await assert.rejects(deleteManagedPlayerSaves(root, [a.id], null), /分组已变化/);
  await fsp.writeFile(path.join(root, 'segatools.ini'), '[dns]\ndefault=server-b.invalid');
  const secondServer = (await playerProfiles(root)).server.id;
  const b = await importManagedPlayerSave(root, fixture, secondServer);
  assert.notEqual(a.serverId, b.serverId);
  await assert.rejects(importManagedPlayerSave(root, fixture, firstServer), /配置已变化/);
  await assert.rejects(deleteManagedPlayerSaves(root, [a.id], {serverId:secondServer}), /分组已变化/);
  await deleteManagedPlayerSaves(root, [b.id], {serverId:secondServer});
  assert.deepEqual((await listSaves(root)).map(save=>save.id), [a.id]);
  const local = await importManagedPlayerSave(root, fixture, null);
  assert.equal(local.serverId, undefined);
  await deleteManagedPlayerSaves(root, [local.id], null);
  assert.deepEqual((await listSaves(root)).map(save=>save.id), [a.id]);
});


test('JSON imports match normalized access codes to the correct existing card', async t => {
  const root = await profileRoot(t), profiles = await playerProfiles(root), serverId = profiles.server.id;
  const other = await addPlayerCard(root, '98765432109876543210');
  const raw = { ...fixture, userData: { ...fixture.userData, access_code: '1234-5678 9012 3456 7890' }, rivalList: [{ accessCode: '98765432109876543210' }] };
  const ini = await fsp.readFile(path.join(root, 'segatools.ini'));
  const imported = await importManagedPlayerSave(root, raw, serverId);
  assert.deepEqual(imported.scope, { serverId, cardId: profiles.defaultCardId });
  assert.notEqual(imported.scope.cardId, other);
  assert.deepEqual((await scopedPlayerSaves(root)).find(s => s.id === imported.id).scope, imported.scope);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(saveDirectory(root), 'archives', `${imported.id}.json`))).raw, raw);
  assert.equal((await playerProfiles(root)).cards.length, 2);
  assert.deepEqual(await fsp.readFile(path.join(root, 'segatools.ini')), ini);
});

test('new imported cards are added once and their snapshots remain separate', async t => {
  const root = await profileRoot(t), profiles = await playerProfiles(root), accessCode = '00123456789012345678';
  const raw = { ...fixture, accessCode };
  const [a, b] = await Promise.all([importManagedPlayerSave(root, raw, profiles.server.id), importManagedPlayerSave(root, raw, profiles.server.id)]);
  assert.notEqual(a.id, b.id); assert.equal(a.scope.cardId, cardIdentity(accessCode)); assert.deepEqual(a.scope, b.scope);
  assert.equal((await playerProfiles(root)).cards.filter(card => card.accessCode === accessCode).length, 1);
  assert.equal((await listSaves(root)).length, 2);
  await fsp.writeFile(path.join(root, 'segatools.ini'), '[dns]\ndefault=server-b.invalid');
  const serverB = (await playerProfiles(root)).server.id;
  const c = await importManagedPlayerSave(root, raw, serverB);
  assert.equal(c.scope.cardId, a.scope.cardId); assert.notEqual(c.scope.serverId, a.scope.serverId);
});

test('ambiguous, masked or numeric card identities stay unassigned and invalid imports add no cards', async t => {
  const root = await profileRoot(t), profiles = await playerProfiles(root), serverId = profiles.server.id;
  const before = await fsp.readFile(path.join(saveDirectory(root), 'profiles.json'));
  for (const identity of [{ accessCode: '1234 **** **** **** ****' }, { accessCode: 12345678901234567890 }, { accessCode: ownConnection.accessCode, cardNumber: '98765432109876543210' }, { cardId: ownConnection.accessCode }]) {
    assert.equal((await importManagedPlayerSave(root, { ...fixture, ...identity }, serverId)).scope, undefined);
  }
  assert.equal((await importManagedPlayerSave(root, { ...fixture, accessCode: ownConnection.accessCode }, null)).scope, undefined);
  await assert.rejects(importManagedPlayerSave(root, { accessCode: '98765432109876543210' }, serverId), /未识别/);
  assert.deepEqual(await fsp.readFile(path.join(saveDirectory(root), 'profiles.json')), before);
});

test('toolbox exports retain verified card groups without crossing their original server', async t => {
  const root = await profileRoot(t), profiles = await playerProfiles(root), scope = { serverId: profiles.server.id, cardId: profiles.defaultCardId };
  const saved = await persistSave(root, fixture, 'direct', 'original', scope);
  const exported = { summary: saved, raw: fixture };
  assert.deepEqual((await importManagedPlayerSave(root, exported, scope.serverId)).scope, scope);
  const conflict = { ...exported, raw: { ...fixture, accessCode: '98765432109876543210' } };
  assert.equal((await importManagedPlayerSave(root, conflict, scope.serverId)).scope, undefined);
  assert.equal((await playerProfiles(root)).cards.length, 1);
  await fsp.writeFile(path.join(root, 'segatools.ini'), '[dns]\ndefault=server-b.invalid');
  await assert.rejects(importManagedPlayerSave(root, exported, (await playerProfiles(root)).server.id), /其他服务器/);
});

test('raw exports without a card only inherit a unique exact endpoint/player mapping on the same server', async t => {
  const root = await profileRoot(t), profiles = await playerProfiles(root), scope = { serverId: profiles.server.id, cardId: profiles.defaultCardId };
  const raw = { events: [event()] };
  await persistSave(root, raw, 'direct', 'direct-map', scope);
  assert.deepEqual((await importManagedPlayerSave(root, raw, scope.serverId)).scope, scope);
  assert.equal((await importManagedPlayerSave(root, fixture, scope.serverId)).scope, undefined);
  const masked = { ...raw, accessCode: '1234 **** **** **** ****' };
  assert.equal((await importManagedPlayerSave(root, masked, scope.serverId)).scope, undefined);
  const other = { serverId: scope.serverId, cardId: await addPlayerCard(root, '98765432109876543210') };
  await persistSave(root, raw, 'direct', 'other-map', other);
  assert.equal((await importManagedPlayerSave(root, raw, scope.serverId)).scope, undefined);
  await fsp.writeFile(path.join(root, 'segatools.ini'), '[dns]\ndefault=server-b.invalid');
  assert.equal((await importManagedPlayerSave(root, raw, (await playerProfiles(root)).server.id)).scope, undefined);
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
