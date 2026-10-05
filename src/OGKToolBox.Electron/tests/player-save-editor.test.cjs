const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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
const { getPlayerSaveEditor, preparePlayerSaveEdit, applyPlayerSaveEditorPatch, validatePlayerSaveEditorPatch } = load('../electron/player-save-editor.ts');
const { summarizeSave, persistSave, saveDirectory } = load('../electron/player-save.ts');
const playerId = 'anonymous-player';
const score = (extra = {}) => ({ musicId: 101, difficulty: 3, techScore: 950000, platinumScore: 950, battleScore: 5000, fullCombo: false, fullBell: false, allBreak: false, ...extra });
const wireScore = (extra = {}) => ({ musicId: 101, level: 3, techScoreMax: 990000, techScoreRank: 10, platinumScoreMax: 970, platinumScoreStar: 4, battleScoreMax: 8000, playCount: 8, isFullCombo: true, isFullBell: false, isAllBreake: false, untouchedScoreField: 7, ...extra });
function fixture() {
  return { userData: { userName: 'Anonymous', userId: 42, point: 30, jewelCount: 20, medalCount: 5, shizukuCount: 1, newPlayerRating: 12000, untouched: 'preserved' },
    userItemList: [4, 9, 11, 12, 13, 14, 20].map(kind => ({ itemKind: kind, itemId: 1, stock: 1, isValid: true, untouchedItemField: 4 })),
    userChapterList: [{ chapterId: 10, jewelCount: 12, lastPlayDate: '2026-01-01', clearedMusicCount: 3 }],
    userStoryList: [{ storyId: 20, jewelCount: 15, category: 4 }],
    userMusicList: [wireScore()],
    userPlaylogList: [{ musicId: 101, level: 3, techScore: 990000, userPlayDate: '2026-01-01T00:00:00Z' }],
    request: { musicId: 101, level: 3, techScoreMax: 990000 }, rivalData: { musicId: 101, level: 3, techScoreMax: 990000 } };
}
async function temporary(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ogk-save-editor-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('ogk-save-editor-')); await fsp.rm(root, { recursive: true, force: true }); });
  return root;
}
async function catalog(root, { header = '[HEADER]\nT_TOTAL 500\n[NOTES]\n', missingChart = false } = {}) {
  const base = path.join(root, 'mu3_Data', 'StreamingAssets', 'GameData', 'A000');
  await fsp.mkdir(base, { recursive: true });
  await fsp.writeFile(path.join(base, 'DataConfig.xml'), '<DataConfig><version><major>1</major><minor>50</minor></version></DataConfig>');
  const music = path.join(base, 'music', 'music0101'); await fsp.mkdir(music, { recursive: true });
  await fsp.writeFile(path.join(music, 'Music.xml'), `<MusicData><Name><id>101</id><str>Anonymous song</str></Name>${Array.from({ length: 5 }, (_, i) => `<FumenData><FumenConstIntegerPart>12</FumenConstIntegerPart><FumenConstFractionalPart>50</FumenConstFractionalPart><FumenFile><path>${i}.ogkr</path></FumenFile></FumenData>`).join('')}</MusicData>`);
  if (!missingChart) for (const difficulty of [3, 4]) await fsp.writeFile(path.join(music, `${difficulty}.ogkr`), header);
  for (const [directory, filename] of [['limitbreak', 'LimitBreakItem.xml'], ['present', 'Present.xml'], ['gachaticket', 'GachaTicket.xml'], ['kaikaitem', 'KaikaItem.xml'], ['expupitem', 'ExpUpItem.xml'], ['intimateupitem', 'IntimateUpItem.xml'], ['unlockitem', 'UnlockItem.xml']]) {
    const folder = path.join(base, directory, `${directory}0002`); await fsp.mkdir(folder, { recursive: true });
    await fsp.writeFile(path.join(folder, filename), '<Data><Name><id>2</id><str>Anonymous catalog item</str></Name></Data>');
  }
  for (const [directory, filename, id] of [['chapter', 'Chapter.xml', 11], ['story', 'Story.xml', 21]]) {
    const folder = path.join(base, directory, `${directory}${id}`); await fsp.mkdir(folder, { recursive: true });
    await fsp.writeFile(path.join(folder, filename), `<Data><Name><id>${id}</id><str>Anonymous ${directory}</str></Name></Data>`);
  }
  return base;
}
const summary = (raw, id = 'source') => summarizeSave(raw, 'json', id);
const empty = () => ({ resources: [], scores: [] });
const editRaw = (prepared, id = 'edit-anonymous') => summary(prepared.raw, id);

test('editor lists every requested resource from game catalog and preserves absent balances as unknown', async t => {
  const root = await temporary(t); await catalog(root); const raw = fixture();
  const state = await getPlayerSaveEditor(root, summary(raw), raw, playerId);
  const resources = new Map(state.resources.map(row => [row.key, row]));
  assert.equal(resources.get('data:point').max, 999999999); assert.equal(resources.get('data:jewelCount').max, 99999);
  assert.equal(resources.get('data:medalCount').max, 999999); assert.equal(resources.get('data:shizukuCount').max, 999999);
  assert.equal(resources.get('item:4:1').max, 9999); assert.equal(resources.get('item:11:1').max, 99);
  for (const kind of [12, 13, 14]) assert.equal(resources.get(`item:${kind}:1`).max, 9999);
  assert.equal(resources.get('item:9:1').max, 2147483647); assert.equal(resources.get('item:9:1').limitKind, 'field');
  assert.equal(resources.get('item:20:1').removable, false); assert.equal(resources.get('item:20:2').binary, true);
  assert.equal(resources.get('chapter:10').value, 12); assert.equal(resources.get('story:20').value, 15);
  assert.equal(resources.get('chapter:11').value, null); assert.equal(resources.get('story:21').value, null);
  assert.equal(resources.get('item:4:2').value, null); assert.equal(state.techScoreMax, 1010000);
  assert.deepEqual(state.scoreConstraints.filter(row => row.editable).map(row => [row.difficulty, row.platinumMax]), [[3, 1000], [4, 1000]]);
});

test('absolute resource patch preserves original identity, gameplay progress and unrelated fields', async t => {
  const root = await temporary(t); await catalog(root); const raw = fixture(), before = JSON.stringify(raw);
  const prepared = await preparePlayerSaveEdit(root, summary(raw), raw, { resources: [
    { key: 'data:point', value: 999999999 }, { key: 'data:jewelCount', value: 99999 }, { key: 'data:medalCount', value: 999999 }, { key: 'data:shizukuCount', value: 999999 },
    { key: 'item:4:1', value: 9999 }, { key: 'item:9:1', value: 2147483647 }, { key: 'item:11:1', value: 99 },
    { key: 'item:12:1', value: 9999 }, { key: 'item:13:1', value: 9999 }, { key: 'item:14:1', value: 9999 },
    { key: 'chapter:10', value: 99999 }, { key: 'story:20', value: 99999 }
  ], scores: [] }, playerId);
  assert.equal(JSON.stringify(raw), before); assert.equal(prepared.raw.userData.userId, 42); assert.equal(prepared.raw.userData.userName, 'Anonymous');
  assert.equal(prepared.raw.userData.newPlayerRating, 12000); assert.equal(prepared.raw.userData.untouched, 'preserved');
  assert.equal(prepared.raw.userChapterList[0].clearedMusicCount, 3); assert.equal(prepared.raw.userStoryList[0].category, 4);
  assert.equal(prepared.raw.userItemList[0].untouchedItemField, 4); assert.deepEqual(prepared.raw.userPlaylogList, raw.userPlaylogList);
  assert.deepEqual(prepared.raw.request, raw.request); assert.deepEqual(prepared.raw.rivalData, raw.rivalData);
  assert.equal(prepared.edit.parentId, 'source'); assert.equal(prepared.edit.playerId, playerId); assert.equal(prepared.unchanged, false);
  const saved = editRaw(prepared); assert.equal(saved.newPlayerRating, undefined);
  assert.equal(saved.inventory.items.find(row => row.itemKind === 6).stock, 999999999);
  assert.equal(saved.edit.resources.length, 12);
});

test('caps, duplicate keys, arbitrary fields, negative/fractional values and unknown resources are rejected', async t => {
  const root = await temporary(t); await catalog(root); const raw = fixture(), saved = summary(raw), state = await getPlayerSaveEditor(root, saved, raw, playerId);
  for (const resource of state.resources.filter(row => row.editable)) assert.throws(() => validatePlayerSaveEditorPatch({ resources: [{ key: resource.key, value: resource.max + 1 }], scores: [] }, state, saved.scores));
  for (const value of [-1, 1.5, NaN, Infinity, '3']) assert.throws(() => validatePlayerSaveEditorPatch({ resources: [{ key: 'data:point', value }], scores: [] }, state, saved.scores));
  for (const patch of [{ resources: [{ key: 'data:point', value: 3, userId: 1 }], scores: [] }, { resources: [{ key: 'item:4:999', value: 1 }], scores: [] }, { resources: [{ key: 'data:point', value: 3 }, { key: 'data:point', value: 3 }], scores: [] }, { ...empty(), userId: 5 }, empty()]) assert.throws(() => validatePlayerSaveEditorPatch(patch, state, saved.scores));
  assert.throws(() => validatePlayerSaveEditorPatch({ resources: [{ key: 'item:20:1', value: 0 }], scores: [] }, state, saved.scores), /不能取消/);
});

test('new local resource rows use catalog IDs without inventing identity or progression', async t => {
  const root = await temporary(t); await catalog(root); const raw = { userMusicList: [wireScore()] };
  const prepared = await preparePlayerSaveEdit(root, summary(raw), raw, { resources: [{ key: 'data:point', value: 25 }, { key: 'item:13:2', value: 5 }, { key: 'item:20:2', value: 1 }, { key: 'chapter:11', value: 999 }, { key: 'story:21', value: 111 }], scores: [] }, playerId);
  assert.deepEqual(prepared.raw.userData, { point: 25 }); assert.deepEqual(prepared.raw.userChapterList, [{ chapterId: 11, jewelCount: 999 }]);
  assert.deepEqual(prepared.raw.userStoryList, [{ storyId: 21, jewelCount: 111 }]);
  assert.equal(JSON.stringify(prepared.raw).includes('userId'), false); assert.equal(JSON.stringify(prepared.raw).includes('clearStatus'), false);
  const state = await getPlayerSaveEditor(root, editRaw(prepared), prepared.raw, playerId); assert.equal(state.resources.find(row => row.key === 'chapter:11').value, 999);
});

test('same chart in multiple captured pages is replaced exactly, including reductions and zero', async t => {
  const root = await temporary(t); await catalog(root);
  const event = (row, at) => ({ api: 'GetUserMusicApi', at, request: { userId: 42 }, response: { userId: 42, length: 1, userMusicList: [{ length: 1, userMusicDetailList: [row] }] }, connection: { baseUrl: 'http://anonymous.invalid/ongeki/', encryptVersion: 0, userAgent: 'fixture' } });
  const raw = { events: [event(wireScore(), '2026-01-01T00:00:00Z'), event(wireScore({ techScoreMax: 1000000, isAllBreake: true }), '2026-01-02T00:00:00Z')] }, before = JSON.stringify(raw);
  const prepared = await preparePlayerSaveEdit(root, summary(raw), raw, { resources: [], scores: [score({ techScore: 0, platinumScore: 0, battleScore: 0 })] }, playerId);
  const saved = editRaw(prepared); assert.equal(saved.scores[0].techScore, 0); assert.equal(saved.scores[0].allBreak, false); assert.equal(saved.scores[0].fullCombo, false);
  assert.equal(saved.scores[0].techScoreRank, 1); assert.equal(saved.scores[0].platinumScoreStar, 0); assert.equal(saved.scores[0].playCount, 8);
  assert.equal(JSON.stringify(raw), before);
  prepared.raw.events.forEach((row, i) => { assert.deepEqual(row.request, raw.events[i].request); assert.deepEqual(row.connection, raw.events[i].connection); assert.equal(row.response.userMusicList[0].length, 1); assert.equal(row.response.userMusicList[0].userMusicDetailList[0].untouchedScoreField, 7); });
});

test('technical rank, platinum stars and game achievement dependencies derive from selected score', async t => {
  const root = await temporary(t); await catalog(root); const raw = fixture();
  const prepared = await preparePlayerSaveEdit(root, summary(raw), raw, { resources: [], scores: [score({ techScore: 1000000, platinumScore: 990, allBreak: true, fullCombo: false })] }, playerId);
  const saved = editRaw(prepared); assert.equal(saved.scores[0].techScoreRank, 11); assert.equal(saved.scores[0].platinumScoreStar, 6); assert.equal(saved.scores[0].fullCombo, true); assert.equal(saved.scores[0].allBreak, true); assert.equal(saved.scores[0].fullBell, false);
  const maximum = await preparePlayerSaveEdit(root, summary(raw), raw, { resources: [], scores: [score({ techScore: 1010000, fullCombo: false, allBreak: false, fullBell: false })] }, playerId);
  assert.equal(maximum.edit.scores[0].fullCombo, true); assert.equal(maximum.edit.scores[0].fullBell, true); assert.equal(maximum.edit.scores[0].allBreak, true);
});

test('editing another full-score metric preserves the packed full-score count but explicit reductions replace it', async t => {
  const root = await temporary(t); await catalog(root);
  const raw = fixture(); raw.userMusicList[0] = wireScore({ techScoreMax: 1019999, isAllBreake: true, isFullCombo: true, isFullBell: true });
  const original = JSON.stringify(raw), baseline = summary(raw);
  assert.equal(baseline.scores[0].techScore, 1010000);
  const prepared = await preparePlayerSaveEdit(root, baseline, raw, { resources: [], scores: [score({ techScore: 1010000, platinumScore: 990 })] }, playerId);
  assert.equal(prepared.raw.userMusicList[0].techScoreMax, 1019999); assert.equal(editRaw(prepared).scores[0].techScore, 1010000);
  assert.equal(editRaw(prepared).scores[0].platinumScore, 990); assert.equal(JSON.stringify(raw), original);
  const reduced = await preparePlayerSaveEdit(root, baseline, raw, { resources: [], scores: [score({ techScore: 1009999 })] }, playerId);
  assert.equal(reduced.raw.userMusicList[0].techScoreMax, 1009999); assert.equal(editRaw(reduced).scores[0].techScore, 1009999);
  const plainAlias = applyPlayerSaveEditorPatch({ userMusicList: [wireScore({ techScoreMax: undefined, techScore: 1000000 })] }, [], [{ ...score({ techScore: 1010000 }), techScoreRank: 12, platinumScoreStar: 2, playCount: 8 }]);
  assert.equal(plainAlias.userMusicList[0].techScore, 1010000);
});

test('scores require a real local chart and reject unknown fields, score limits and invalid flags', async t => {
  const root = await temporary(t); await catalog(root); const raw = fixture(), saved = summary(raw), state = await getPlayerSaveEditor(root, saved, raw, playerId);
  for (const row of [score({ difficulty: 10 }), score({ musicId: 999 }), score({ difficulty: 0 }), score({ techScore: 1010001 }), score({ platinumScore: 1001 }), score({ battleScore: 2147483648 }), score({ playCount: 0 }), score({ techScoreRank: 12 }), score({ platinumScoreStar: 6 }), score({ fullBell: 1 }), score({ techScore: -1 }), score({ techScore: 1.5 })]) assert.throws(() => validatePlayerSaveEditorPatch({ resources: [], scores: [row] }, state, saved.scores));
  assert.throws(() => validatePlayerSaveEditorPatch({ resources: [], scores: [score(), score()] }, state, saved.scores));
});

test('missing platinum header allows technical editing while preserving a recorded platinum value/star', async t => {
  const root = await temporary(t); await catalog(root, { header: '[HEADER]\n[NOTES]\n' }); const raw = fixture();
  const state = await getPlayerSaveEditor(root, summary(raw), raw, playerId); assert.equal(state.scoreConstraints.find(row => row.difficulty === 3).platinumMax, null);
  const prepared = await preparePlayerSaveEdit(root, summary(raw), raw, { resources: [], scores: [score({ platinumScore: 970 })] }, playerId);
  assert.equal(editRaw(prepared).scores[0].platinumScoreStar, 4);
  await assert.rejects(preparePlayerSaveEdit(root, summary(raw), raw, { resources: [], scores: [score({ platinumScore: 971 })] }, playerId), /白金/);
});

test('raw LUNATIC level 10 maps to local 4 and adding a chart emits protocol level 10', async t => {
  const root = await temporary(t); await catalog(root); const raw = { userData: { userName: 'Anonymous' }, userMusicList: [wireScore({ level: 10 })] };
  const prepared = await preparePlayerSaveEdit(root, summary(raw), raw, { resources: [], scores: [score({ difficulty: 4 })] }, playerId);
  assert.equal(prepared.raw.userMusicList[0].level, 10); assert.equal(editRaw(prepared).scores[0].difficulty, 4);
  const added = await preparePlayerSaveEdit(root, summary(fixture()), fixture(), { resources: [], scores: [score({ difficulty: 4 })] }, playerId);
  assert.equal(added.raw.userMusicDetailList[0].level, 10); assert.equal(added.raw.userMusicDetailList[0].playCount, 1);
});

test('MuNET flat score aliases and nested toolbox wrappers preserve source-specific fields', async t => {
  const root = await temporary(t); await catalog(root); const raw = { summary: { scores: [], id: 'export-source', source: 'json' }, exportNote: 'preserved', raw: { userData: { userName: 'Anonymous', userId: 42 }, userMusicList: [wireScore({ techScoreMax: undefined, techScore: 990000, platinumScoreMax: undefined, platinumScore: 970, battleScoreMax: undefined, battleScore: 8000, level: 10, sourceExportField: 'preserved' })] } };
  const prepared = await preparePlayerSaveEdit(root, summary(raw), raw, { resources: [], scores: [score({ difficulty: 4 })] }, playerId);
  assert.equal(prepared.raw.exportNote, 'preserved'); assert.equal(prepared.raw.raw.userMusicList[0].sourceExportField, 'preserved'); assert.equal(prepared.raw.raw.userMusicList[0].techScore, 950000); assert.equal(prepared.raw.raw.userMusicList[0].techScoreMax, undefined); assert.equal(editRaw(prepared).edit.playerId, playerId);
  const array = [wireScore()]; const modified = applyPlayerSaveEditorPatch(array, [], [{ ...score(), techScoreRank: 9, platinumScoreStar: 2, playCount: 8 }]); assert.equal(Array.isArray(modified.userMusicDetailList), true); assert.equal(summary(modified).scores[0].techScore, 950000);
  const wrappedArray = { summary: { scores: [] }, exportNote: 'preserved', raw: array }; const modifiedWrapper = applyPlayerSaveEditorPatch(wrappedArray, [], [{ ...score(), techScoreRank: 9, platinumScoreStar: 2, playCount: 8 }]); assert.equal(modifiedWrapper.exportNote, 'preserved'); assert.equal(summary(modifiedWrapper).scores[0].techScore, 950000);
});

test('saving twice accumulates export edits and latest values override the same keys', async t => {
  const root = await temporary(t); await catalog(root); const raw = fixture();
  const first = await preparePlayerSaveEdit(root, summary(raw), raw, { resources: [{ key: 'data:point', value: 500 }, { key: 'item:13:1', value: 55 }], scores: [] }, playerId);
  const next = await preparePlayerSaveEdit(root, editRaw(first, 'edit-first'), first.raw, { resources: [{ key: 'data:point', value: 600 }], scores: [score()] }, playerId);
  assert.equal(next.edit.parentId, 'edit-first'); assert.deepEqual(next.edit.resources, [{ key: 'data:point', value: 600 }, { key: 'item:13:1', value: 55 }]); assert.equal(next.edit.scores.length, 1);
  const final = editRaw(next, 'edit-second'); assert.equal(final.edit.resources.length, 2); assert.equal(final.edit.scores.length, 1);
});

test('canonical best edits retain provenance and resolve omitted balances only from their target archive', async t => {
  const root = await temporary(t); await catalog(root); const original = fixture(), scope = { serverId: 'a'.repeat(64), cardId: 'b'.repeat(64) }; await persistSave(root, original, 'json', 'original-target', scope);
  const baseline = summary(original);
  const raw = { format: 'ogk-toolbox-player-best', version: 1, scope, serverLabel: 'anonymous.invalid', bestMerge: { version: 1, targetId: 'original-target', sourceIds: ['other-source'], createdAt: '2026-01-01T00:00:00Z', sources: [{ id: 'other-source', serverId: 'c'.repeat(64), updatedAt: '2026-01-01T00:00:00Z' }] }, player: { playerName: baseline.playerName, scores: baseline.scores, inventory: baseline.inventory, collections: baseline.collections, recentPlays: [], recentPlaysRecorded: false, warnings: [] } };
  const state = await getPlayerSaveEditor(root, summary(raw, 'best-source'), raw, playerId); assert.equal(state.resources.find(row => row.key === 'chapter:10').value, 12); assert.equal(state.resources.find(row => row.key === 'data:point').value, 30);
  const prepared = await preparePlayerSaveEdit(root, summary(raw, 'best-source'), raw, { resources: [{ key: 'data:point', value: 500 }, { key: 'chapter:10', value: 88 }], scores: [score()] }, playerId);
  assert.deepEqual(prepared.raw.bestMerge, raw.bestMerge); assert.equal(prepared.raw.player.inventory.items.find(row => row.itemKind === 6).stock, 500);
  const updated = await getPlayerSaveEditor(root, editRaw(prepared), prepared.raw, playerId); assert.equal(updated.resources.find(row => row.key === 'chapter:10').value, 88);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(saveDirectory(root), 'archives', 'original-target.json'), 'utf8')).raw, original);
  const wrongScope = structuredClone(raw); wrongScope.scope.cardId = 'c'.repeat(64);
  const isolated = await getPlayerSaveEditor(root, summary(wrongScope, 'best-foreign'), wrongScope, playerId);
  assert.equal(isolated.resources.find(row => row.key === 'chapter:10'), undefined);
});

test('no-op edits return unchanged and never create files or network requests', async t => {
  const root = await temporary(t); await catalog(root); const raw = fixture();
  const prepared = await preparePlayerSaveEdit(root, summary(raw), raw, { resources: [{ key: 'data:point', value: 30 }], scores: [] }, playerId);
  assert.equal(prepared.unchanged, true); assert.equal(await fsp.stat(saveDirectory(root)).then(() => true, () => false), false);
});


test('extended score fields and platinum stars survive saving, parsing and a second resource-only edit', async t => {
  const root = await temporary(t); await catalog(root); const raw = fixture();
  const patch = { resources: [], scores: [score({ platinumScore: 990, playCount: 7, maxComboCount: 500, maxOverKill: 30000, maxTeamOverKill: 60000, battleScoreRank: 8, clearStatus: 1 })] };
  const prepared = await preparePlayerSaveEdit(root, summary(raw), raw, patch, playerId), saved = editRaw(prepared);
  const chart = saved.scores.find(row => row.musicId === patch.scores[0].musicId && row.difficulty === patch.scores[0].difficulty);
  assert.equal(chart.platinumScoreStar, 6);
  for (const field of ['playCount', 'maxComboCount', 'maxOverKill', 'maxTeamOverKill', 'battleScoreRank', 'clearStatus']) assert.equal(chart[field], patch.scores[0][field]);
  assert.equal(saved.edit.scores[0].maxComboCount, 500);
  const refreshed = await getPlayerSaveEditor(root, {...saved,scores:saved.scores.map(({maxComboCount,...rest})=>rest)}, prepared.raw, playerId);
  assert.equal(refreshed.scores.find(row=>row.musicId===chart.musicId&&row.difficulty===chart.difficulty).maxComboCount,500);
  const again = await preparePlayerSaveEdit(root, saved, prepared.raw, { resources: [{ key: 'data:point', value: 88 }], scores: [] }, playerId);
  assert.equal(editRaw(again).scores.find(row => row.musicId === chart.musicId && row.difficulty === chart.difficulty).platinumScoreStar, 6);
  const counts = await preparePlayerSaveEdit(root, saved, prepared.raw, { resources: [], scores: [score({ ...patch.scores[0], playCount: 8 })] }, playerId);
  assert.equal(counts.unchanged, false);
});
