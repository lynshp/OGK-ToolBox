const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/hdd-setup-wizard.tsx'), 'utf8');
const code = ts.transpileModule(source + '\nexport { saveSegatools };', { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX
} }).outputText;
const missing = (section, key) => ({ section, key, value: '', lineNumber: 0,
  locator: `${section}:${key}`, isPresent: false });
function load(entries, { exists = true, values = [], canSave = true } = {}) {
  const previews = [], saves = [], events = [], exports = {};
  let cursor = 0;
  const window = {
    dispatchEvent: event => events.push(event.type),
    ogk: {
      inspectConfiguration: async () => ({ files: [{ kind: 'SegaTools', exists, contentHash: 'current', entries }] }),
      previewConfiguration: async request => {
        previews.push(request);
        return { canSave, token: 'ticket', validationErrors: canSave ? [] : ['文件已被其他程序修改，请重新读取后再编辑。'] };
      },
      saveConfiguration: async request => { saves.push(request); }
    }
  };
  vm.runInNewContext(code, { exports, window, Event, document: { body: {} },
    require(name) {
      if (name.endsWith('.css')) return {};
      if (name === 'react-dom') return { createPortal: value => value };
      if (name === 'react') return { useEffect() {}, useMemo: fn => fn(),
        useState(initial) {
          const index = cursor++;
          if (index >= values.length) values[index] = initial;
          return [values[index], next => { values[index] = next; }];
        } };
      return require(name);
    }
  });
  return { exports, previews, saves, events, values };
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
}

test('Mod setup submits missing Unity keys through the normal preview and save flow', async () => {
  const h = load([missing('unity', 'enable'), missing('unity', 'targetAssembly')]);
  await h.exports.saveSegatools('C:\\fixture', [
    { section: 'unity', key: 'enable', value: '1' },
    { section: 'unity', key: 'targetAssembly', value: 'BepInEx\\core\\BepInEx.Preloader.dll' }
  ]);
  assert.equal(h.previews[0].baselineHash, 'current');
  assert.equal(h.previews[0].edits.length, 2);
  assert.ok(h.previews[0].edits.every(edit => edit.lineNumber === 0));
  assert.equal(h.saves[0].preview.token, 'ticket');
  assert.deepEqual(h.events, ['ogk:configuration-changed']);
});

test('a missing empty Keychip and AimeDB are omitted when saving the selected server', async () => {
  const h = load([missing('dns', 'default'), missing('dns', 'AimeDB'), missing('keychip', 'id')]);
  await h.exports.saveSegatools('C:\\fixture', [
    { section: 'dns', key: 'default', value: 'nageki-net.com' },
    { section: 'dns', key: 'aimedb', value: '', removeIfEmpty: true },
    { section: 'keychip', key: 'id', value: '' }
  ]);
  assert.equal(h.previews[0].edits.length, 1);
  assert.equal(h.previews[0].edits[0].key, 'default');
});

for (const [existing, draft] of [['TEST12345678', ''], ['', 'UNSAVED12345']]) {
  test(`Later leaves the saved Keychip unchanged (existing=${Boolean(existing)}, draft=${Boolean(draft)})`, async () => {
    const values = ['server', {}, false, '', '', 'play.mumur.net', '', draft, existing];
    const entry = existing ? { ...missing('keychip', 'id'), value: existing, lineNumber: 8, isPresent: true }
      : missing('keychip', 'id');
    const h = load([missing('dns', 'default'), missing('dns', 'AimeDB'), entry], { values });
    let refreshed = 0;
    const tree = h.exports.HddSetupWizard({ root: 'C:\\fixture', snapshot: {
      state: 'Searching', identity: { kind: 'Unknown' }
    }, moduleStatus: { state: 'ready' }, onClose() {}, onChanged: async () => { refreshed++; } });
    const button = find(tree, node => node.type === 'button' && node.props.children === '稍后填写');
    assert.ok(button);
    button.props.onClick();
    await new Promise(setImmediate);
    assert.equal(values[0], 'controller');
    assert.equal(values[2], false);
    assert.equal(values[3], '');
    assert.equal(refreshed, 1);
    assert.ok(h.previews[0].edits.every(edit => edit.section !== 'keychip'));
  });
}

test('a missing ini explains how to recover without attempting a write', async () => {
  const h = load([], { exists: false });
  await assert.rejects(h.exports.saveSegatools('C:\\fixture', []), /返回 Segatools 步骤安装后重试/);
  assert.equal(h.saves.length, 0);
});

test('a rejected preview keeps the file unchanged and reports its validation error', async () => {
  const h = load([missing('unity', 'enable')], { canSave: false });
  await assert.rejects(h.exports.saveSegatools('C:\\fixture', [{ section: 'unity', key: 'enable', value: '1' }]), /其他程序修改/);
  assert.equal(h.saves.length, 0);
  assert.deepEqual(h.events, []);
});
