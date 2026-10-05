const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { EventEmitter } = require('node:events');

function bridge() {
  const ipcRenderer = new EventEmitter(), invocations = [];
  ipcRenderer.invoke = async (...args) => { invocations.push(args); return { saved: true }; };
  ipcRenderer.send = () => {};
  let api;
  const file = path.resolve(__dirname, '../electron/preload.ts'), loaded = new Module(file, module);
  loaded.filename = file;
  loaded.require = name => name === 'electron'
    ? { ipcRenderer, contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'ogk'); api = value; } } }
    : require(name);
  loaded._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, file);
  return { api, ipcRenderer, invocations };
}

test('game edits, status and cancellation keep the selected save and player through IPC', async () => {
  const {api,invocations}=bridge(),patch={resources:[{key:'data:point',value:100}],scores:[]};
  await api.queuePlayerSaveEdit('fixture-root','save-a','player-a',patch);
  await api.playerSaveEditStatus('fixture-root','save-a','player-a');
  await api.cancelPlayerSaveEdit('fixture-root','save-a','player-a','job-a',true);
  assert.deepEqual(invocations,[
    ['player-saves:queue-edit','fixture-root','save-a','player-a',patch],
    ['player-saves:edit-status','fixture-root','save-a','player-a'],
    ['player-saves:cancel-edit','fixture-root','save-a','player-a','job-a',true]
  ]);
});
test('archive editing remains a separate command from game edits', async () => {
  const {api,invocations}=bridge(),patch={resources:[],scores:[]};
  await api.savePlayerSaveEditor('fixture-root','save-a','player-a',patch);
  assert.deepEqual(invocations,[['player-saves:edit','fixture-root','save-a','player-a',patch]]);
});
test('retired edit writer and progress subscription are absent while best-score upload remains available', () => {
  const {api}=bridge();
  assert.equal('uploadEditedPlayerSave' in api,false);
  assert.equal('onPlayerSaveUploadProgress' in api,false);
  assert.equal(typeof api.uploadPlayerBest,'function');
});
