const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const Module = require('node:module');
const ts = require('typescript');

const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name).exports;
  const file = path.resolve(__dirname, `../electron/${name}.ts`), m = new Module(file, module);
  m.filename = file; m.paths = module.paths;
  m.require = id => {
    const dependency = path.resolve(path.dirname(file), `${id}.ts`);
    return id.startsWith('.') && fs.existsSync(dependency)
      ? load(path.relative(path.resolve(__dirname, '../electron'), dependency).slice(0, -3)) : require(id);
  };
  modules.set(name, m);
  m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, file);
  return m.exports;
}
const { discoverPlayerServer } = load('player-bootstrap');
const { readGameApi, refreshFromRequests } = load('player-capture');
const { PlayerReadError, createPlayerReadError } = load('player-read-error');
const { saveDirectory } = load('player-save');
const { playerProtocolFromSalt } = load('player-game-protocol');
const protocol = playerProtocolFromSalt(Buffer.from('anonymous resource session wire fixture'));
const validPreview = { userId: 42, isLogin: false, banStatus: 0, isWarningConfirmed: true };

async function fixture(t) {
  const state = { region: '2', dfi: false, response: validPreview, encoding: '', rawResponse: null, status: 200, requests: [], failures: [] };
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      state.requests.push(req.url);
      assert.equal(req.method, 'POST');
      if (req.url === '/sys/servlet/PowerOn') {
        assert.equal(req.headers['user-agent'], undefined);
        assert.equal(req.headers.pragma, 'DFI');
        const params = new URLSearchParams(zlib.inflateSync(Buffer.from(bytes.toString('utf8'), 'base64')).toString('utf8'));
        assert.equal(params.get('game_id'), 'SDDT'); assert.equal(params.get('ver'), '1.50');
        const response = new URLSearchParams({ stat: '1', uri: `${base}/game/`, place_id: '12' });
        if (state.region !== undefined) response.set('region0', state.region);
        if (state.dfi) { res.setHeader('Pragma', 'DFI'); res.end(zlib.deflateSync(Buffer.from(response.toString())).toString('base64')); }
        else res.end(response.toString());
        return;
      }
      const api = req.url.slice('/game/'.length);
      assert.ok(['GetUserPreviewApi', 'GetUserRecentRatingApi', 'GetUserRatinglogApi', 'GetUserDataApi', 'GetUserActivityApi', 'GetUserCardApi'].includes(api));
      assert.equal(req.headers['content-encoding'], 'deflate');
      assert.equal(req.headers.charset, 'UTF-8');
      assert.equal(req.headers['user-agent'], protocol.userAgent(api, 42));
      const request = JSON.parse(zlib.inflateSync(bytes).toString('utf8'));
      assert.deepEqual(Object.keys(request).sort(), api === 'GetUserActivityApi' ? ['kind', 'nonce_', 'userId'] : ['nonce_', 'userId']);
      assert.equal(request.userId, 42); assert.ok(Number.isSafeInteger(request.nonce_));
      assert.ok(request.nonce_ >= -2147483648 && request.nonce_ <= 2147483647);
      const json = state.rawResponse === null ? Buffer.from(JSON.stringify(state.response)) : Buffer.from(state.rawResponse);
      res.statusCode = state.status;
      if (state.encoding) res.setHeader('Content-Encoding', state.encoding);
      res.end(state.rawResponse !== null ? json : state.encoding === 'deflate' ? zlib.deflateSync(json) : state.encoding === 'gzip' ? zlib.gzipSync(json) : json);
    } catch (error) { state.failures.push(error); res.statusCode = 500; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(state.failures, []);
  });
  const config = { server: base, keychip: 'A123-45678901234', accessCode: '12345678901234567890', version: '1.50' };
  const event = { api: 'GetUserPreviewApi', at: '2026-10-03T00:00:00.000Z', request: { userId: 42 }, response: {},
    connection: { baseUrl: `${base}/game/`, encryptVersion: 0, userAgent: protocol.userAgent('GetUserPreviewApi', 42) } };
  return { state, config, event };
}

test('PowerOn derives region zero or two from the actual plain or DFI response', async t => {
  const { state, config } = await fixture(t);
  for (const [region, dfi] of [['0', false], ['2', true]]) {
    Object.assign(state, { region, dfi });
    const result = await discoverPlayerServer(config, undefined, { omitUserAgent: true });
    assert.equal(result.regionId, Number(region)); assert.equal(result.placeId, 12); assert.ok(result.baseUrl.endsWith('/game/'));
  }
  assert.deepEqual(state.requests, ['/sys/servlet/PowerOn', '/sys/servlet/PowerOn']);
});

test('PowerOn never invents a region for missing, negative, noninteger, overflow or malformed values', async t => {
  const { state, config } = await fixture(t);
  for (const region of [undefined, '-1', '1.5', '2147483648', '9007199254740993', '', 'NaN', ' 2', '+2']) {
    state.region = region;
    const result = await discoverPlayerServer(config, undefined, { omitUserAgent: true });
    assert.equal(Object.hasOwn(result, 'regionId'), false); assert.equal(result.placeId, 12);
  }
  assert.equal(state.requests.length, 9);
});

test('the real read adapter accepts Preview with protocol identity and compressed response bodies', async t => {
  const { state, event } = await fixture(t);
  for (const encoding of ['', 'deflate', 'gzip']) {
    state.encoding = encoding;
    assert.deepEqual(await readGameApi(event, { userId: 42 }), validPreview);
  }
  assert.deepEqual(state.requests, Array(3).fill('/game/GetUserPreviewApi'));
});

test('the real Preview read rejects foreign identities and malformed state scalar types', async t => {
  const { state, event } = await fixture(t);
  const scenarios = [
    [{ ...validPreview, userId: 43 }, 'identity', 'identity_mismatch', 'userId'],
    [{ ...validPreview, userId: '42' }, 'identity', 'invalid_type', 'userId'],
    [{ ...validPreview, userId: undefined }, 'identity', 'missing_field', 'userId'],
    [[validPreview], 'shape', 'invalid_root'],
    [{ ...validPreview, isLogin: 'false' }, 'payload', 'invalid_type', 'isLogin'],
    [{ ...validPreview, isLogin: 0 }, 'payload', 'invalid_type', 'isLogin'],
    [{ ...validPreview, isLogin: undefined }, 'payload', 'missing_field', 'isLogin'],
    [{ ...validPreview, banStatus: '0' }, 'payload', 'invalid_type', 'banStatus'],
    [{ ...validPreview, banStatus: 0.5 }, 'payload', 'invalid_type', 'banStatus'],
    [{ ...validPreview, banStatus: 9007199254740992 }, 'payload', 'invalid_type', 'banStatus'],
    [{ ...validPreview, banStatus: undefined }, 'payload', 'missing_field', 'banStatus'],
    [{ ...validPreview, isWarningConfirmed: 1 }, 'payload', 'invalid_type', 'isWarningConfirmed'],
    [{ ...validPreview, isWarningConfirmed: null }, 'payload', 'invalid_type', 'isWarningConfirmed'],
    [{ ...validPreview, isWarningConfirmed: undefined }, 'payload', 'missing_field', 'isWarningConfirmed'],
  ];
  for (const [response, stage, reason, field] of scenarios) {
    state.response = response;
    await assert.rejects(readGameApi(event, { userId: 42 }), error => {
      assert.ok(error instanceof PlayerReadError);
      assert.deepEqual(error.diagnostic, { api: 'GetUserPreviewApi', stage, reason, ...(field ? { fields: [field] } : {}) });
      return true;
    });
  }
  assert.equal(state.requests.length, scenarios.length);
});

test('adding Preview to the read allowlist never permits login or save requests through that adapter', async t => {
  const { state, event } = await fixture(t);
  for (const api of ['GameLoginApi', 'GameLogoutApi', 'UpsertUserAllApi']) {
    await assert.rejects(readGameApi({ ...event, api }, { userId: 42 }), /不允许调用非读取接口/);
  }
  await assert.rejects(readGameApi({ ...event, connection: { ...event.connection, encryptVersion: 1 } }, { userId: 42 }), /明文协议连接信息/);
  assert.deepEqual(state.requests, []);
});

test('Rating initialization reads are single protocol reads preserving repeated Recent order and release codes', async t => {
  const { state, event } = await fixture(t);
  const recent = [{ musicId: 101, difficultId: 10, romVersionCode: 1050004, score: 1009999 }, { musicId: 101, difficultId: 10, romVersionCode: 1050002, score: 999000 }];
  for (const [api, field, values] of [['GetUserRecentRatingApi', 'userRecentRatingList', recent], ['GetUserRatinglogApi', 'userRatinglogList', [{ highestRating: 1500, newHighestRating: 15500, dataVersion: '1.50' }]]]) {
    state.response = { userId: 42, length: values.length, [field]: values };
    const seed = { ...event, api, connection: { ...event.connection, userAgent: protocol.userAgent(api, 42) } };
    assert.deepEqual(await readGameApi(seed, { userId: 42 }), state.response);
  }
  assert.deepEqual(state.requests, ['/game/GetUserRecentRatingApi', '/game/GetUserRatinglogApi']);
});

test('Rating initialization refuses malformed types, lengths, duplicate version aliases and foreign players', async t => {
  const { state, event } = await fixture(t);
  const recent = { musicId: 101, difficultId: 10, romVersionCode: 1050004, score: 1009999 };
  const log = { highestRating: 1500, newHighestRating: 15500, dataVersion: '1.50' };
  const invalid = [
    ['GetUserRecentRatingApi', 'userRecentRatingList', [{ ...recent, difficultId: 4 }]],
    ['GetUserRecentRatingApi', 'userRecentRatingList', [{ ...recent, score: '1009999' }]],
    ['GetUserRecentRatingApi', 'userRecentRatingList', [{ ...recent, romVersionCode: -1 }]],
    ['GetUserRecentRatingApi', 'userRecentRatingList', Array(31).fill(recent)],
    ['GetUserRatinglogApi', 'userRatinglogList', [{ ...log, highestRating: 1.5 }]],
    ['GetUserRatinglogApi', 'userRatinglogList', [{ ...log, dataVersion: '1.256' }]],
    ['GetUserRatinglogApi', 'userRatinglogList', [log, { ...log, dataVersion: '1.50.00' }]],
  ];
  for (const [api, field, values] of invalid) {
    state.response = { userId: 42, length: values.length, [field]: values };
    const seed = { ...event, api, connection: { ...event.connection, userAgent: protocol.userAgent(api, 42) } };
    await assert.rejects(readGameApi(seed, { userId: 42 }), error => error instanceof PlayerReadError && error.diagnostic.api === api && error.diagnostic.stage === 'payload');
  }
  const api = 'GetUserRecentRatingApi', seed = { ...event, api, connection: { ...event.connection, userAgent: protocol.userAgent(api, 42) } };
  for (const response of [{ userId: 42, length: 2, userRecentRatingList: [recent] }, { userId: 42, userRecentRatingList: [] }, { userId: 43, length: 0, userRecentRatingList: [] }]) {
    state.response = response;
    await assert.rejects(readGameApi(seed, { userId: 42 }), error => error instanceof PlayerReadError && error.diagnostic.api === api);
  }
});

test('Recent reads retain typed decimal ROM text on the raw response without weakening identity', async t => {
  const { state, event } = await fixture(t);
  const api = 'GetUserRecentRatingApi', seed = { ...event, api, connection: { ...event.connection, userAgent: protocol.userAgent(api, 42) } };
  const values = [{ musicId: 101, difficultId: 10, romVersionCode: '1050004', score: 1009999 }];
  state.response = { userId: 42, length: 1, userRecentRatingList: values };
  const raw = await readGameApi(seed, { userId: 42 });
  assert.deepEqual(raw, state.response);
  assert.equal(raw.userRecentRatingList[0].romVersionCode, '1050004');
  state.response = { ...state.response, userId: '42' };
  await assert.rejects(readGameApi(seed, { userId: 42 }), error => {
    assert.deepEqual(error.diagnostic, { api, stage: 'identity', reason: 'invalid_type', fields: ['userId'] });
    return true;
  });
});

test('HTTP 200 decode failures distinguish encoding, compression, JSON and root shape without retaining plaintext', async t => {
  const { state, event } = await fixture(t);
  const secret = 'PRIVATE_PLAYER_12345678901234567890_https://private.invalid/secret';
  for (const [encoding, rawResponse, stage, reason] of [
    ['br', secret, 'codec', 'unsupported_encoding'], ['deflate', secret, 'codec', 'decompression_failed'],
    ['gzip', secret, 'codec', 'decompression_failed'], ['', `<html>${secret}</html>`, 'json', 'invalid_json'],
    ['', JSON.stringify(secret), 'shape', 'invalid_root'], ['', 'null', 'shape', 'invalid_root'], ['', '[]', 'shape', 'invalid_root'],
  ]) {
    Object.assign(state, { encoding, rawResponse });
    await assert.rejects(readGameApi(event, { userId: 42 }), error => {
      assert.ok(error instanceof PlayerReadError);
      assert.deepEqual(error.diagnostic, { api: 'GetUserPreviewApi', stage, reason });
      assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE_PLAYER|12345678901234567890|private\.invalid/);
      return true;
    });
  }
});

test('known payload fields report absence and type failures without inspecting arbitrary response keys', async t => {
  const { state, event } = await fixture(t);
  const secret = 'PRIVATE_PLAYER_12345678901234567890';
  for (const [api, field, response, reason] of [
    ['GetUserDataApi', 'userData', { userId: 42, [secret]: secret }, 'missing_field'],
    ['GetUserDataApi', 'userData', { userId: 42, userData: secret }, 'invalid_type'],
    ['GetUserCardApi', 'userCardList', { userId: 42, userCardList: null }, 'invalid_type'],
  ]) {
    state.response = response;
    const seed = { ...event, api, connection: { ...event.connection, userAgent: protocol.userAgent(api, 42) } };
    await assert.rejects(readGameApi(seed, { userId: 42 }), error => {
      assert.deepEqual(error.diagnostic, { api, stage: 'payload', reason, fields: [field] });
      assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE_PLAYER|12345678901234567890/);
      return true;
    });
  }
});

test('activity response kind keeps strict identity and separates absence, type and category mismatch', async t => {
  const { state, event } = await fixture(t);
  const api = 'GetUserActivityApi', seed = { ...event, api, connection: { ...event.connection, userAgent: protocol.userAgent(api, 42) } };
  for (const [kind, reason] of [[undefined, 'missing_field'], ['1', 'invalid_type'], [2, 'activity_mismatch']]) {
    state.response = { userId: 42, kind, userActivityList: [] };
    await assert.rejects(readGameApi(seed, { userId: 42, kind: 1 }), error => {
      assert.deepEqual(error.diagnostic, { api, stage: 'payload', reason, fields: ['kind'] });
      return true;
    });
  }
});

test('non-200 reads identify the exact fixed API and status without reflecting response secrets or guessing a session', async t => {
  const { state, event } = await fixture(t);
  state.rawResponse = 'PRIVATE_PLAYER_12345678901234567890_https://private.invalid/secret';
  for (const api of ['GetUserDataApi', 'GetUserPreviewApi']) for (const status of [401, 403, 404, 405, 429, 500, 501]) {
    state.status = status;
    const seed = { ...event, api, connection: { ...event.connection, userAgent: protocol.userAgent(api, 42) } };
    await assert.rejects(readGameApi(seed, { userId: 42 }), error => {
      assert.ok(error instanceof PlayerReadError);
      assert.deepEqual(error.diagnostic, { api, stage: 'http', reason: 'http_rejected', status });
      assert.match(error.message, new RegExp(`${api}.*HTTP ${status}\\b`));
      assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE_PLAYER|12345678901234567890|private\.invalid|可能|游戏会话/);
      return true;
    });
  }
});

test('an already cancelled read remains cancellation rather than an HTTP rejection', async t => {
  const { state, event } = await fixture(t);
  state.status = 401;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readGameApi(event, { userId: 42 }, controller.signal), /已取消刷新，原存档保留/);
  assert.deepEqual(state.requests, []);
});

test('only optional activity HTTP 404, 405 or 501 failures are skipped when refreshing a save', async t => {
  for (const status of [404, 405, 501, 401, 403, 500]) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ogk-read-http-'));
    t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^ogk-read-http-/); await fsp.rm(root, { recursive: true, force: true }); });
    const seeds = [
      { api: 'GetUserDataApi', request: { userId: 42 }, response: {}, at: '2026-10-04T00:00:00.000Z' },
      { api: 'GetUserActivityApi', request: { userId: 42, kind: 1 }, response: {}, at: '2026-10-04T00:00:00.000Z' },
    ];
    const calls = [], call = async event => {
      calls.push(event.api);
      if (event.api === 'GetUserActivityApi') throw createPlayerReadError(event.api, 'http', 'http_rejected', undefined, status);
      return { userId: 42, userData: { userName: 'ANONYMOUS', newPlayerRating: 0 } };
    };
    const request = refreshFromRequests(root, seeds, undefined, call);
    if ([404, 405, 501].includes(status)) {
      const save = await request, stored = JSON.parse(await fsp.readFile(path.join(saveDirectory(root), 'archives', `${save.id}.json`), 'utf8'));
      assert.deepEqual(stored.raw.events.map(event => event.api), ['GetUserDataApi']);
    } else {
      await assert.rejects(request, error => error instanceof PlayerReadError && error.diagnostic.status === status);
      assert.equal(await fsp.stat(path.join(saveDirectory(root), 'archives')).then(() => true, () => false), false);
    }
    assert.deepEqual(calls, ['GetUserDataApi', 'GetUserActivityApi']);
  }
});
