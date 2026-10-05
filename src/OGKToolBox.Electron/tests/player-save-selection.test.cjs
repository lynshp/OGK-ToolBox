const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const file = path.resolve(__dirname, '../src/player-save-selection.ts');
const loaded = new Module(file, module); loaded.filename = file; loaded.paths = module.paths;
loaded._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { belongsToPlayer, latestSave, hasCompletedCaptureUpdate, rememberCompletedCaptures } = loaded.exports;
const captureA = `game-${'a'.repeat(32)}`, captureB = `game-${'b'.repeat(32)}`;
const player = { id: 'player-a', machineId: 'machine-a', cardId: 'card-a', name: '匿名玩家' };
const make = (patch = {}) => ({ id: 'save-a', source: 'game', updatedAt: '2026-10-04T00:00:00.000Z', sequence: 1,
  scope: { serverId: 'server-a', cardId: 'card-a' }, playerName: '匿名玩家', scores: [], collections: [], warnings: [], ...patch });
const changed = (before, after) => hasCompletedCaptureUpdate(before, after, 'server-a', 'card-a', player);

test('first snapshot establishes a baseline rather than announcing a new Mod capture', () => {
  assert.equal(changed(null, [make()]), false);
});
test('automatic selection uses read scores even when an unuploaded local edit has a later time or higher score', () => {
  const local = make({ id: 'local-edit', source: 'json', updatedAt: '2026-10-05T02:00:00Z', edit: { version: 1, playerId: player.id, resources: [], scores: [] }, scores: [{ musicId: 1, difficulty: 3, techScore: 1010000 }] });
  for (const source of ['game', 'direct']) {
    const read = make({ id: 'server-read', source, updatedAt: '2026-10-05T01:00:00Z', scores: [{ musicId: 1, difficulty: 3, techScore: 900000 }] });
    const selected = latestSave([local, read], 'server-a', 'card-a', player);
    assert.equal(selected.id, read.id);
    assert.equal(selected.scores[0].techScore, 900000);
    assert.equal(local.scores[0].techScore, 1010000, 'exportable local history remains intact');
  }
});
test('foreign, incomplete or invalid-time reads do not displace the only local edited archive', () => {
  const local = make({ id: 'local-edit', source: 'json', updatedAt: '2026-10-05T02:00:00Z', edit: { version: 1, playerId: player.id, resources: [], scores: [] } });
  for (const read of [make({ scope: { serverId: 'other', cardId: 'card-a' } }), make({ warnings: ['Music：分页未收齐。'] }), make({ source: 'direct', updatedAt: 'invalid' })]) {
    assert.equal(latestSave([local, read], 'server-a', 'card-a', player).id, local.id);
  }
});
test('a distinct completed Mod archive triggers selection once', () => {
  const before = [make()], next = [...before, make({ id: 'save-b', sequence: 2 })];
  assert.equal(changed(before, next), true);
  assert.equal(changed(next, structuredClone(next)), false);
});
test('same Mod ID with a fresh revision triggers without relying on a new archive ID', () => {
  const before = [make()], next = [make({ updatedAt: '2026-10-04T00:01:00.000Z', sequence: 2 })];
  assert.equal(changed(before, next), true);
  assert.equal(changed(next, structuredClone(next)), false);
});
test('a partially read Mod capture waits for the missing core pages', () => {
  const partial = make({ warnings: ['Music：分页未收齐。', 'Item：尚未读取。'] });
  assert.equal(changed([], [partial]), false);
  assert.equal(changed([partial], [make()]), true);
});
test('partial category pages remain incomplete while general backup caveats do not block completed capture', () => {
  assert.equal(changed([], [make({ warnings: ['Music（类别 2）：分页未收齐。'] })]), false);
  assert.equal(changed([], [make({ warnings: ['仅包含已成功读取的数据；不代表完整游玩历史或可直接回服的备份。'] })]), true);
});
test('deduplicated direct or JSON archive gets selected through an explicit completed capture marker', () => {
  for (const source of ['direct', 'json']) {
    const original = make({ source });
    const captured = { ...original, latestCapture: { id: captureA, at: '2026-10-04T00:03:00.000Z' } };
    assert.equal(changed([original], [captured]), true);
    assert.equal(changed([captured], [structuredClone(captured)]), false);
    assert.equal(changed([captured], [{ ...captured, latestCapture: { id: captureA, at: '2026-10-04T00:04:00.000Z' } }]), true);
  }
});
test('an alias by itself and unrelated direct or JSON reads never announce completed Mod capture', () => {
  assert.equal(changed([make({ source: 'direct' })], [make({ source: 'direct', captureIds: ['game-anonymous'] })]), false);
  assert.equal(changed([], [make({ source: 'json' }), make({ source: 'direct', id: 'save-direct' })]), false);
});
test('foreign card server or owned player cannot take the current player selection', () => {
  for (const foreign of [make({ scope: { serverId: 'server-b', cardId: 'card-a' } }), make({ scope: { serverId: 'server-a', cardId: 'card-b' } }), make({ localPlayerId: 'player-b' }), make({ scope: undefined })]) {
    assert.equal(changed([], [foreign]), false);
  }
});
test('empty bindings do not infer capture ownership from player imported history', () => {
  assert.equal(hasCompletedCaptureUpdate([], [make({ localPlayerId: 'player-a' })], '', '', player), false);
  const importedPlayer = { ...player, importedSaveIds: ['save-a'] };
  assert.equal(belongsToPlayer(make({ localPlayerId: 'player-b' }), 'server-a', 'card-a', importedPlayer), false);
});
test('newest selection accounts for a completed deduplicated capture while retaining its original time and sequence', () => {
  const original = make({ source: 'direct', updatedAt: '2026-10-03T00:00:00.000Z', latestCapture: { id: captureA, at: '2026-10-04T00:03:00.000Z' } });
  const laterImport = make({ id: 'import', source: 'json', updatedAt: '2026-10-04T00:01:00.000Z', sequence: 2 });
  const other = make({ id: 'foreign', updatedAt: '2026-10-04T00:04:00.000Z', scope: { serverId: 'server-b', cardId: 'card-a' } });
  assert.equal(latestSave([laterImport, original, other], 'server-a', 'card-a', player).id, original.id);
  assert.equal(original.updatedAt, '2026-10-03T00:00:00.000Z');
  assert.equal(original.sequence, 1);
});

test('invalid marker identity or date cannot announce completion or influence newest ordering', () => {
  const newer = make({ id: 'newer-import', source: 'json', updatedAt: '2026-10-04T00:01:00.000Z' });
  for (const latestCapture of [
    { id: 'game-anonymous', at: '2026-10-05T00:00:00.000Z' },
    { id: `game-${'A'.repeat(32)}`, at: '2026-10-05T00:00:00.000Z' },
    { id: captureA, at: 'not-a-date' },
    { id: captureA, at: Infinity },
    { id: 1, at: '2026-10-05T00:00:00.000Z' },
  ]) {
    const invalid = make({ latestCapture });
    assert.equal(changed([], [invalid]), false);
    assert.equal(latestSave([invalid, newer], 'server-a', 'card-a', player).id, newer.id);
  }
});
test('confirmed marker backfill for the same legacy session and time is not a new capture', () => {
  const legacy = make({ id: captureA, sessionId: 'a'.repeat(32), warnings: ['仅包含已成功读取的数据；不代表完整游玩历史或可直接回服的备份。'] });
  const marked = { ...legacy, latestCapture: { id: captureA, at: legacy.updatedAt } };
  assert.equal(changed([legacy], [marked]), false);
  assert.equal(changed([legacy], [{ ...marked, sequence: 2 }]), false);
  assert.equal(changed([{ ...legacy, warnings: ['Item：尚未读取。'] }], [marked]), true);
  assert.equal(changed([marked], [{ ...marked, latestCapture: { id: captureA, at: '2026-10-04T00:01:00.000Z' } }]), true);
});
test('older or equal-time markers and legacy sequence changes cannot announce a fresh completion', () => {
  const captured = make({ latestCapture: { id: captureA, at: '2026-10-04T00:03:00.000Z' } });
  assert.equal(changed([captured], [{ ...captured, latestCapture: { id: captureA, at: '2026-10-04T00:02:00.000Z' } }]), false);
  assert.equal(changed([captured], [{ ...captured, latestCapture: { id: captureB, at: captured.latestCapture.at } }]), false);
  assert.equal(changed([make()], [make({ sequence: 99 })]), false);
});
test('completion baseline survives partial rescans without retaining save payloads', () => {
  const complete = make({ id: captureA, latestCapture: { id: captureA, at: '2026-10-04T00:03:00.000Z' } });
  let baseline = rememberCompletedCaptures(new Map(), [complete]);
  const partial = { ...complete, latestCapture: undefined, warnings: ['Music：分页未收齐。'], sequence: 2 };
  assert.equal(hasCompletedCaptureUpdate([complete], [partial], 'server-a', 'card-a', player, baseline), false);
  baseline = rememberCompletedCaptures(baseline, [partial]);
  assert.equal(hasCompletedCaptureUpdate([partial], [{ ...complete, sequence: 3 }], 'server-a', 'card-a', player, baseline), false);
  assert.deepEqual(Object.keys(baseline.get(captureA)).sort(), ['cardId', 'playerId', 'revision', 'serverId']);
  const next = { ...complete, latestCapture: { id: captureB, at: '2026-10-04T00:04:00.000Z' } };
  assert.equal(hasCompletedCaptureUpdate([partial], [next], 'server-a', 'card-a', player, baseline), true);
  baseline = rememberCompletedCaptures(baseline, [next]);
  assert.equal(hasCompletedCaptureUpdate([next], [next], 'server-a', 'card-a', player, baseline), false);
});
test('baseline uses exact archive ownership and removes deleted archives', () => {
  const foreign = make({ id: captureA, localPlayerId: 'player-b', scope: { serverId: 'server-b', cardId: 'card-b' }, latestCapture: { id: captureA, at: '2026-10-04T00:03:00.000Z' } });
  let baseline = rememberCompletedCaptures(new Map(), [foreign]);
  const current = make({ id: captureA, localPlayerId: player.id, latestCapture: { id: captureA, at: '2026-10-04T00:02:00.000Z' } });
  assert.equal(hasCompletedCaptureUpdate([foreign], [current], 'server-a', 'card-a', player, baseline), true);
  baseline = rememberCompletedCaptures(baseline, []);
  assert.equal(baseline.size, 0);
});
