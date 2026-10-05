const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');
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
const profiles = load(path.join(__dirname, '../electron/player-profiles.ts'));
const stations = load(path.join(__dirname, '../electron/machine-profiles.ts'));
const { saveDirectory, listSaves, readSave } = load(path.join(__dirname, '../electron/player-save.ts'));
const score = { musicId: 101, level: 0, techScoreMax: 1008000, platinumScoreMax: 1900, battleScoreMax: 3000, playCount: 4, isAllBreake: false, isFullCombo: true, isFullBell: true };
const raw = () => ({ userData: { userName: 'Anonymous editor', point: 100, jewelCount: 5, medalCount: 8, shizukuCount: 2, newPlayerRating: 12345, untouched: 'keep' }, userMusicDetailList: [{ ...score }], userPlaylogList: [{ musicId: 101, level: 0, techScore: 1009000, userPlayDate: '2026-10-03 11:00:00.0' }], userItemList: [] });
const editedScore = { musicId: 101, difficulty: 0, techScore: 900000, platinumScore: 1000, battleScore: 2000, allBreak: false, fullCombo: false, fullBell: false };
async function setup(t, configured = true) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ogk-editor-owner-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^ogk-editor-owner-/); await fsp.rm(root, { recursive: true, force: true }); });
  if (configured) {
    await fsp.mkdir(path.join(root, 'DEVICE'));
    await fsp.writeFile(path.join(root, 'DEVICE/aime.txt'), '12345678901234567890');
    await fsp.writeFile(path.join(root, 'segatools.ini'), '[aime]\naimePath=DEVICE/aime.txt\n[dns]\ndefault=editor.invalid\n[keychip]\nid=A123-45678901234\n');
  }
  const music = path.join(root, 'mu3_Data/StreamingAssets/GameData/A000/music/music0101');
  await fsp.mkdir(music, { recursive: true });
  await fsp.writeFile(path.join(music, 'Music.xml'), '<MusicData><Name><id>101</id><str>Anonymous chart</str></Name><FumenData><FumenFile><path>fixture.ogkr</path></FumenFile></FumenData></MusicData>');
  await fsp.writeFile(path.join(music, 'fixture.ogkr'), '[HEADER]\nT_TOTAL\t1000\n[BODY]\n');
  const state = await profiles.playerProfiles(root);
  const imported = await profiles.importManagedPlayerSave(root, raw(), state.server?.id ?? null, state.selectedPlayerId);
  const current = await profiles.playerProfiles(root), playerId = imported.localPlayerId;
  if (current.selectedPlayerId !== playerId) await stations.selectPlayerProfile(root, current.cards, playerId);
  return { root, playerId, source: imported, raw: raw() };
}

test('managed editor keeps source immutable, binds new snapshots and accumulates successive resource and lowered score edits', async t => {
  const { root, playerId, source } = await setup(t), archive = path.join(saveDirectory(root), 'archives', source.id + '.json');
  const before = await fsp.readFile(archive), ini = await fsp.readFile(path.join(root, 'segatools.ini')), card = await fsp.readFile(path.join(root, 'DEVICE/aime.txt'));
  const editor = await profiles.getManagedPlayerSaveEditor(root, source.id, playerId);
  assert.equal(editor.resources.find(row => row.key === 'data:point').max, 999999999);
  assert.equal(editor.scoreConstraints.find(row => row.musicId === 101).platinumMax, 2000);
  const first = await profiles.saveManagedPlayerSaveEditor(root, source.id, playerId, { resources: [{ key: 'data:point', value: 150 }], scores: [] });
  assert.notEqual(first.id, source.id); assert.equal(first.localPlayerId, playerId); assert.deepEqual(first.scope, source.scope);
  const second = await profiles.saveManagedPlayerSaveEditor(root, first.id, playerId, { resources: [], scores: [{ ...editedScore }] });
  assert.notEqual(second.id, first.id); assert.equal(second.newPlayerRating, undefined);
  assert.deepEqual(second.edit.resources, [{ key: 'data:point', value: 150 }]); assert.equal(second.edit.scores[0].techScore, 900000);
  assert.equal(second.scores[0].techScore, 900000); assert.equal(second.scores[0].playCount, 4);
  const stored = await readSave(path.join(saveDirectory(root), 'archives', second.id + '.json'));
  assert.equal(stored.raw.userData.point, 150); assert.equal(stored.raw.userData.untouched, 'keep');
  assert.equal(stored.raw.userPlaylogList[0].techScore, 1009000);
  assert.deepEqual(await fsp.readFile(archive), before); assert.deepEqual(await fsp.readFile(path.join(root, 'segatools.ini')), ini); assert.deepEqual(await fsp.readFile(path.join(root, 'DEVICE/aime.txt')), card);
  assert.equal((await profiles.scopedPlayerSaves(root)).filter(row => row.localPlayerId === playerId).length, 3);
});

test('managed editor rejects stale player, nonexistent chart and over-limit values without creating archives; no-op returns the source', async t => {
  const { root, playerId, source } = await setup(t), count = (await listSaves(root)).length;
  await assert.rejects(profiles.getManagedPlayerSaveEditor(root, source.id, 'missing-player'), /玩家/);
  await assert.rejects(profiles.saveManagedPlayerSaveEditor(root, source.id, playerId, { resources: [{ key: 'data:jewelCount', value: 100000 }], scores: [] }), /上限/);
  await assert.rejects(profiles.saveManagedPlayerSaveEditor(root, source.id, playerId, { resources: [], scores: [{ ...editedScore, musicId: 999 }] }), /谱面/);
  const same = await profiles.saveManagedPlayerSaveEditor(root, source.id, playerId, { resources: [{ key: 'data:point', value: 100 }], scores: [] });
  assert.equal(same.id, source.id); assert.equal((await listSaves(root)).length, count);
  const state = await profiles.playerProfiles(root), added = await stations.savePlayerProfile(root, state.cards, { name: 'Other fixture', machineId: state.machines[0].id, cardId: state.cards[0].id });
  await stations.selectPlayerProfile(root, state.cards, added);
  await assert.rejects(profiles.saveManagedPlayerSaveEditor(root, source.id, playerId, { resources: [{ key: 'data:point', value: 150 }], scores: [] }), /当前玩家已变化/);
  assert.equal((await listSaves(root)).length, count);
});

test('imported player without card or server can save edits locally without creating or activating game configuration', async t => {
  const { root, playerId, source } = await setup(t, false);
  assert.equal(source.scope, undefined);
  const saved = await profiles.saveManagedPlayerSaveEditor(root, source.id, playerId, { resources: [{ key: 'data:medalCount', value: 20 }], scores: [] });
  assert.equal(saved.scope, undefined); assert.equal(saved.localPlayerId, playerId); assert.equal(saved.edit.resources[0].value, 20);
  assert.equal(await fsp.stat(path.join(root, 'segatools.ini')).then(() => true, () => false), false);
  assert.equal(await fsp.stat(path.join(root, 'DEVICE/aime.txt')).then(() => true, () => false), false);
});

test('configuration changed during editor preparation stops the local save instead of rebinding it to a different machine', async t => {
  const { root, playerId, source } = await setup(t), state = await profiles.playerProfiles(root), count = (await listSaves(root)).length;
  const machine = await stations.saveMachineProfile(root, state.cards, { name: 'Other editor machine', values: { ...state.machines[0].values, dns: { ...state.machines[0].values.dns, default: 'other-editor.invalid' } } }, async () => { throw Error('must not activate'); });
  const editor = load(path.join(__dirname, '../electron/player-save-editor.ts')), original = editor.preparePlayerSaveEdit;
  editor.preparePlayerSaveEdit = async (...args) => {
    const result = await original(...args), file = path.join(saveDirectory(root), 'stations.json'), data = JSON.parse(await fsp.readFile(file, 'utf8'));
    data.players.find(row => row.id === playerId).machineId = machine.id;
    await fsp.writeFile(file, JSON.stringify(data)); return result;
  };
  try { await assert.rejects(profiles.saveManagedPlayerSaveEditor(root, source.id, playerId, { resources: [{ key: 'data:point', value: 150 }], scores: [] }), /机台或卡号配置已变化/); }
  finally { editor.preparePlayerSaveEdit = original; }
  assert.equal((await listSaves(root)).length, count);
});


test('managed game edits preserve the original archive and do not create a modified archive', async t => {
 const {root,playerId,source}=await setup(t), before=await listSaves(root), file=path.join(saveDirectory(root),'archives',source.id+'.json'), bytes=await fsp.readFile(file);
 assert.equal((await profiles.getManagedPlayerSaveEditor(root,source.id,playerId)).gameEditEnabled,false);
 await assert.rejects(profiles.queueManagedPlayerEdit(root,source.id,playerId,{resources:[{key:'data:point',value:900}],scores:[]}),/启用 Mod/);
 await fsp.mkdir(path.join(root,'BepInEx/plugins'),{recursive:true});await fsp.writeFile(path.join(root,'BepInEx/plugins/OGKToolBox.PlayerCapture.dll'),'fixture');
 await fsp.writeFile(path.join(saveDirectory(root),'capture.enabled'),'');
 assert.equal((await profiles.getManagedPlayerSaveEditor(root,source.id,playerId)).gameEditEnabled,true);
 const job=await profiles.queueManagedPlayerEdit(root,source.id,playerId,{resources:[{key:'data:point',value:900}],scores:[]});
 assert.equal(job.status,'pending');assert.deepEqual(await fsp.readFile(file),bytes);assert.equal((await listSaves(root)).length,before.length);
 const state=await profiles.getManagedPlayerSaveEditor(root,source.id,playerId);assert.equal(state.resources.find(row=>row.key==='data:point').value,100);assert.equal(state.pendingEdit.resources[0].value,900);
 await assert.rejects(profiles.queueManagedPlayerEdit(root,source.id,'other-player',{resources:[{key:'data:point',value:901}],scores:[]}));
 await profiles.cancelManagedPlayerEdit(root,source.id,playerId,job.id,false);assert.equal(await profiles.managedPlayerEditStatus(root,source.id,playerId),undefined);
});
