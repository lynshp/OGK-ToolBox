const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name).exports;
  const file = path.resolve(__dirname, '../electron', `${name}.ts`), m = new Module(file, module);
  m.filename = file; m.paths = module.paths; modules.set(name, m);
  m.require = id => id.startsWith('.')
    ? load(path.relative(path.resolve(__dirname, '../electron'), path.resolve(path.dirname(file), id))) : require(id);
  m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, file);
  return m.exports;
}
const { playerGameRatingReadRows: read } = load('player-game-rating-reads');
const { PlayerReadError } = load('player-read-error');
const recentApi = 'GetUserRecentRatingApi', logApi = 'GetUserRatinglogApi';
const recent = { musicId: 101, difficultId: 10, romVersionCode: 1050004, score: 1009999 };
const log = { highestRating: 1500, newHighestRating: 15500, dataVersion: '1.50' };
const response = (api, values, extra = {}) => ({
  userId: 42, length: values.length, [api === recentApi ? 'userRecentRatingList' : 'userRatinglogList']: values, ...extra,
});
function rejects(api, data, reason, fields) {
  assert.throws(() => read(api, data), error => {
    assert.ok(error instanceof PlayerReadError);
    assert.equal(error.name, 'Error');
    assert.deepEqual(error.diagnostic, { api, stage: 'payload', reason, fields });
    assert.ok(Object.isFrozen(error.diagnostic));
    assert.ok(!error.message.includes('anonymous-private-value'));
    return true;
  });
}

test('AquaDX and MuNET decimal-string ROM codes are projected without mutating the raw Recent response', () => {
  const source = response(recentApi, [
    { ...recent, romVersionCode: '1000000', extra: 'anonymous-private-value' },
    { ...recent, romVersionCode: 1050004 },
    { ...recent, romVersionCode: '1000000' },
  ]);
  const original = structuredClone(source);
  assert.deepEqual(read(recentApi, source), [
    { ...recent, romVersionCode: 1000000 }, { ...recent }, { ...recent, romVersionCode: 1000000 },
  ]);
  assert.deepEqual(source, original);
});

test('ROM code compatibility includes the exact nonnegative Int32 endpoints', () => {
  for (const romVersionCode of [0, '0', 2147483647, '2147483647']) {
    assert.equal(read(recentApi, response(recentApi, [{ ...recent, romVersionCode }]))[0].romVersionCode, Number(romVersionCode));
  }
});

test('ROM decimal strings never admit signs, spaces, decimals, exponent notation, leading zeros or coercible objects', () => {
  for (const romVersionCode of ['', ' 1000000', '1000000 ', '+1000000', '-0', '-1', '1e6', '1000000.0', '01000000', '00', '0x10', 'NaN', 'Infinity', null, true, {}, []]) {
    rejects(recentApi, response(recentApi, [{ ...recent, romVersionCode }]), 'invalid_type', ['romVersionCode']);
  }
});

test('numeric and decimal ROM codes outside Int32 are rejected rather than truncated', () => {
  for (const romVersionCode of [-1, 2147483648, '2147483648', '99999999999', '9007199254740993']) {
    rejects(recentApi, response(recentApi, [{ ...recent, romVersionCode }]), 'value_out_of_range', ['romVersionCode']);
  }
  for (const romVersionCode of [1.5, NaN, Infinity]) {
    rejects(recentApi, response(recentApi, [{ ...recent, romVersionCode }]), 'invalid_type', ['romVersionCode']);
  }
});

test('ROM string support does not coerce score, song identity, difficulty or rating-history values', () => {
  for (const field of ['musicId', 'difficultId', 'score']) {
    rejects(recentApi, response(recentApi, [{ ...recent, [field]: String(recent[field]) }]), 'invalid_type', [field]);
  }
  for (const field of ['highestRating', 'newHighestRating']) {
    rejects(logApi, response(logApi, [{ ...log, [field]: String(log[field]) }]), 'invalid_type', [field]);
  }
});

test('missing Rating values retain the exact safe field diagnostic', () => {
  for (const [api, row, fields] of [[recentApi, recent, Object.keys(recent)], [logApi, log, Object.keys(log)]]) {
    for (const field of fields) {
      const incomplete = { ...row }; delete incomplete[field];
      rejects(api, response(api, [incomplete]), 'missing_field', [field]);
    }
  }
});

test('both Rating initialization responses still require a valid declared length matching the array', () => {
  for (const [api, row, field] of [[recentApi, recent, 'userRecentRatingList'], [logApi, log, 'userRatinglogList']]) {
    const missing = response(api, [row]); delete missing.length;
    rejects(api, missing, 'missing_field', ['length']);
    for (const length of ['1', 1.5, null]) rejects(api, response(api, [row], { length }), 'invalid_type', ['length']);
    rejects(api, response(api, [row], { length: -1 }), 'value_out_of_range', ['length']);
    rejects(api, response(api, [row], { length: 2 }), 'count_mismatch', ['length', field]);
    assert.deepEqual(read(api, response(api, [])), []);
  }
});

test('Rating lists never treat a missing, null, object or malformed row as an empty response', () => {
  for (const [api, field] of [[recentApi, 'userRecentRatingList'], [logApi, 'userRatinglogList']]) {
    rejects(api, { userId: 42, length: 0 }, 'missing_field', [field]);
    for (const value of [null, {}, 'anonymous-private-value']) rejects(api, { userId: 42, length: 0, [field]: value }, 'invalid_type', [field]);
    for (const row of [null, [], 'anonymous-private-value']) rejects(api, response(api, [row]), 'invalid_type', [field]);
  }
});

test('Recent preserves order and repeated charts while applying protocol difficulty and capacity bounds', () => {
  const source = Array.from({ length: 30 }, (_, i) => ({ ...recent, romVersionCode: String(1000000 + i), score: 990000 + i }));
  assert.deepEqual(read(recentApi, response(recentApi, source)), source.map(row => ({ ...row, romVersionCode: Number(row.romVersionCode) })));
  rejects(recentApi, response(recentApi, [...source, recent]), 'value_out_of_range', ['userRecentRatingList']);
  for (const difficultId of [4, 5, 9, 11]) rejects(recentApi, response(recentApi, [{ ...recent, difficultId }]), 'value_out_of_range', ['difficultId']);
  for (const difficultId of [0, 1, 2, 3, 10]) assert.equal(read(recentApi, response(recentApi, [{ ...recent, difficultId }]))[0].difficultId, difficultId);
});

test('Rating history keeps byte-bounded two or three-part version semantics and only normalizes the projection', () => {
  const source = response(logApi, [{ ...log, dataVersion: '1.5.02', extra: 'anonymous-private-value' }]);
  assert.deepEqual(read(logApi, source), [{ ...log, dataVersion: '1.05' }]);
  assert.equal(source.userRatinglogList[0].dataVersion, '1.5.02');
  for (const dataVersion of ['2026-10-04', '1', '1.50.0.1', '1.50 ', '', null]) rejects(logApi, response(logApi, [{ ...log, dataVersion }]), 'invalid_type', ['dataVersion']);
  for (const dataVersion of ['1.256', '256.50', '1.50.256']) rejects(logApi, response(logApi, [{ ...log, dataVersion }]), 'value_out_of_range', ['dataVersion']);
  rejects(logApi, response(logApi, [log, { ...log, dataVersion: '1.50.00' }]), 'duplicate_version', ['dataVersion']);
});
