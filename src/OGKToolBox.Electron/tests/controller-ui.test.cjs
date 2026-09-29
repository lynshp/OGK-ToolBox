const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(bridge = {}, hooks = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src/controller-page.tsx'), 'utf8')
    + '\nexport { InputMonitor, ControllerAccordionsV2 };\n';
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX
  } }).outputText;
  const snapshotListeners = [], statusListeners = [], effects = [], stateChanges = [];
  const ogk = {
    controllerSnapshot: () => new Promise(() => {}), controllerStatus: () => new Promise(() => {}),
    onControllerSnapshot(listener) { snapshotListeners.push(listener); return () => {}; },
    onControllerStatus(listener) { statusListeners.push(listener); return () => {}; },
    ...bridge
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports, window: { ogk }, console,
    require(name) {
      if (name.endsWith('.css')) return {};
      if (name === './pencil-icons') return new Proxy({}, { get: () => () => null });
      if (name === 'react') return { ...React,
        useState(initial) { return [typeof initial === 'function' ? initial() : initial, value => stateChanges.push(value)]; },
        useRef: initial => ({ current: initial }), useCallback: callback => callback,
        useEffect: callback => effects.push(callback), useMemo: callback => callback(), ...hooks
      };
      return require(name);
    }
  });
  return { exports, snapshotListeners, statusListeners, effects, stateChanges };
}

const snapshot = (connectionId = 'first') => ({
  source: { backendId: 'example', connectionId },
  identity: { kind: 'CustomController', displayName: 'Custom Controller' },
  state: 'Ready', sequence: 1, canWrite: true, readbackComplete: true,
  capabilities: { mode: true, virtualKeys: false },
  inputModes: { current: 'usb', options: [{ id: 'usb', label: 'USB 输入' }, { id: 'keyboard', label: '键盘输入' }, { id: 'custom-mode', label: '自定义模式' }] },
  input: { leftA: true, mappedLever: 512 }, deviceConfig: { isKmMode: false },
  card: { present: false }, hall: {}, lever: {}
});

function elements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, predicate));
  if (!node || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...elements(node.props?.children, predicate)];
}
const buttons = tree => elements(tree, node => node.type === 'button');
const render = element => renderToStaticMarkup(element);
const result = value => ({ commandId: 'test', status: 'Verified', message: '', snapshot: value });

test('home status distinguishes detected but unready devices from missing devices without granting healthy status', () => {
  const { exports } = load();
  const ready = { ...snapshot(), identity: { kind: 'Pico', displayName: 'NYAGEKI Pro' },
    capabilities: { ...snapshot().capabilities, inputMonitor: true } };
  for (const [changes, text, note] of [
    [{ state: 'ConnectedWaitingForData' }, '等待输入数据', /等待首帧输入数据/],
    [{ state: 'SyncingDevice' }, '同步设备配置', /正在读取控制器配置/],
    [{ state: 'SyncingHall' }, '同步 Hall 配置', /正在读取控制器配置/],
    [{ state: 'SyncFailed' }, '同步失败', /配置同步失败/],
    [{ state: 'Faulted' }, '控制器故障', /控制器发生故障/],
    [{ state: 'Unsupported' }, '协议不支持', /当前协议不受支持/],
    [{ readbackComplete: false, canWrite: false }, '等待设备状态', /等待状态回读（只读）/],
    [{ canWrite: false, capabilities: { ...ready.capabilities, inputMonitor: false } }, '设备已连接', /已连接，未提供输入监视（只读）/]
  ]) {
    const view = exports.controllerStatusView({ ...ready, ...changes }, { state: 'ready' });
    assert.equal(view.detected, true, text);
    assert.equal(view.online, false, text);
    assert.equal(view.text, text);
    assert.match(view.note, note);
    assert.doesNotMatch(view.note, /未检测到/);
  }
  const missing = exports.controllerStatusView({ ...ready, state: 'Searching', identity: { kind: 'Unknown', displayName: '未连接' } }, { state: 'ready' });
  assert.equal(missing.detected, false);
  assert.equal(missing.online, false);
  assert.match(missing.note, /未检测到兼容的 HID 设备/);
  const readOnly = exports.controllerStatusView({ ...ready, canWrite: false }, { state: 'ready' });
  assert.equal(readOnly.online, true);
  assert.match(readOnly.note, /LUXIS · 输入监视已连接（只读）/);
  const failure = exports.controllerStatusView({ ...ready, state: 'SyncFailed', error: '设备配置校验失败' }, { state: 'ready' });
  assert.equal(failure.note, '设备配置校验失败');
});

test('home status retains module failures and stopped state instead of trusting a stale ready snapshot', () => {
  const { exports } = load();
  const value = { ...snapshot(), capabilities: { ...snapshot().capabilities, inputMonitor: true } };
  for (const [status, text, note] of [
    [{ state: 'fault', error: '连接进程异常' }, '模块故障', /连接进程异常/],
    [{ state: 'fault' }, '模块故障', /控制器服务发生故障/],
    [{ state: 'stopped' }, '服务已停止', /控制器服务已停止/],
    [{ state: 'restarting' }, '模块重启中', /正在检测/]
  ]) {
    const view = exports.controllerStatusView(value, status);
    assert.equal(view.detected, false);
    assert.equal(view.online, false);
    assert.equal(view.text, text);
    assert.match(view.note, note);
    assert.doesNotMatch(view.note, /未检测到兼容/);
  }
});

test('the home status card announces a detected sync failure instead of disconnected', () => {
  const harness = load();
  harness.exports.useController();
  harness.effects.forEach(effect => effect());
  harness.snapshotListeners[0]({ ...snapshot(), state: 'SyncFailed' });
  harness.statusListeners[0]({ state: 'ready' });
  const html = render(harness.exports.ControllerStatusCard());
  assert.match(html, /aria-label="同步失败"/);
  assert.match(html, /配置同步失败/);
  assert.doesNotMatch(html, /未检测到|aria-label="未连接"|status-result ok/);
});

test('mode UI follows declared string modes for third-party and original devices', async () => {
  const sent = [];
  const { exports } = load({ controllerSetInputMode: async id => { sent.push(id); return result(snapshot()); } });
  const command = task => task();
  const generic = exports.ControllerModeControl({ snapshot: snapshot(), command });
  assert.equal(buttons(generic).length, 3);
  assert.match(render(generic), /USB 输入/);
  await buttons(generic)[2].props.onClick();
  await Promise.resolve();
  assert.deepEqual(sent, ['custom-mode']);
  const original = { ...snapshot(), identity: { kind: 'Pico', displayName: 'LUXIS' },
    inputModes: { current: 'km', options: [{ id: 'mu3', label: 'MU3IO' }, { id: 'km', label: '模拟键鼠' }] } };
  const tree = exports.ControllerModeControl({ snapshot: original, command });
  assert.equal(buttons(tree).length, 2);
  assert.equal(buttons(tree)[1].props['aria-pressed'], true);
});

test('missing mode capability or write permission produces a read-only label', () => {
  const { exports } = load();
  for (const value of [{ ...snapshot(), canWrite: false },
    { ...snapshot(), capabilities: { ...snapshot().capabilities, mode: false } }]) {
    const tree = exports.ControllerModeControl({ snapshot: value, command: () => { throw new Error('must not send'); } });
    assert.equal(buttons(tree).length, 0);
    assert.match(render(tree), /USB 输入/);
  }
});

test('failed, rejected and missing mode results show an error without changing the selected mode', async () => {
  for (const status of ['Failed', 'Rejected', undefined]) {
    const states = [];
    let cursor = 0;
    const { exports } = load({}, { useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = value; }];
    } });
    const value = snapshot();
    const command = async () => status ? { ...result(value), status, message: '设备未确认输入模式' } : undefined;
    const draw = () => { cursor = 0; return exports.ControllerModeControl({ snapshot: value, command }); };
    buttons(draw())[1].props.onClick();
    assert.equal(buttons(draw())[1].props.disabled, true);
    await new Promise(setImmediate);
    const tree = draw();
    assert.equal(buttons(tree)[0].props['aria-pressed'], true);
    assert.equal(buttons(tree)[1].props['aria-pressed'], false);
    assert.equal(buttons(tree)[1].props.disabled, false);
    const alerts = elements(tree, element => element.props?.role === 'alert');
    assert.equal(alerts.length, 1);
    assert.match(render(alerts[0]), status ? /设备未确认输入模式/ : /输入模式切换未完成/);
  }
});

const deviceStatus = () => ({ state: 'ready', selectedBackendId: 'original', backends: [
  { id: 'original', label: 'LUXIS', connected: true, selected: true, state: 'ready' },
  { id: 'third-party', label: 'SimGEKI', connected: true, selected: false, state: 'ready' },
  { id: 'offline', label: '离线控制器', connected: false, selected: false, state: 'fault' }
] });

function deviceSelectorHarness(bridge, command = task => task()) {
  const states = [];
  let cursor = 0;
  const { exports } = load(bridge, {
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = { current: initial };
      return states[index];
    }
  });
  return status => { cursor = 0; return exports.ControllerDeviceSelector({ status, command }); };
}

test('offline devices show supported names and one connected device shows only its own name', () => {
  const { exports } = load();
  const draw = status => exports.ControllerDeviceSelector({ status, command: () => { throw new Error('must not send'); } });
  const status = deviceStatus();
  for (const offline of [{ state: 'ready' }, { state: 'ready', backends: [] },
    { ...status, backends: status.backends.filter(backend => !backend.connected) }]) {
    const tree = draw(offline);
    assert.equal(buttons(tree).length, 0);
    assert.match(render(tree), /已支持设备：/);
    assert.deepEqual(elements(tree, node => node.type === 'b').map(node => node.props.children), ['NYAGEKI', 'LUXIS', 'SimGEKI', 'IO4']);
    assert.doesNotMatch(render(tree), /离线控制器|is-connected/);
  }
  const single = draw({ ...status, backends: status.backends.filter(backend => backend.id !== 'third-party') });
  assert.equal(buttons(single).length, 0);
  assert.match(render(single), /LUXIS/);
  assert.doesNotMatch(render(single), /离线控制器|已支持设备：/);
});

test('Pico device tags display LUXIS without renaming similarly named third-party devices or routing ids', async () => {
  const sent = [];
  const draw = deviceSelectorHarness({ controllerSelectBackend: async id => { sent.push(id); return result(snapshot()); } });
  const original = { id: 'original', kind: 'Pico', label: 'NYAGEKI Pro', connected: true, selected: false, state: 'ready' };
  for (const label of ['NYAGEKI Pro', ' nyageki   pro ', 'NIA Controller Pro']) {
    const single = draw({ state: 'ready', backends: [{ ...original, label, selected: true }] });
    assert.equal(buttons(single).length, 0);
    assert.match(render(single), /title="LUXIS"/);
    assert.doesNotMatch(render(single), /NYAGEKI|nyageki|NIA/);
  }
  for (const kind of ['CustomController', 'pico', ' Pico ', undefined]) {
    const label = ' nyageki   pro ';
    const tree = draw({ state: 'ready', backends: [original,
      { id: 'custom', kind, label, connected: true, selected: true, state: 'ready' }] });
    assert.equal(buttons(tree)[0].props.title, 'LUXIS');
    assert.equal(buttons(tree)[1].props.title, label);
    assert.equal(buttons(tree)[0].props['aria-pressed'], false);
    assert.equal(buttons(tree)[1].props['aria-pressed'], true);
  }
  const tree = draw({ state: 'ready', backends: [original,
    { id: 'custom', kind: 'CustomController', label: 'NYAGEKI Pro', connected: true, selected: true, state: 'ready' }] });
  buttons(tree)[0].props.onClick();
  await new Promise(setImmediate);
  assert.deepEqual(sent, ['original']);
  assert.equal(original.label, 'NYAGEKI Pro');
  assert.equal(original.kind, 'Pico');
});

test('connected device labels select by backend id and preserve the confirmed selection', async () => {
  const sent = [], options = [];
  const draw = deviceSelectorHarness({ controllerSelectBackend: async id => { sent.push(id); return result(snapshot()); } },
    (task, option) => { options.push(option); return task(); });
  const status = deviceStatus();
  const tree = draw(status);
  assert.equal(buttons(tree).length, 2);
  assert.match(render(buttons(tree)[0]), /LUXIS/);
  assert.match(render(buttons(tree)[1]), /SimGEKI/);
  assert.doesNotMatch(render(tree), /离线控制器/);
  assert.equal(buttons(tree)[0].props['aria-pressed'], true);
  assert.equal(buttons(tree)[1].props['aria-pressed'], false);
  buttons(tree)[0].props.onClick();
  assert.deepEqual(sent, []);
  buttons(tree)[1].props.onClick();
  await new Promise(setImmediate);
  assert.deepEqual(sent, ['third-party']);
  assert.equal(options[0].allowConnectionChange, true);
  // Only confirmed status changes the selected label, never the click itself.
  assert.equal(buttons(draw(status))[0].props['aria-pressed'], true);
  const confirmed = { ...status, selectedBackendId: 'third-party',
    backends: status.backends.map(backend => ({ ...backend, selected: backend.id === 'third-party' })) };
  assert.equal(buttons(draw(confirmed))[1].props['aria-pressed'], true);
});

test('device switching blocks repeated clicks until the pending command completes', async () => {
  const sent = [];
  let finish;
  const draw = deviceSelectorHarness({ controllerSelectBackend: id => {
    sent.push(id);
    return new Promise(resolve => { finish = resolve; });
  } });
  const status = deviceStatus();
  const target = buttons(draw(status))[1];
  target.props.onClick();
  target.props.onClick();
  assert.deepEqual(sent, ['third-party']);
  assert.ok(buttons(draw(status)).every(button => button.props.disabled));
  finish(result(snapshot()));
  await new Promise(setImmediate);
  assert.ok(buttons(draw(status)).every(button => !button.props.disabled));
});

test('device switch failures show an error and keep the confirmed device selected', async () => {
  for (const outcome of ['Failed', 'Rejected', 'undefined', 'throw']) {
    const draw = deviceSelectorHarness({ controllerSelectBackend: async () => {
      if (outcome === 'throw') throw new Error('设备切换连接中断');
      if (outcome === 'undefined') return undefined;
      return { ...result(snapshot()), status: outcome, message: '设备切换未被确认' };
    } });
    const status = deviceStatus();
    buttons(draw(status))[1].props.onClick();
    await new Promise(setImmediate);
    const tree = draw(status);
    assert.equal(buttons(tree)[0].props['aria-pressed'], true);
    assert.equal(buttons(tree)[1].props['aria-pressed'], false);
    assert.ok(buttons(tree).every(button => !button.props.disabled));
    const alerts = elements(tree, element => element.props?.role === 'alert');
    assert.equal(alerts.length, 1, outcome);
    assert.ok(render(alerts[0]).replace(/<[^>]*>/g, '').trim().length > 0);
    if (outcome === 'Failed' || outcome === 'Rejected') assert.match(render(alerts[0]), /设备切换未被确认/);
    if (outcome === 'throw') assert.match(render(alerts[0]), /设备切换连接中断/);
  }
});

test('physical keys remain visible without virtual-input handlers', () => {
  const { exports } = load();
  const noop = () => {};
  const tree = exports.InputMonitor({ snapshot: snapshot(),
    virtualButtons: [['L_A', 'A', true, 'left-a', 'a']], keyboardHeldKeys: new Set(), keyboardBindings: {},
    onPress: noop, onRelease: noop, onPressKeyboard: noop, onReleaseKeyboard: noop, onReleaseAll: noop,
    inspectorTab: 'info', onInspectorTab: noop, command: noop });
  const key = buttons(tree).find(button => button.props.className.includes('controller-key'));
  assert.equal(key.props.disabled, true);
  assert.equal(key.props['aria-pressed'], true);
  assert.equal(key.props.onPointerDown, undefined);
  assert.equal(key.props.onKeyDown, undefined);
});

test('SimGEKI shows one center-calibration action without unrelated controls', async () => {
  const sent = [];
  const { exports } = load({ controllerLeverCalibration: async action => {
    sent.push(action);
    return result(value);
  } });
  const value = { ...snapshot(), identity: { kind: 'SimGEKI', displayName: 'SimGEKI街机风格控制器' },
    capabilities: { inputMonitor: true, virtualKeys: false, mode: true, basicLighting: false,
      picoLighting: false, hallConfiguration: false, hallCalibration: false,
      leverConfiguration: false, leverCalibration: true, cardReader: false, bootloader: false },
    deviceConfig: { valid: true, brightness: 0, groundColor: [0, 0, 0], sideColor: [0, 0, 0],
      cabPreset: 0, cabGameMapping: false, inputMode: 1, isKmMode: false },
    lever: { calibrationMin: 0, calibrationMax: 65535, inverted: true, sensitivity: 0, calibrationState: 0 } };
  const tree = exports.ControllerAccordionsV2({ snapshot: value, command: task => task() });
  assert.match(render(tree), /校准中心/);
  assert.doesNotMatch(render(tree), /灯光控制|反转|灵敏度/);
  buttons(tree)[0].props.onClick();
  await new Promise(setImmediate);
  assert.deepEqual(sent, ['center']);
});

test('protocol-compatible device tags retain the firmware name or the IO4 fallback', () => {
  const { exports } = load();
  for (const name of ['SimGEKI街机风格控制器', 'MYGEKI', 'IO4 兼容控制器']) {
    const tree = exports.ControllerDeviceSelector({ status: { state: 'ready', backends: [
      { id: 'io4', kind: 'SimGEKI', label: name, state: 'ready', connected: true, selected: true }
    ] }, command: task => task() });
    assert.ok(render(tree).includes(name));
    assert.equal(buttons(tree).length, 0);
  }
});

test('original Leonardo and Pico retain their lighting and lever controls', () => {
  const { exports } = load();
  for (const kind of ['Leonardo', 'Pico']) {
    const value = { ...snapshot(), identity: { kind, displayName: kind },
      capabilities: { basicLighting: true, picoLighting: kind === 'Pico', leverConfiguration: true,
        leverCalibration: true, hallConfiguration: kind === 'Pico' },
      deviceConfig: { valid: true, brightness: 100, groundColor: [0, 0, 0], sideColor: [0, 0, 0],
        cabPreset: 0, cabGameMapping: false, inputMode: 1, isKmMode: false },
      lever: { calibrationMin: 0, calibrationMax: 65535, inverted: true, sensitivity: 0, calibrationState: 0 } };
    const tree = exports.ControllerAccordionsV2({ snapshot: value, command: task => task() });
    assert.match(render(tree), /灯光控制/);
    assert.match(render(tree), /反转/);
    assert.match(render(tree), /灵敏度/);
    assert.doesNotMatch(render(tree), /校准中心/);
  }
});

test('late command responses cannot replace a newer connection of the same hardware kind', async () => {
  const harness = load();
  const controller = harness.exports.useController();
  harness.effects.forEach(effect => effect());
  harness.snapshotListeners[0](snapshot('old-connection'));
  let finish;
  const pending = controller.invoke(() => new Promise(resolve => { finish = resolve; }));
  harness.snapshotListeners[0](snapshot('new-connection'));
  finish(result(snapshot('old-connection')));
  assert.equal(await pending, undefined);
  assert.equal(harness.exports.useController().snapshot.source.connectionId, 'new-connection');
});

test('a late failure from a previous connection cannot fault the selected controller', async () => {
  const harness = load();
  const controller = harness.exports.useController();
  harness.effects.forEach(effect => effect());
  harness.snapshotListeners[0](snapshot('old-connection'));
  let fail;
  const pending = controller.invoke(() => new Promise((_resolve, reject) => { fail = reject; }));
  harness.snapshotListeners[0](snapshot('new-connection'));
  harness.statusListeners[0]({ state: 'ready' });
  fail(new Error('old connection failed'));
  assert.equal(await pending, undefined);
  assert.equal(harness.exports.useController().moduleStatus.state, 'ready');
});

test('a command failure preserves backend choices and the selected backend', async () => {
  const harness = load();
  const controller = harness.exports.useController();
  harness.effects.forEach(effect => effect());
  harness.snapshotListeners[0](snapshot());
  const status = { state: 'ready', selectedBackendId: 'example', backends: [
    { id: 'original', label: 'LUXIS', connected: true, selected: false, state: 'ready' },
    { id: 'example', label: '第三方控制器', connected: true, selected: true, state: 'ready' }
  ] };
  harness.statusListeners[0](status);
  assert.equal(await controller.invoke(async () => { throw new Error('command transport failed'); }), undefined);
  const updated = harness.exports.useController().moduleStatus;
  assert.equal(updated.state, 'fault');
  assert.equal(updated.selectedBackendId, 'example');
  assert.equal(updated.backends, status.backends);
  assert.equal(buttons(harness.exports.ControllerDeviceSelector({ status: updated, command: controller.invoke })).length, 2);
});

test('a detected third-party controller keeps manual game IO choices without installing the original DLL', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/hdd-setup-wizard.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX
  } }).outputText;
  const exports = {}, states = ['controller', {}, false];
  let cursor = 0;
  vm.runInNewContext(code, { exports, document: { body: {} }, require(name) {
    if (name.endsWith('.css')) return {};
    if (name === 'react-dom') return { createPortal: content => content };
    if (name === 'react') return { ...React, useEffect() {}, useMemo: fn => fn(),
      useState(initial) { return [cursor < states.length ? states[cursor++] : initial, () => {}]; } };
    return require(name);
  } });
  const html = render(React.createElement(exports.HddSetupWizard, { root: 'C:\\game',
    snapshot: snapshot(), moduleStatus: { state: 'ready' }, onClose() {}, async onChanged() {} }));
  assert.match(html, /已检测到 Custom Controller，请选择游戏输入方式/);
  assert.match(html, /选择 MU3IO DLL/);
  assert.doesNotMatch(html, /自动配置控制器|NYAGEKI_IO\.dll/);
});
