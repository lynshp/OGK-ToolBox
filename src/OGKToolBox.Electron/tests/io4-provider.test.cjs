const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { once } = require('node:events');
const { createServer } = require('node:net');
const sdk = require(path.resolve(__dirname, '../../../sdk/controller-provider/server.cjs'));
const example = require(path.resolve(__dirname, '../../../examples/controller-provider/provider.cjs')).adapter;

function load() {
  const exports = {}, module = { exports };
  const source = fs.readFileSync(path.join(__dirname, '../electron/providers/io4-provider.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const testRequire = name => {
    if (name === '../../sdk/controller-provider/server.cjs') return sdk;
    if (name === '../simgeki-io4-controller') return { SimGekiIo4Controller: class {
      constructor() { throw new Error('Tests must inject a controller; never access real HID devices.'); }
    } };
    throw new Error(`Unexpected module: ${name}`);
  };
  testRequire.main = {};
  vm.runInNewContext(code, { exports, module, require: testRequire, process, console });
  return exports;
}
function controller() {
  const calls = [];
  let current = '1', stopped = 0;
  const result = () => ({ status: 'Verified', message: 'simulated' });
  return {
    calls, get stopped() { return stopped; },
    start: async () => { calls.push('start'); }, stop: async () => { stopped++; },
    getSnapshot: () => ({ ...example.snapshot(), identity: { ...example.snapshot().identity, kind: 'SimGEKI' },
      inputModes: { current, options: [{ id: '1', label: 'IO4' }, { id: '2', label: 'DLL' }, { id: '3', label: 'Keyboard' }] } }),
    rescan: async () => { calls.push('rescan'); return result(); },
    retrySync: async () => { calls.push('retry-sync'); return result(); },
    setInputMode: async mode => { current = String(mode); calls.push(['input-mode', mode]); return result(); },
    setMode: async mode => { calls.push(['mode', mode]); return result(); },
    leverCalibration: async action => { calls.push(['lever-calibration', action]); return result(); },
    releaseAllIfRunning: async () => { calls.push('release-all'); }
  };
}

test('adapter validates modes, routes supported commands and rejects unknown hardware commands', async () => {
  const reader = controller(), adapter = load().createIo4Adapter(reader);
  assert.equal((await adapter.command('input-mode', { modeId: 2 })).status, 'Rejected');
  assert.equal((await adapter.command('input-mode', { modeId: '2' })).status, 'Verified');
  assert.equal(adapter.snapshot().inputModes.current, '2');
  assert.equal((await adapter.command('mode', { keyboardMouse: 'true' })).status, 'Rejected');
  await adapter.command('mode', { keyboardMouse: true });
  assert.equal((await adapter.command('lever-calibration', { action: 'left' })).status, 'Rejected');
  assert.equal((await adapter.command('lever-calibration', { action: 'center' })).status, 'Verified');
  await adapter.command('rescan', {});
  await adapter.command('retry-sync', {});
  assert.equal((await adapter.command('brightness', { brightness: 255 })).status, 'Rejected');
  await adapter.releaseAll(); await adapter.close();
  assert.equal(reader.stopped, 1);
  assert.deepEqual(reader.calls, [['input-mode', 2], ['mode', true], ['lever-calibration', 'center'],
    'rescan', 'retry-sync', 'release-all']);
});

test('provider entry starts the adapter and serves SDK mode commands without real hardware', { timeout: 5000 }, async t => {
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const reader = controller();
  const provider = await load().startIo4Provider(['--port', String(port), '--session-token', 't'.repeat(32),
    '--instance-id', 'io4-test', '--parent-pid', String(process.pid), '--software-version', '1.1.7'], reader);
  t.after(() => provider.stop());
  const headers = { 'X-OGK-Controller-Session': 't'.repeat(32) };
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/commands/input-mode`, {
    method: 'POST', headers, body: JSON.stringify({ modeId: '3' })
  });
  const result = await response.json();
  assert.equal(result.status, 'Verified');
  assert.equal(result.snapshot.inputModes.current, '3');
  assert.equal(reader.calls[0], 'start');
  await provider.stop();
  assert.equal(reader.stopped, 1);
});

test('provider entry closes its reader when serving or hardware startup fails', async () => {
  const reader = controller();
  await assert.rejects(load().startIo4Provider([], reader, async () => { throw new Error('HTTP unavailable'); }), /HTTP unavailable/);
  assert.equal(reader.stopped, 1);
  const failed = controller();
  failed.start = async () => { throw new Error('HID unavailable'); };
  await assert.rejects(load().startIo4Provider([], failed), /HID unavailable/);
  assert.equal(failed.stopped, 1);
});

test('a successfully started reader without any attached device is still a ready provider', async () => {
  const reader = controller();
  reader.getSnapshot = () => ({ ...example.snapshot(), state: 'Searching', identity: { ...example.snapshot().identity, kind: 'Unknown' } });
  let observed;
  await load().startIo4Provider([], reader, async adapter => { observed = adapter.snapshot(); return { stop: adapter.close }; });
  assert.equal(observed.identity.kind, 'Unknown');
  assert.equal(observed.state, 'Searching');
  await reader.stop();
});
