const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const file = path.resolve(__dirname, '../electron/player-read-error.ts');
const m = new Module(file, module);
m.filename = file; m.paths = module.paths;
m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText, file);
const { PlayerReadError, createPlayerReadError } = m.exports;

test('read errors contain only fixed API, category and field metadata', () => {
  const error = createPlayerReadError('GetUserRecentRatingApi', 'payload', 'count_mismatch', ['length', 'userRecentRatingList']);
  assert.ok(error instanceof Error); assert.ok(error instanceof PlayerReadError);
  assert.equal(error.name, 'Error'); assert.equal(error.stack, undefined);
  assert.deepEqual(error.diagnostic, { api: 'GetUserRecentRatingApi', stage: 'payload', reason: 'count_mismatch', fields: ['length', 'userRecentRatingList'] });
  assert.ok(Object.isFrozen(error.diagnostic)); assert.ok(Object.isFrozen(error.diagnostic.fields));
  assert.match(error.message, /GetUserRecentRatingApi.*记录数量不一致.*length/);
  assert.doesNotMatch(error.message, /未上传|PlayerReadError/);
});

test('arbitrary API, stage or reason tokens produce a generic safe fallback', () => {
  const secret = 'PRIVATE_PLAYER_12345678901234567890_https://private.invalid/secret';
  for (const args of [[secret, 'payload', 'missing_field', ['userId']], ['GetUserDataApi', secret, 'missing_field'], ['GetUserDataApi', 'payload', secret]]) {
    const error = createPlayerReadError(...args);
    assert.deepEqual(error.diagnostic, { stage: 'payload', reason: 'invalid_response' });
    assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE_PLAYER|12345678901234567890|private\.invalid/);
  }
});

test('untrusted field names, values, paths and object inputs are not reflected', () => {
  const error = createPlayerReadError('GetUserDataApi', 'payload', 'missing_field', [
    'userData', 'userData', 'PRIVATE_PLAYER', '12345678901234567890', 'https://private.invalid/secret',
    'userData.userName', 'userData[42]', { field: 'userId', value: 'PRIVATE_PLAYER' }, 'USERDATA', null
  ]);
  assert.deepEqual(error.diagnostic.fields, ['userData']);
  assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE_PLAYER|12345678901234567890|private\.invalid|userName|\[42\]/);
  assert.deepEqual(createPlayerReadError('GetUserDataApi', 'payload', 'missing_field', { userData: 'PRIVATE_PLAYER' }).diagnostic,
    { api: 'GetUserDataApi', stage: 'payload', reason: 'missing_field' });
});

test('read error fields are bounded and only fixed source tokens are copied', () => {
  const requested = Array(24).fill('userId').concat('userData');
  assert.deepEqual(createPlayerReadError('GetUserDataApi', 'payload', 'missing_field', requested).diagnostic.fields, ['userId']);
  assert.deepEqual(createPlayerReadError('GetUserDataApi', 'payload', 'missing_field', []).diagnostic,
    { api: 'GetUserDataApi', stage: 'payload', reason: 'missing_field' });
});

test('HTTP read failures identify only a fixed API and bounded numeric status without guessing a session requirement', () => {
  for (const status of [100, 199, 200, 401, 403, 404, 405, 429, 500, 501, 599]) {
    const error = createPlayerReadError('GetUserPreviewApi', 'http', 'http_rejected', ['userId', 'PRIVATE_PLAYER'], status);
    assert.ok(error instanceof PlayerReadError);
    assert.deepEqual(error.diagnostic, { api: 'GetUserPreviewApi', stage: 'http', reason: 'http_rejected', status });
    assert.ok(Object.isFrozen(error.diagnostic)); assert.equal(error.stack, undefined);
    assert.match(error.message, new RegExp(`GetUserPreviewApi.*HTTP ${status}\\b`));
    assert.match(error.message, status === 401 || status === 403 ? /服务器拒绝授权/ : /服务器拒绝读取/);
    assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE_PLAYER|需要|游戏会话|userId/);
  }
});

test('invalid HTTP status values, stage-reason pairs and API tokens become the generic safe fallback', () => {
  const secret = 'PRIVATE_PLAYER_12345678901234567890_https://private.invalid/secret';
  const invalid = [undefined, null, 0, 99, 600, -401, 401.5, '401', NaN, Infinity, secret, { status: 401, body: secret }];
  for (const status of invalid) {
    const error = createPlayerReadError('GetUserPreviewApi', 'http', 'http_rejected', [secret], status);
    assert.deepEqual(error.diagnostic, { stage: 'payload', reason: 'invalid_response' });
    assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE_PLAYER|12345678901234567890|private\.invalid|HTTP/);
  }
  for (const args of [[secret, 'http', 'http_rejected', undefined, 401], ['GetUserDataApi', 'http', 'invalid_json', undefined, 401], ['GetUserDataApi', 'payload', 'http_rejected', undefined, 401]]) {
    const error = createPlayerReadError(...args);
    assert.deepEqual(error.diagnostic, { stage: 'payload', reason: 'invalid_response' });
    assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE_PLAYER|private\.invalid|HTTP/);
  }
});
