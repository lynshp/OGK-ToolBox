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

const { queuePlayerGameEdit, pendingPlayerEdit, cancelPlayerGameEdit, playerEditModEnabled } = load('../electron/player-game-edits.ts');
const owner = { server: 'play.mumur.net', accessCode: '12345678901234567890', keychip: 'A123-45678901234' };
const state = {scoreConstraints:[{musicId:101,difficulty:3,platinumMax:2000}]};
const resource = {resources:[{key:'data:point',value:1000}],scores:[]};
async function temporary(t) {
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'ogk-edit-queue-'));
 t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^ogk-edit-queue-/);return fsp.rm(root,{recursive:true,force:true});});
 await fsp.mkdir(path.join(root,"BepInEx/plugins"),{recursive:true});await fsp.writeFile(path.join(root,"BepInEx/plugins/OGKToolBox.PlayerCapture.dll"),"fixture");
 await fsp.mkdir(path.join(root,"Tools/OGKToolBox/player-data"),{recursive:true});await fsp.writeFile(path.join(root,"Tools/OGKToolBox/player-data/capture.enabled"),"");return root;
}
test('queue publishes only a command, redacts ownership on reads, normalizes keychip, rejects duplicate tasks', async t=>{
 const root=await temporary(t), job=await queuePlayerGameEdit(root,owner,resource,state);
 assert.equal(job.status,'pending');assert.equal((await pendingPlayerEdit(root,owner)).id,job.id);
 const dir=path.join(root,'Tools/OGKToolBox/player-data'), names=await fsp.readdir(path.join(dir,'edits'));
 assert.equal(names.length,1);const stored=JSON.parse(await fsp.readFile(path.join(dir,'edits',names[0])));
 assert.equal(stored.clientId,'A1234567890');assert.equal('accessCode' in job,false);
 await assert.rejects(fsp.stat(path.join(dir,'archives')), {code:'ENOENT'});
 await assert.rejects(queuePlayerGameEdit(root,owner,resource,state),/已有待应用/);
 assert.equal(await pendingPlayerEdit(root,{...owner,accessCode:'22345678901234567890'}),undefined);
 assert.equal(await pendingPlayerEdit(root,{...owner,server:'play.mumur.net:1234'}),undefined);
 await cancelPlayerGameEdit(root,owner,job.id);
 assert.equal(await pendingPlayerEdit(root,owner),undefined);
});
test('claimed commands cannot be cancelled as pending or replayed; explicit stopped-game discard releases slot', async t=>{
 const root=await temporary(t), job=await queuePlayerGameEdit(root,owner,resource,state), dir=path.join(root,'Tools/OGKToolBox/player-data/edits');
 const name=(await fsp.readdir(dir))[0];await fsp.rename(path.join(dir,name),path.join(dir,name.replace('.pending.','.active.')));
 assert.equal((await pendingPlayerEdit(root,owner)).status,'active');
 await assert.rejects(cancelPlayerGameEdit(root,owner,job.id),/不能撤回/);
 await assert.rejects(queuePlayerGameEdit(root,owner,resource,state),/游戏领取/);
 await cancelPlayerGameEdit(root,owner,job.id,true);
 const next=await queuePlayerGameEdit(root,owner,resource,state);assert.notEqual(next.id,job.id);
});
test('atomic publish permits only one pending command even for concurrent callers',async t=>{
 const root=await temporary(t), results=await Promise.allSettled([queuePlayerGameEdit(root,owner,resource,state),queuePlayerGameEdit(root,owner,resource,state)]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
 assert.equal((await fsp.readdir(path.join(root,'Tools/OGKToolBox/player-data/edits'))).filter(name=>name.endsWith('.tmp')).length,0);
});
test('only MuNET accepts scores; field mask and platinum maximum are included for native validation', async t=>{
 const root=await temporary(t), score={musicId:101,difficulty:3,techScore:990000,platinumScore:1900,battleScore:100,fullCombo:false,fullBell:false,allBreak:false,fields:['techScore']},patch={resources:[],scores:[score]};
 for(const server of ['ea.naominet.live','nageki-net.com','unknown.invalid']) await assert.rejects(queuePlayerGameEdit(root,{...owner,server},patch,state),/只能保存存档/);
 const job=await queuePlayerGameEdit(root,owner,patch,state),dir=path.join(root,'Tools/OGKToolBox/player-data/edits');
 const stored=JSON.parse(await fsp.readFile(path.join(dir,(await fsp.readdir(dir))[0])));assert.equal(stored.scores[0].platinumMax,2000);assert.deepEqual(stored.scores[0].fields,['techScore']);
 assert.equal(job.scores[0].techScore,990000);
});

test('disabled or missing Mod blocks publishing even with stale editor state, and enabling permits offline queueing', async t=>{
 const root=await temporary(t), marker=path.join(root,'Tools/OGKToolBox/player-data/capture.enabled'), dll=path.join(root,'BepInEx/plugins/OGKToolBox.PlayerCapture.dll');
 for (const file of [marker,dll]) {
  const original=await fsp.readFile(file);await fsp.unlink(file);
  assert.equal(await playerEditModEnabled(root),false);
  await assert.rejects(queuePlayerGameEdit(root,owner,resource,{...state,gameEditEnabled:true}),/启用 Mod/);
  await assert.rejects(fsp.stat(path.join(root,'Tools/OGKToolBox/player-data/edits')),{code:'ENOENT'});
  await fsp.writeFile(file,original);
 }
 assert.equal(await playerEditModEnabled(root),true);
 assert.equal((await queuePlayerGameEdit(root,owner,resource,state)).status,'pending');
});
