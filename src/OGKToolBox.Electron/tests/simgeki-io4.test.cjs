const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { EventEmitter } = require('node:events');

function load(overrides = {}, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../electron/simgeki-io4-controller.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true
  } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => overrides[name] ?? require(name), Buffer,
    setTimeout, clearTimeout, setInterval, clearInterval, console, structuredClone, queueMicrotask, ...globals });
  return exports;
}

test('recognizes only known IO4 gamepad collections', () => {
  const { isIo4InputDevice } = load();
  const base = { vendorId: 0x0ca3, productId: 0x0021, path: 'io4', release: 1, interface: 0 };
  assert.equal(isIo4InputDevice({ ...base, usagePage: 0x01, usage: 0x04 }), true);
  assert.equal(isIo4InputDevice({ ...base, vendorId: 0x8088, productId: 0x0101,
    usagePage: 0x01, usage: 0x04 }), true);
  assert.equal(isIo4InputDevice({ ...base, usagePage: 0xff00, usage: 0x01 }), false);
  assert.equal(isIo4InputDevice({ ...base, vendorId: 0x1234, usagePage: 0x01, usage: 0x04 }), false);
});

test('decodes IO4 roller and active-low side buttons', () => {
  const { parseIo4InputReport } = load();
  const report = Buffer.alloc(64);
  report[0] = 0x01;
  report[1] = 0x34;
  report[2] = 0x12;
  report[29] = 0x01;
  report[30] = 0x40;
  report[31] = 0x01;
  report[32] = 0x00;
  const input = parseIo4InputReport(report);
  assert.equal(input.rawLever, 0x1234);
  assert.equal(input.mappedLever, Math.round(((0xffff - 0x1234) * 1023) / 0xffff));
  assert.equal(input.leftA, true);
  assert.equal(input.rightB, true);
  assert.equal(input.rightSide, false);
  assert.equal(input.leftSide, true);
  assert.equal(parseIo4InputReport(Buffer.alloc(12)), null);
  const wrongReport = Buffer.alloc(64);
  wrongReport[0] = 0x02;
  assert.equal(parseIo4InputReport(wrongReport), null);
});

test('never exposes an IO4 endpoint descriptor while resolving the USB product name', async t => {
  const inputDescriptor = { vendorId: 0x0ca3, productId: 0x0021, path: 'input', serialNumber: 'io4',
    product: 'I/O CONTROL BD;endpoint details', release: 1, interface: 4, usagePage: 0x01, usage: 0x04 };
  const inputDevice = new EventEmitter();
  inputDevice.close = async () => {};
  const hid = { devicesAsync: async () => [inputDescriptor], HIDAsync: { open: async () => inputDevice } };
  let finishName;
  const name = new Promise(resolve => { finishName = resolve; });
  const { SimGekiIo4Controller } = load();
  const controller = new SimGekiIo4Controller(async () => hid, async () => name);
  t.after(() => controller.stop());
  const names = [];
  controller.onSnapshot(snapshot => names.push(snapshot.identity.displayName));
  const starting = controller.start();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(names.at(-1), 'IO4 兼容控制器');
  assert.equal(names.some(value => value.startsWith('I/O CONTROL')), false);
  finishName('SimGEKI街机风格控制器');
  await starting;
  assert.equal(controller.getSnapshot().identity.displayName, 'SimGEKI街机风格控制器');
});

test('identifies an IO4-compatible device as SimGEKI after configuration readback', async t => {
  const inputDescriptor = { vendorId: 0x0ca3, productId: 0x0021, path: 'input', serialNumber: 'simgeki',
    product: 'SimGEKI', release: 2, interface: 0, usagePage: 0x01, usage: 0x04 };
  const configDescriptor = { ...inputDescriptor, path: 'config', interface: 1, usagePage: 0xff00, usage: 1 };
  let mode = 1;
  const inputDevice = new EventEmitter();
  inputDevice.close = async () => {};
  const configDevice = new EventEmitter();
  configDevice.close = async () => {};
  const commands = [];
  configDevice.write = async report => {
    const command = report[2];
    commands.push(command);
    if (command === 0x02) mode = report[4];
    const response = Buffer.alloc(64);
    response[0] = 0xaa;
    response[2] = command;
    response[3] = 0x01;
    if (command === 0x01) response[4] = mode;
    if (command === 0x01 && commands.length > 1) {
      const staleSaveResponse = Buffer.from(response);
      staleSaveResponse[2] = 0x81;
      staleSaveResponse[4] = 0;
      queueMicrotask(() => configDevice.emit('data', staleSaveResponse));
    }
    queueMicrotask(() => configDevice.emit('data', response));
    return report.length;
  };
  const hid = {
    devicesAsync: async () => [inputDescriptor, configDescriptor],
    HIDAsync: { open: async devicePath => devicePath === 'input' ? inputDevice : configDevice }
  };
  const { SimGekiIo4Controller } = load();
  const controller = new SimGekiIo4Controller(async () => hid, async () => 'SimGEKI街机风格控制器');
  t.after(() => controller.stop());
  await controller.start();
  assert.equal(controller.getSnapshot().identity.kind, 'SimGEKI');
  assert.equal(controller.getSnapshot().identity.displayName, 'SimGEKI街机风格控制器');
  assert.equal(controller.getSnapshot().capabilities.mode, true);
  assert.equal(controller.getSnapshot().capabilities.leverCalibration, true);
  assert.equal(controller.getSnapshot().inputModes.current, '1');
  assert.equal(controller.getSnapshot().inputModes.options.map(mode => mode.id).join(','), '1,2,3');
  assert.equal(controller.getSnapshot().state, 'ConnectedWaitingForData');

  const report = Buffer.alloc(64);
  report[0] = 0x01;
  report[1] = 0x00;
  report[2] = 0x80;
  report[30] = 0x40;
  report[32] = 0x80;
  inputDevice.emit('data', report);
  assert.equal(controller.getSnapshot().state, 'Ready');
  assert.equal(controller.getSnapshot().readbackComplete, true);
  assert.equal(controller.getSnapshot().input.mappedLever, 511);

  const result = await controller.setInputMode(2);
  assert.equal(result.status, 'Verified');
  assert.deepEqual(commands, [0x01, 0x02, 0x81, 0x01]);
  assert.equal(controller.getSnapshot().deviceConfig.inputMode, 2);
  assert.equal(controller.getSnapshot().inputModes.current, '2');
  assert.equal(controller.getSnapshot().deviceConfig.isKmMode, false);
  assert.equal((await controller.setInputMode(4)).status, 'Rejected');
  assert.equal((await controller.leverCalibration('left')).status, 'Rejected');
  assert.equal((await controller.leverCalibration('center')).status, 'Verified');
  assert.deepEqual(commands, [0x01, 0x02, 0x81, 0x01, 0xa0, 0x81]);
});

const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function hidDevice() {
  const device = new EventEmitter();
  device.closed = 0;
  device.close = async () => { device.closed++; device.removeAllListeners(); };
  return device;
}
function fixture(configure = () => {}, resolveName = async () => undefined) {
  const input = { vendorId: 0x0ca3, productId: 0x0021, path: 'input', serialNumber: 'simgeki',
    release: 1, interface: 0, usagePage: 0x01, usage: 0x04 };
  const config = { ...input, path: 'config', usagePage: 0xff00, usage: 1, interface: 1 };
  const inputDevice = hidDevice(), configs = [];
  let mode = 1, inputOpens = 0;
  const hid = { devicesAsync: async () => [input, config], HIDAsync: { open: async devicePath => {
    if (devicePath === 'input') { inputOpens++; return inputDevice; }
    const device = hidDevice();
    const respond = report => {
      if (report[2] === 0x02) mode = report[4];
      const response = Buffer.alloc(64);
      response[0] = 0xaa; response[2] = report[2]; response[3] = 1; response[4] = mode;
      queueMicrotask(() => device.emit('data', response));
      return report.length;
    };
    device.write = async report => respond(report);
    configure(device, respond, configs.length);
    configs.push(device);
    return device;
  } } };
  const { SimGekiIo4Controller } = load();
  const controller = new SimGekiIo4Controller(async () => hid, resolveName);
  return { controller, input, config, hid, inputDevice, configs, get inputOpens() { return inputOpens; } };
}

for (const [label, resolveName, expectedName] of [
  ['SimGEKI', async () => 'SimGEKI街机风格控制器', 'SimGEKI街机风格控制器'],
  ['MYGEKI', async () => 'MYGEKI', 'MYGEKI'],
  ['missing name', async () => undefined, 'IO4 兼容控制器'],
  ['failed name lookup', async () => { throw new Error('USB description unavailable'); }, 'IO4 兼容控制器']
]) {
  for (const [vendorId, productId] of [[0x0ca3, 0x0021], [0x8088, 0x0101]]) {
    test(`${label} keeps its firmware name or IO4 fallback independently of mode support (${vendorId.toString(16)})`, async t => {
      const f = fixture(undefined, resolveName);
      Object.assign(f.input, { vendorId, productId });
      Object.assign(f.config, { vendorId, productId });
      t.after(() => f.controller.stop());
      await f.controller.start();
      assert.equal(f.controller.getSnapshot().identity.kind, 'SimGEKI');
      assert.equal(f.controller.getSnapshot().identity.displayName, expectedName);
      assert.equal((await f.controller.setInputMode(3)).status, 'Verified');
      assert.equal(f.controller.getSnapshot().identity.displayName, expectedName);
      assert.equal(f.controller.getSnapshot().inputModes.current, '3');
    });
  }
}

test('invalid configuration replies leave IO4 input working without exposing mode or calibration writes', async t => {
  const f = fixture(device => {
    device.write = async report => {
      const response = Buffer.from([0xaa, 0, report[2], 1, 9]);
      queueMicrotask(() => device.emit('data', response));
      return report.length;
    };
  });
  t.after(() => f.controller.stop());
  await f.controller.start();
  assert.equal(f.controller.getSnapshot().identity.kind, 'IO4Compatible');
  assert.equal(f.controller.getSnapshot().capabilities.mode, false);
  assert.equal(f.controller.getSnapshot().capabilities.leverCalibration, false);
  const report = Buffer.alloc(64); report[0] = 1; report[1] = 0x23; report[2] = 0x45;
  f.inputDevice.emit('data', report);
  assert.equal(f.controller.getSnapshot().input.rawLever, 0x4523);
  assert.equal(f.controller.getSnapshot().state, 'Ready');
  assert.equal((await f.controller.setInputMode(2)).status, 'Rejected');
  assert.equal((await f.controller.leverCalibration('center')).status, 'Rejected');
});

test('a configuration interface with another serial number is not used for the selected input device', async t => {
  const f = fixture();
  f.config.serialNumber = 'different-device';
  t.after(() => f.controller.stop());
  await f.controller.start();
  assert.equal(f.configs.length, 0);
  assert.equal(f.controller.getSnapshot().canWrite, false);
});

for (const stage of [0xa0, 0x81]) {
  test(`center calibration cannot report success after its configuration connection fails at ${stage.toString(16)}`, async t => {
    const f = fixture((device, respond) => {
      device.write = async report => {
        const length = respond(report);
        if (report[2] === stage) device.emit('error', new Error('configuration disconnected'));
        return length;
      };
    });
    t.after(() => f.controller.stop());
    await f.controller.start();
    assert.equal((await f.controller.leverCalibration('center')).status, 'Failed');
    assert.equal(f.controller.getSnapshot().canWrite, false);
  });
}

test('write rejection is handled, closes its channel and permits a fresh handshake', async t => {
  const f = fixture((device, respond, index) => {
    device.write = async report => {
      if (index === 0 && report[2] === 0x02) throw new Error('write failed');
      return respond(report);
    };
  });
  t.after(() => f.controller.stop());
  await f.controller.start();
  assert.equal((await f.controller.setInputMode(2)).status, 'Failed');
  await turn(); // node:test also fails this test on any unhandled rejection.
  assert.equal(f.configs[0].closed, 1);
  assert.equal(f.controller.getSnapshot().canWrite, false);
  assert.equal(f.controller.getSnapshot().inputModes, undefined);
  await f.controller.retrySync();
  assert.equal(f.inputOpens, 1);
  assert.equal(f.configs.length, 2);
  assert.equal((await f.controller.setInputMode(2)).status, 'Verified');
});

test('a write that never finishes is bounded by the response deadline', { timeout: 4000 }, async t => {
  const f = fixture((device, respond) => {
    device.write = report => report[2] === 0x02 ? new Promise(() => {}) : Promise.resolve(respond(report));
  });
  t.after(() => f.controller.stop());
  await f.controller.start();
  assert.equal((await f.controller.setInputMode(2)).status, 'Failed');
  await turn();
  assert.equal(f.configs[0].closed, 1);
  assert.equal(f.controller.getSnapshot().canWrite, false);
});

test('an initial configuration timeout can be retried without reopening physical input', { timeout: 4000 }, async t => {
  const f = fixture((device, _respond, index) => {
    if (index === 0) device.write = async report => report.length;
  });
  t.after(() => f.controller.stop());
  await f.controller.start();
  assert.equal(f.controller.getSnapshot().capabilities.mode, false);
  assert.equal(f.configs[0].closed, 1);
  await f.controller.rescan();
  assert.equal(f.inputOpens, 1);
  assert.equal(f.controller.getSnapshot().inputModes.current, '1');
  assert.equal(f.controller.getSnapshot().canWrite, true);
});

test('a SimGEKI in DLL mode is ready without an IO4 input frame', async t => {
  const f = fixture((device, respond) => {
    device.write = async report => {
      if (report[2] !== 0x01) return respond(report);
      const response = Buffer.alloc(64);
      response[0] = 0xaa; response[2] = 0x01; response[3] = 1; response[4] = 2;
      queueMicrotask(() => device.emit('data', response));
      return report.length;
    };
  });
  t.after(() => f.controller.stop());
  await f.controller.start();
  assert.equal(f.controller.getSnapshot().state, 'Ready');
  assert.equal(f.controller.getSnapshot().readbackComplete, true);
  assert.equal(f.controller.getSnapshot().capabilities.inputMonitor, false);
});

test('a configuration error closes the old handle and retry-sync restores the channel', async t => {
  const f = fixture();
  t.after(() => f.controller.stop());
  await f.controller.start();
  f.configs[0].emit('error', new Error('configuration channel lost'));
  await turn();
  assert.equal(f.configs[0].closed, 1);
  assert.equal(f.controller.getSnapshot().identity.kind, 'SimGEKI');
  assert.equal(f.controller.getSnapshot().capabilities.mode, false);
  await f.controller.retrySync();
  assert.equal(f.configs.length, 2);
  assert.equal(f.controller.getSnapshot().canWrite, true);
  await f.controller.stop();
  assert.equal(f.configs[0].closed, 1);
  assert.equal(f.configs[1].closed, 1);
});

test('stop during enumeration prevents device opening and timer resurrection', async () => {
  const pending = deferred();
  let opened = 0, intervals = 0;
  const { SimGekiIo4Controller } = load({}, {
    setInterval: () => { intervals++; return 1; }, clearInterval: () => { intervals--; }
  });
  const f = fixture();
  const controller = new SimGekiIo4Controller(async () => ({ devicesAsync: () => pending.promise,
    HIDAsync: { open: async () => { opened++; return hidDevice(); } } }), async () => undefined);
  const starting = controller.start();
  await turn();
  const stopping = controller.stop();
  pending.resolve([f.input]);
  await Promise.all([starting, stopping]);
  assert.equal(opened, 0);
  assert.equal(intervals, 0);
  assert.equal(controller.getStatus().state, 'stopped');
});

test('stop closes an input handle that finishes opening after cancellation', async () => {
  const pending = deferred(), inputDevice = hidDevice();
  const f = fixture();
  f.hid.HIDAsync.open = () => pending.promise;
  const starting = f.controller.start();
  await turn();
  const stopping = f.controller.stop();
  pending.resolve(inputDevice);
  await Promise.all([starting, stopping]);
  assert.equal(inputDevice.closed, 1);
  assert.equal(f.controller.getStatus().state, 'stopped');
  assert.equal(f.controller.getSnapshot().identity.kind, 'Unknown');
});

test('restart does not reuse a cancelled scan or accept late events from its handle', { timeout: 4000 }, async t => {
  const pending = deferred(), oldDevice = hidDevice(), currentDevice = hidDevice();
  const f = fixture();
  let opens = 0;
  f.hid.devicesAsync = async () => [{ ...f.input, vendorId: 0x0ca3, productId: 0x0021 }];
  f.hid.HIDAsync.open = () => ++opens === 1 ? pending.promise : Promise.resolve(currentDevice);
  t.after(() => f.controller.stop());
  const initial = f.controller.start();
  await turn();
  await f.controller.restart();
  assert.equal(opens, 2);
  const currentSequence = f.controller.getSnapshot().sequence;
  pending.resolve(oldDevice);
  await initial;
  assert.equal(oldDevice.closed, 1);
  assert.equal(currentDevice.closed, 0);
  assert.equal(f.controller.getSnapshot().sequence, currentSequence);
  const report = Buffer.alloc(64); report[0] = 1; report[1] = 0x12;
  currentDevice.emit('data', report);
  assert.equal(f.controller.getSnapshot().input.rawLever, 0x12);
  assert.equal(f.controller.getStatus().state, 'ready');
});

test('stop during mode readback cannot republish writable state', async () => {
  const waiting = deferred();
  const f = fixture((device, respond) => {
    device.write = async report => { await waiting.promise; return respond(report); };
  });
  const starting = f.controller.start();
  await turn();
  const stopping = f.controller.stop();
  waiting.resolve();
  await Promise.all([starting, stopping]);
  assert.equal(f.controller.getSnapshot().identity.kind, 'Unknown');
  assert.equal(f.controller.getSnapshot().canWrite, false);
  assert.equal(f.controller.getSnapshot().inputModes, undefined);
  assert.equal(f.configs[0].closed, 1);
});

test('an IO4-compatible device without a configuration collection stays read-only', async t => {
  const f = fixture();
  t.after(() => f.controller.stop());
  f.hid.devicesAsync = async () => [f.input];
  await f.controller.start();
  assert.equal(f.configs.length, 0);
  assert.equal(f.controller.getSnapshot().identity.kind, 'IO4Compatible');
  assert.equal(f.controller.getSnapshot().canWrite, false);
  assert.equal(f.controller.getSnapshot().inputModes, undefined);
  assert.equal((await f.controller.setInputMode(2)).status, 'Rejected');
});

for (const channel of ['input', 'config']) {
  for (const stage of [0x02, 0x81, 0x01]) {
    test(`mode transaction stops after ${stage.toString(16)} when the ${channel} connection is replaced`, async t => {
      const entered = deferred(), completeWrite = deferred(), replacementWrites = [];
      let initialRead = true;
      const f = fixture((device, respond, index) => {
        device.write = async report => {
          if (index > 0) {
            replacementWrites.push(report[2]);
            const response = Buffer.alloc(64);
            response[0] = 0xaa; response[2] = report[2]; response[3] = 1; response[4] = 1;
            queueMicrotask(() => device.emit('data', response));
            return report.length;
          }
          if (report[2] === 0x01 && initialRead) {
            initialRead = false;
            return respond(report);
          }
          const length = respond(report);
          if (report[2] === stage) {
            // A response may arrive before node-hid's queued write completion callback.
            entered.resolve();
            await completeWrite.promise;
          }
          return length;
        };
      });
      t.after(() => { completeWrite.resolve(); return f.controller.stop(); });
      await f.controller.start();
      const changingMode = f.controller.setInputMode(2);
      await entered.promise;
      await turn();
      if (channel === 'input') {
        const originalOpen = f.hid.HIDAsync.open;
        f.hid.HIDAsync.open = path => path === 'input' ? Promise.resolve(hidDevice()) : originalOpen(path);
        f.inputDevice.emit('error', new Error('input device replaced'));
      } else {
        f.configs[0].emit('error', new Error('configuration collection replaced'));
      }
      await turn();
      await f.controller.rescan();
      assert.equal(f.configs.length, 2);
      assert.equal(f.controller.getSnapshot().inputModes.current, '1');
      completeWrite.resolve();
      assert.equal((await changingMode).status, 'Failed');
      assert.deepEqual(replacementWrites, [0x01]); // Only the new connection's own initial handshake.
      assert.equal(f.controller.getSnapshot().inputModes.current, '1');
    });
  }
}

test('stopping before a queued HID write runs prevents that write entirely', async () => {
  let modeWrites = 0;
  const f = fixture((device, respond) => {
    device.write = async report => { if (report[2] === 0x02) modeWrites++; return respond(report); };
  });
  await f.controller.start();
  const changingMode = f.controller.setInputMode(2);
  const stopping = f.controller.stop();
  assert.equal((await changingMode).status, 'Failed');
  await stopping;
  assert.equal(modeWrites, 0);
});
