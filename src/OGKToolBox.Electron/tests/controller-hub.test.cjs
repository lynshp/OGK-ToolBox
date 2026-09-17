const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const snapshot = kind => ({ identity: { kind }, state: 'Ready' });

class Backend {
  constructor(kind) {
    this.value = snapshot(kind);
    this.status = { state: 'ready' };
    this.snapshotListeners = new Set();
    this.statusListeners = new Set();
  }
  getSnapshot() { return this.value; }
  getStatus() { return this.status; }
  onSnapshot(listener) { this.snapshotListeners.add(listener); listener(this.value); return () => {}; }
  onStatus(listener) { this.statusListeners.add(listener); listener(this.status); return () => {}; }
  publish(kind) { this.value = snapshot(kind); for (const listener of this.snapshotListeners) listener(this.value); }
  async start() {}
  async restart() {}
  async stop() {}
  async releaseAllIfRunning() {}
  async rescan() { return { commandId: this.value.identity.kind, status: 'Verified', message: '', snapshot: this.value }; }
  async retrySync() { return this.rescan(); }
  async releaseAll() { return this.rescan(); }
}

test('controller hub gives a detected direct IO4 device priority', async () => {
  const moduleInstances = [], io4Instances = [];
  class ModuleBackend extends Backend { constructor() { super('Leonardo'); moduleInstances.push(this); } }
  class Io4Backend extends Backend { constructor() { super('Unknown'); io4Instances.push(this); } }
  const source = fs.readFileSync(path.join(__dirname, '../electron/controller-hub.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true
  } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => name === './controller-module-manager'
    ? { ControllerModuleManager: ModuleBackend } : name === './simgeki-io4-controller'
      ? { SimGekiIo4Controller: Io4Backend } : require(name), console, Promise });
  const hub = new exports.ControllerHub();
  assert.equal(hub.getSnapshot().identity.kind, 'Leonardo');
  io4Instances[0].publish('SimGEKI');
  assert.equal(hub.getSnapshot().identity.kind, 'SimGEKI');
  assert.equal((await hub.rescan()).commandId, 'SimGEKI');
  assert.equal(moduleInstances.length, 1);
});
