const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const Module = require('node:module');
const modules = new Map();
function load(file) {
  file = path.resolve(__dirname, file);
  if (modules.has(file)) return modules.get(file).exports;
  const m = new Module(file, module); m.filename = file; m.paths = module.paths;
  m.require = id => id.startsWith('.') ? load(path.resolve(path.dirname(file), `${id}.ts`)) : require(id);
  modules.set(file, m);
  m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, file);
  return m.exports;
}
const { mergeBestScores, playerBestTechnicalRank, playerBestPlatinumRank } = load('../src/player-best-merge.ts');
const { persistSave, summarizeSave, readSave, listSaves, saveDirectory, serverLabelFromRaw, safeServerLabel } = load('../electron/player-save.ts');
const { playerProfiles, addPlayerCard, mergePlayerBest, scopedPlayerSaves, importManagedPlayerSave } = load('../electron/player-profiles.ts');
const { cardIdentity, serverIdentity } = load('../electron/player-identity.ts');
const { playerBestPlatinumMaxima } = load('../electron/player-best-metadata.ts');
const card = '12345678901234567890';
const chart = (overrides = {}) => ({ musicId: 101, difficulty: 3, techScore: 970000, fullCombo: false, fullBell: false, allBreak: false, ...overrides });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const jsonData = value => JSON.parse(JSON.stringify(value));
async function temporary(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ogk-best-merge-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('ogk-best-merge-')); await fsp.rm(root, { recursive: true, force: true }); });
  return root;
}
async function configured(t) {
  const root = await temporary(t);
  await fsp.writeFile(path.join(root, 'segatools.ini'), '[dns]\ndefault=server-a.invalid\n[keychip]\nid=A123-45678901234\n[aime]\naimePath=card.txt\n');
  await fsp.writeFile(path.join(root, 'card.txt'), card);
  const profiles = await playerProfiles(root);
  assert.equal(profiles.configurationError, '');
  return { root, scope: { cardId: cardIdentity(card), serverId: profiles.server.id } };
}
function snapshot(userId, host, scores, { name = 'Anonymous target', stock = 3, cards = [1], recentMusic = 999, rating = 12891 } = {}) {
  const event = (api, response, extra = {}) => ({ api, at: '2026-10-02T02:00:00.000Z', request: { userId, ...extra }, response: { userId, ...response }, connection: { baseUrl: `http://${host}/ongeki/`, encryptVersion: 0, userAgent: 'anonymous-fixture' } });
  return { events: [
    event('GetUserDataApi', { userData: { userName: name, newPlayerRating: rating, jewelCount: stock } }),
    event('GetUserMusicApi', { userMusicList: [{ userMusicDetailList: scores.map(score => ({ musicId: score.musicId, level: score.difficulty, techScoreMax: score.techScore, techScoreRank: score.techScoreRank, platinumScoreMax: score.platinumScore, platinumScoreStar: score.platinumScoreStar, battleScoreMax: score.battleScore, playCount: score.playCount, isFullCombo: score.fullCombo, isFullBell: score.fullBell, isAllBreake: score.allBreak })) }] }),
    event('GetUserCardApi', { userCardList: cards.map(cardId => ({ cardId })) }),
    event('GetUserItemApi', { userItemList: [{ itemKind: 13, itemId: 1, stock }] }),
    event('GetUserActivityApi', { kind: 2, userActivityList: [{ kind: 2, id: recentMusic, sortNumber: 1790906400 }] }, { kind: 2 })
  ] };
}
async function catalog(root) {
  const base = path.join(root, 'mu3_Data', 'StreamingAssets', 'GameData', 'A000');
  const directory = path.join(base, 'music', 'music0101'); await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(path.join(base, 'DataConfig.xml'), '<DataConfig><version><major>1</major><minor>50</minor></version></DataConfig>');
  const charts = Array.from({ length: 4 }, (_, difficulty) => `<FumenData><FumenConstIntegerPart>${difficulty === 3 ? 13 : 0}</FumenConstIntegerPart><FumenConstFractionalPart>0</FumenConstFractionalPart><FumenFile><path>${difficulty}.ogkr</path></FumenFile></FumenData>`).join('');
  await fsp.writeFile(path.join(directory, 'Music.xml'), `<MusicData><Name><id>101</id></Name><IsBonusTrack>false</IsBonusTrack>${charts}</MusicData>`);
  await fsp.writeFile(path.join(directory, '3.ogkr'), '[HEADER]\nT_TOTAL 500\n[NOTES]\n');
}
const archive = (root, id) => path.join(saveDirectory(root), 'archives', `${id}.json`);

test('pure merge takes independent best metrics/OR, max count, adds charts and preserves inputs', () => {
  const target = [chart({ techScoreRank: 9, platinumScore: 940, platinumScoreStar: 1, battleScore: 1000, playCount: 3 })];
  const source = [chart({ techScore: 1000000, platinumScore: 960, battleScore: 800, playCount: 2, fullCombo: true }), chart({ musicId: 102, techScore: 0, platinumScore: 0 })];
  const historical = [chart({ techScore: 990000, techScoreRank: 10, platinumScore: 500, platinumScoreStar: 6, battleScore: 1400, playCount: 9, allBreak: true })];
  const before = JSON.stringify([target, source, historical]);
  const result = mergeBestScores(target, [source, historical], new Map([['101:3', 1000]]));
  assert.equal(result.addedCharts, 1); assert.equal(result.improvedCharts, 1); assert.equal(result.changed, true);
  assert.deepEqual(result.scores[0], chart({ techScore: 1000000, techScoreRank: 11, platinumScore: 960, platinumScoreStar: 6, battleScore: 1400, playCount: 9, fullCombo: true, allBreak: true }));
  assert.equal(result.scores[1].techScoreRank, 1); assert.equal(result.scores[1].platinumScore, 0);
  assert.equal(JSON.stringify([target, source, historical]), before);
  const counts = mergeBestScores(target, [[chart({ techScoreRank: 9, playCount: 12 })]]);
  assert.equal(counts.improvedCharts, 0); assert.equal(counts.changed, true); assert.equal(counts.scores[0].playCount, 12);
  assert.equal(mergeBestScores(result.scores, [source, historical], new Map([['101:3', 1000]])).changed, false);
});

test('missing ranks derive at verified boundaries; explicit ranks remain independent best metrics', () => {
  const thresholds = [0, 500000, 700000, 750000, 800000, 850000, 900000, 940000, 970000, 990000, 1000000, 1007500];
  thresholds.forEach((value, i) => { assert.equal(playerBestTechnicalRank(value), i + 1); if (i) assert.equal(playerBestTechnicalRank(value - 1), i); });
  [940, 950, 960, 970, 980, 990].forEach((value, i) => { assert.equal(playerBestPlatinumRank(value, 1000), i + 1); assert.equal(playerBestPlatinumRank(value - 1, 1000), i); });
  assert.equal(playerBestPlatinumRank(1, 0), 0);
  const result = mergeBestScores([chart({ techScoreRank: 9, platinumScore: 940, platinumScoreStar: 1 })], [[chart({ techScore: 1000000, platinumScore: 980 })]], new Map([['101:3', 1000]]));
  assert.equal(result.scores[0].techScoreRank, 11); assert.equal(result.scores[0].platinumScoreStar, 5);
  const explicit = mergeBestScores([chart({ techScore: 1000000, techScoreRank: 9, platinumScore: 990, platinumScoreStar: 1 })], [[chart({ techScore: 900000, techScoreRank: 12, platinumScoreStar: 6 })]], new Map([['101:3', 1000]]));
  assert.equal(explicit.scores[0].techScoreRank, 12); assert.equal(explicit.scores[0].platinumScoreStar, 6);
  const duplicates = mergeBestScores([chart({ playCount: 1 }), chart({ fullBell: true, playCount: 2 })], [[chart({ allBreak: true })]]);
  assert.equal(duplicates.scores.length, 1); assert.equal(duplicates.scores[0].playCount, 2); assert.equal(duplicates.scores[0].fullBell, true);
});

test('cross-server/history merge persists canonical best, target context, safe provenance, and original bytes', async t => {
  const { root, scope } = await configured(t); await catalog(root);
  const foreignScope = { ...scope, serverId: serverIdentity('server-b.invalid').id };
  const target = await persistSave(root, snapshot(42, 'server-a.invalid', [chart({ techScoreRank: 9, platinumScore: 940, platinumScoreStar: 1, battleScore: 1000, playCount: 3 })]), 'json', 'target-a', scope);
  const source = await persistSave(root, snapshot(84, 'server-b.invalid', [chart({ techScore: 1000000, platinumScore: 980, playCount: 2, fullCombo: true }), chart({ musicId: 102, techScore: 0 })], { name: 'Other server name', stock: 99, cards: [1, 2, 3], recentMusic: 888, rating: 19999 }), 'json', 'source-b', foreignScope);
  await persistSave(root, snapshot(42, 'server-a.invalid', [chart({ battleScore: 1400, playCount: 9, allBreak: true })], { stock: 77 }), 'json', 'history-a', scope);
  const files = ['target-a', 'source-b', 'history-a'];
  const before = await Promise.all(files.map(async id => digest(await fsp.readFile(archive(root, id)))));
  const merged = await mergePlayerBest(root, target.id, [source.id, 'history-a'], scope.cardId, scope.serverId);
  assert.match(merged.id, /^best-/); assert.equal(merged.source, 'json'); assert.deepEqual(merged.scope, scope);
  assert.equal(merged.playerName, target.playerName); assert.deepEqual(jsonData(merged.inventory), jsonData(target.inventory)); assert.deepEqual(merged.collections, target.collections);
  assert.deepEqual(merged.recentPlays, target.recentPlays); assert.equal(merged.recentPlaysRecorded, target.recentPlaysRecorded); assert.equal(merged.newPlayerRating, undefined);
  assert.equal(merged.scores[0].techScore, 1000000); assert.equal(merged.scores[0].techScoreRank, 11); assert.equal(merged.scores[0].platinumScoreStar, 5);
  assert.equal(merged.scores[0].battleScore, 1400); assert.equal(merged.scores[0].playCount, 9); assert.equal(merged.scores[0].fullCombo, true); assert.equal(merged.scores[0].allBreak, true);
  assert.deepEqual(merged.bestMerge.sourceIds, [source.id, 'history-a']); assert.equal(merged.bestMerge.sources[0].serverLabel, 'server-b.invalid'); assert.equal(merged.serverLabel, 'server-a.invalid');
  assert.deepEqual(await Promise.all(files.map(async id => digest(await fsp.readFile(archive(root, id))))), before);
  const stored = await readSave(archive(root, merged.id));
  assert.equal(stored.raw.format, 'ogk-toolbox-player-best'); assert.equal(stored.raw.player.newPlayerRating, undefined); assert.equal(stored.raw.events, undefined);
  assert.equal(JSON.stringify(stored.raw).includes('userId'), false); assert.equal(JSON.stringify(stored.raw).includes('accessCode'), false);
  for (const exported of [stored.raw, stored]) {
    const roundtrip = summarizeSave(exported, 'json');
    assert.deepEqual(roundtrip.scores, merged.scores); assert.deepEqual(jsonData(roundtrip.inventory), jsonData(target.inventory)); assert.deepEqual(roundtrip.bestMerge, merged.bestMerge);
  }
  const imported = await importManagedPlayerSave(root, stored.raw, scope.serverId);
  assert.deepEqual(imported.scope, scope); assert.deepEqual(imported.scores, merged.scores); assert.deepEqual(imported.bestMerge, merged.bestMerge);
  const count = (await listSaves(root)).length;
  const repeated = await mergePlayerBest(root, merged.id, [source.id, 'history-a'], scope.cardId, scope.serverId);
  assert.equal(repeated.id, merged.id); assert.equal(repeated.unchanged, true); assert.equal((await listSaves(root)).length, count);
});

test('missing local chart maximum preserves known stars and explicitly warns; count-only merge is stored', async t => {
  const { root, scope } = await configured(t);
  await persistSave(root, snapshot(42, 'server-a.invalid', [chart({ platinumScore: 940, platinumScoreStar: 1, playCount: 3 })]), 'json', 'target-a', scope);
  await persistSave(root, snapshot(84, 'server-b.invalid', [chart({ platinumScore: 980, playCount: 9 })]), 'json', 'source-b', { ...scope, serverId: serverIdentity('server-b.invalid').id });
  const merged = await mergePlayerBest(root, 'target-a', ['source-b'], scope.cardId, scope.serverId);
  assert.equal(merged.scores[0].platinumScore, 980); assert.equal(merged.scores[0].platinumScoreStar, 1); assert.ok(merged.warnings.some(value => value.includes('未推断缺失星数')));
  await persistSave(root, snapshot(42, 'server-a.invalid', [chart({ playCount: 1 })]), 'json', 'count-target', scope);
  await persistSave(root, snapshot(42, 'server-a.invalid', [chart({ playCount: 7 })]), 'json', 'count-source', scope);
  const counts = await mergePlayerBest(root, 'count-target', ['count-source'], scope.cardId, scope.serverId);
  assert.notEqual(counts.id, 'count-target'); assert.equal(counts.scores[0].playCount, 7);
});

test('scope, selection, changed current server and imported provenance are validated before a new archive', async t => {
  const { root, scope } = await configured(t);
  const otherCard = await addPlayerCard(root, '22345678901234567890');
  await persistSave(root, snapshot(42, 'server-a.invalid', [chart()]), 'json', 'target-a', scope);
  await persistSave(root, snapshot(84, 'server-b.invalid', [chart({ techScore: 990000 })]), 'json', 'source-b', { ...scope, serverId: serverIdentity('server-b.invalid').id });
  await persistSave(root, snapshot(91, 'server-a.invalid', [chart()]), 'json', 'other-card', { ...scope, cardId: otherCard });
  await persistSave(root, snapshot(99, 'server-a.invalid', [chart()]), 'json', 'unassigned');
  for (const [target, ids, cardId, serverId] of [
    ['target-a', ['source-b', 'source-b'], scope.cardId, scope.serverId], ['target-a', ['target-a'], scope.cardId, scope.serverId],
    ['../target-a', ['source-b'], scope.cardId, scope.serverId], ['target-a', [], scope.cardId, scope.serverId],
    ['missing', ['source-b'], scope.cardId, scope.serverId], ['target-a', ['missing'], scope.cardId, scope.serverId],
    ['target-a', ['other-card'], scope.cardId, scope.serverId], ['target-a', ['unassigned'], scope.cardId, scope.serverId],
    ['target-a', ['source-b'], otherCard, scope.serverId], ['target-a', ['source-b'], scope.cardId, serverIdentity('server-b.invalid').id]
  ]) await assert.rejects(mergePlayerBest(root, target, ids, cardId, serverId));
  assert.equal((await listSaves(root)).length, 4);
  const merged = await mergePlayerBest(root, 'target-a', ['source-b'], scope.cardId, scope.serverId);
  const stored = await readSave(archive(root, merged.id));
  const invalid = structuredClone(stored.raw); invalid.player.scores[0].platinumScoreStar = 7;
  await assert.rejects(importManagedPlayerSave(root, invalid, scope.serverId), /合并存档字段无效/);
  const mismatched = structuredClone(stored.raw); mismatched.scope.serverId = serverIdentity('server-b.invalid').id;
  const imported = await importManagedPlayerSave(root, mismatched, scope.serverId);
  assert.equal(imported.serverId, scope.serverId); assert.equal(imported.localPlayerId, (await playerProfiles(root)).selectedPlayerId);
  assert.deepEqual(imported.scope, scope);
  // Explicit local ownership uses the selected player; the exported source scope
  // and canonical best data remain intact in the original raw archive.
  const importedRaw = await readSave(archive(root, imported.id));
  assert.deepEqual(importedRaw.raw, mismatched); assert.deepEqual(imported.scores, merged.scores);
  await fsp.writeFile(path.join(root, 'segatools.ini'), '[dns]\ndefault=server-b.invalid\n[keychip]\nid=A123-45678901234\n[aime]\naimePath=card.txt\n');
  await assert.rejects(mergePlayerBest(root, 'target-a', ['source-b'], scope.cardId, scope.serverId), /服务器配置已变化/);
});

test('imports and merges share a stable queue order and safe server labels contain only hosts', async t => {
  const { root, scope } = await configured(t);
  await persistSave(root, snapshot(42, 'server-a.invalid', [chart()]), 'json', 'target-a', scope);
  await persistSave(root, snapshot(84, 'server-b.invalid', [chart({ techScore: 990000 })]), 'json', 'source-b', { ...scope, serverId: serverIdentity('server-b.invalid').id });
  const [merged, imported] = await Promise.all([
    mergePlayerBest(root, 'target-a', ['source-b'], scope.cardId, scope.serverId),
    importManagedPlayerSave(root, snapshot(42, 'server-a.invalid', [chart({ techScore: 1000000 })]), scope.serverId)
  ]);
  assert.match(merged.id, /^best-/); assert.ok(imported.id); assert.equal((await scopedPlayerSaves(root)).length, 4);
  assert.equal(serverLabelFromRaw(snapshot(42, 'server-a.invalid:8080', [chart()])), 'server-a.invalid:8080');
  assert.equal(serverLabelFromRaw({ events: [{ connection: { baseUrl: 'http://name:secret@server.invalid/game/' } }] }), undefined);
  assert.equal(serverLabelFromRaw({ events: [{ connection: { baseUrl: 'http://server.invalid/game/?credential=x' } }] }), undefined);
  assert.equal(safeServerLabel('name:secret@server.invalid'), undefined); assert.equal(safeServerLabel('server.invalid/path'), undefined);
  assert.equal(safeServerLabel('server.invalid:8080'), 'server.invalid:8080');
  assert.equal((await playerBestPlatinumMaxima(root, [chart({ platinumScore: 980 })])).size, 0);
});
