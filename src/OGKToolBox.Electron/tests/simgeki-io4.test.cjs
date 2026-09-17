const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { EventEmitter } = require('node:events');

function load(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../electron/simgeki-io4-controller.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true
  } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => overrides[name] ?? require(name), Buffer,
    setTimeout, clearTimeout, setInterval, clearInterval, console, structuredClone, queueMicrotask });
  return exports;
}

test('recognizes only known IO4 gamepad collections', () => {
  const { isIo4InputDevice } = load();
  const base = { vendorId: 0x0ca3, productId: 0x0021, path: 'io4', release: 1, interface: 0 };
  assert.equal(isIo4InputDevice({ ...base, usagePage: 0x01, usage: 0x04 }), true);
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

test('reads SimGEKI input and verifies all three configuration modes', async t => {
  const inputDescriptor = { vendorId: 0x8088, productId: 0x0101, path: 'input', serialNumber: 'simgeki',
    product: 'SimGEKI', release: 2, interface: 0, usagePage: 0x01, usage: 0x04 };
  const configDescriptor = { ...inputDescriptor, path: 'config', interface: 1, usagePage: 0xff00, usage: 1 };
  let mode = 1;
  const inputDevice = new EventEmitter();
  inputDevice.close = async () => {};
  const configDevice = new EventEmitter();
  configDevice.close = async () => {};
  configDevice.write = async report => {
    const command = report[2];
    if (command === 0x02) mode = report[4];
    const response = Buffer.alloc(64);
    response[0] = 0xaa;
    response[3] = 0x01;
    if (command === 0x01) response[4] = mode;
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
  assert.equal(controller.getSnapshot().deviceConfig.inputMode, 2);
  assert.equal(controller.getSnapshot().deviceConfig.isKmMode, false);
  assert.equal((await controller.setInputMode(4)).status, 'Rejected');
});
