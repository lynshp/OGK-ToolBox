const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Run the actual page's hooks and event handlers against deferred bridge calls.
// No network, files from a game installation, or Electron renderer is involved.
const source = fs.readFileSync(process.env.OGK_OPTION_TEST_SOURCE || path.join(__dirname, '../src/option-packages-page.tsx'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX
} }).outputText;
const rootA = 'C:\\anonymous-game-a';
const rootB = 'C:\\anonymous-game-b';
const remote = id => ({ id, version: { major: 1, minor: 2, release: 0 }, asset: `${id}.zip`, size: 100, sha256: '0'.repeat(64) });
const manifest = { optionPackages: ['A001', 'A002', 'A003'].map(remote), mods: [], release: 'anonymous', schemaVersion: 1 };
const directory = (root, names = ['A001'], version = '1.2.0') => ({
  directoryPath: `${root}\\option`, exists: true, totalFiles: names.length * 2, totalSize: names.length * 100,
  packages: names.map(name => ({ name, directoryPath: `${root}\\option\\${name}`, version,
    isValid: true, isLoaded: true, statusText: '已加载', fileCount: 2, size: 100 }))
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const sameDeps = (left, right) => left && right && left.length === right.length && left.every((item, index) => Object.is(item, right[index]));
function harness(overrides = {}) {
  const hooks = [], reads = [], jobs = [], listeners = new Set(), callbacks = [], cancellations = [], deletions = [], manifestReads = [];
  let cursor = 0, dirty = true, tree, pendingEffects = [], mounted = true, lateWrites = 0;
  let props = { root: rootA, initialDirectory: directory(rootA), initialManifest: manifest,
    onDirectoryLoaded: value => callbacks.push(value), ...overrides };
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, update => {
        if (!mounted) { lateWrites++; return; }
        const value = typeof update === 'function' ? update(hooks[index].value) : update;
        if (!Object.is(value, hooks[index].value)) { hooks[index].value = value; dirty = true; }
      }];
    },
    useRef(initial) { const index = cursor++; return (hooks[index] ??= { current: initial }); },
    useMemo(factory, deps) {
      const index = cursor++;
      if (!hooks[index] || !sameDeps(hooks[index].deps, deps)) hooks[index] = { deps, value: factory() };
      return hooks[index].value;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (hooks[index] && sameDeps(hooks[index].deps, deps)) return;
      const previous = hooks[index];
      hooks[index] = { deps, cleanup: previous?.cleanup };
      pendingEffects.push(() => { hooks[index].cleanup?.(); hooks[index].cleanup = effect(); });
    }
  };
  const exports = {};
  vm.runInNewContext(code, { exports, Error, console, window: { confirm: () => true, ogk: {
    optionPackages: root => { const call = { root, ...deferred() }; reads.push(call); return call.promise; },
    packageManifest: () => { const call = deferred(); manifestReads.push(call); return call.promise; },
    downloadPackage: request => { const job = { request, ...deferred() }; jobs.push(job); return job.promise; },
    cancelPackage: id => cancellations.push(id),
    onPackageProgress: handler => { listeners.add(handler); return () => listeners.delete(handler); },
    deleteOptionPackage: request => { const call = { request, ...deferred() }; deletions.push(call); return call.promise; },
    openOptionDirectory: async () => {}
  } }, require(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }), Fragment: 'fragment' };
    if (name === './github-source-help') return { GithubSourceHelp() {} };
    return require(name);
  } });
  const render = () => {
    let iterations = 0;
    while (dirty && mounted) {
      assert.ok(iterations++ < 30, 'page should settle its effects');
      dirty = false; cursor = 0; tree = exports.OptionPackagesPage(props);
      const effects = pendingEffects; pendingEffects = []; effects.forEach(effect => effect());
    }
    return tree;
  };
  render();
  return {
    reads, jobs, callbacks, cancellations, deletions, manifestReads,
    get tree() { return render(); }, get lateWrites() { return lateWrites; },
    setProps(next) { props = { ...props, ...next }; dirty = true; render(); },
    emit(progress) { [...listeners].forEach(listener => listener(progress)); render(); },
    async flush() { await new Promise(setImmediate); render(); await new Promise(setImmediate); render(); },
    unmount() { hooks.forEach(hook => hook.cleanup?.()); mounted = false; }
  };
}
function all(node, predicate, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (Array.isArray(node)) { node.forEach(child => all(child, predicate, result)); return result; }
  if (predicate(node)) result.push(node);
  all(node.props?.children, predicate, result);
  return result;
}
function text(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text(node.props?.children);
}
const find = (node, predicate) => all(node, predicate)[0];
const byClass = (node, name) => find(node, item => item.props?.className?.split(' ').includes(name));
const row = (h, id) => all(h.tree, node => node.props?.className?.split(' ').includes('option-package-row')).find(node => text(find(node, item => item.type === 'b')) === id);
const rowStatus = (h, id) => text(find(row(h, id), node => node.type === 'em'));
const inspector = h => byClass(h.tree, 'option-package-inspector');
const button = (h, label) => find(h.tree, node => node.type === 'button' && node.props['aria-label'] === label);
const click = node => { assert.ok(node, 'control exists'); node.props.onClick({ preventDefault() {}, stopPropagation() {} }); };
const refreshButton = h => find(h.tree, node => node.type === 'button' && /刷新$/.test(text(node)));
const progress = (job, phase) => ({ ...job.request, phase, received: 100, total: 100, percent: 100, speed: 0 });
async function settleInitial(h, value = directory(rootA)) {
  // This also permits running these regressions against the original source to demonstrate the failure.
  const call = h.reads.at(-1);
  if (call) { call.resolve(value); await h.flush(); }
}

test('returning to a cached page re-inspects the directory and shows a download completed while away', async () => {
  const h = harness();
  assert.equal(rowStatus(h, 'A002'), '未下载');
  assert.equal(h.reads.length, 1, 'mount must revalidate a previously cached directory');
  h.reads[0].resolve(directory(rootA, ['A001', 'A002'])); await h.flush();
  assert.equal(rowStatus(h, 'A002'), '已加载');
  assert.equal(h.callbacks.length, 1);
  h.unmount();
});

test('a new parent snapshot at the same directory path refreshes both the row and inspector', async () => {
  const h = harness(); await settleInitial(h);
  click(row(h, 'A002'));
  h.setProps({ initialDirectory: directory(rootA, ['A001', 'A002']) });
  assert.equal(rowStatus(h, 'A002'), '已加载');
  assert.equal(text(find(inspector(h), node => node.type === 'h2')), 'A002');
  assert.match(text(inspector(h)), /目录路径.*anonymous-game-a/);
  h.unmount();
});

test('a pre-install inspection resolving after a newer download inspection cannot restore missing state', async () => {
  const h = harness(); await settleInitial(h);
  click(row(h, 'A002')); click(button(h, '下载 A002')); h.tree;
  click(refreshButton(h)); const oldRead = h.reads.at(-1);
  h.jobs[0].resolve({ kind: 'option', id: 'A002', path: `${rootA}\\option\\A002` }); await h.flush();
  const newRead = h.reads.at(-1);
  assert.notEqual(newRead, oldRead);
  newRead.resolve(directory(rootA, ['A001', 'A002'])); await h.flush();
  oldRead.resolve(directory(rootA)); await h.flush();
  assert.equal(rowStatus(h, 'A002'), '已加载');
  assert.equal(text(find(inspector(h), node => node.type === 'h2')), 'A002');
  assert.match(text(inspector(h)), /目录路径/);
  h.unmount();
});

test('completed progress updates immediately, coalesces the invoke result, and confirms installation through inspection', async () => {
  const h = harness(); await settleInitial(h);
  click(button(h, '下载 A002')); h.tree;
  const count = h.reads.length;
  h.emit(progress(h.jobs[0], 'completed'));
  assert.equal(h.reads.length, count + 1, 'completed progress should not wait for the invoke continuation');
  assert.equal(rowStatus(h, 'A002'), '正在更新目录…');
  assert.equal(button(h, '下载 A002').props.disabled, true);
  h.jobs[0].resolve({ kind: 'option', id: 'A002', path: `${rootA}\\option\\A002` }); await h.flush();
  assert.equal(h.reads.length, count + 1, 'event and invoke completion should not duplicate the inspection');
  h.reads.at(-1).resolve(directory(rootA, ['A001', 'A002'])); await h.flush();
  assert.equal(rowStatus(h, 'A002'), '已加载');
  assert.equal(byClass(row(h, 'A002'), 'option-row-download'), undefined);
  h.unmount();
});

test('batch download refreshes each completed package while the other package remains in progress', async () => {
  const h = harness(); await settleInitial(h);
  click(row(h, 'A002')); click(byClass(h.tree, 'option-batch-download')); h.tree;
  assert.equal(h.jobs.length, 2);
  const count = h.reads.length;
  h.jobs.find(job => job.request.id === 'A002').resolve({ kind: 'option', id: 'A002', path: `${rootA}\\option\\A002` }); await h.flush();
  assert.equal(h.reads.length, count + 1, 'the first completed batch item should already be inspected');
  h.reads.at(-1).resolve(directory(rootA, ['A001', 'A002'])); await h.flush();
  assert.equal(rowStatus(h, 'A002'), '已加载');
  assert.match(text(row(h, 'A003')), /准备下载/);
  assert.equal(byClass(h.tree, 'option-batch-download').props.disabled, true);
  assert.equal(text(find(inspector(h), node => node.type === 'h2')), 'A002');
  h.jobs.find(job => job.request.id === 'A003').resolve({ kind: 'option', id: 'A003', path: `${rootA}\\option\\A003` }); await h.flush();
  h.reads.at(-1).resolve(directory(rootA, ['A001', 'A002', 'A003'])); await h.flush();
  assert.equal(rowStatus(h, 'A003'), '已加载');
  assert.equal(byClass(h.tree, 'option-batch-download').props.disabled, false);
  assert.match(text(h.tree), /已完成 2 个/);
  h.unmount();
});

test('outdated read errors cannot clear the newer directory or show a stale error', async () => {
  const h = harness(); await settleInitial(h);
  click(button(h, '下载 A002')); h.tree; click(refreshButton(h)); const oldRead = h.reads.at(-1);
  h.jobs[0].resolve({ kind: 'option', id: 'A002', path: 'anonymous' }); await h.flush();
  h.reads.at(-1).resolve(directory(rootA, ['A001', 'A002'])); await h.flush();
  oldRead.reject(new Error('old read failure')); await h.flush();
  assert.equal(rowStatus(h, 'A002'), '已加载');
  assert.doesNotMatch(text(h.tree), /old read failure/);
  h.unmount();
});

test('switching game root ignores the old inspection and old download completion', async () => {
  const h = harness(); await settleInitial(h);
  click(button(h, '下载 A002')); h.tree; click(refreshButton(h)); const oldRead = h.reads.at(-1);
  h.setProps({ root: rootB, initialDirectory: directory(rootB), activeDownloads: [] });
  const newRead = h.reads.at(-1); assert.equal(newRead.root, rootB);
  newRead.resolve(directory(rootB)); await h.flush();
  const count = h.reads.length, callbackCount = h.callbacks.length;
  h.emit(progress(h.jobs[0], 'completed'));
  h.jobs[0].resolve({ kind: 'option', id: 'A002', path: 'old-root' });
  oldRead.resolve(directory(rootA, ['A001', 'A002'])); await h.flush();
  assert.equal(h.reads.length, count);
  assert.equal(h.callbacks.length, callbackCount);
  assert.equal(rowStatus(h, 'A002'), '未下载');
  assert.match(text(h.tree), /anonymous-game-b/);
  assert.doesNotMatch(text(h.tree), /anonymous-game-a/);
  h.unmount();
});

test('unmount ignores pending inspection, deletion, batch, and repository continuations', async () => {
  for (const operation of ['inspection', 'delete', 'batch', 'manifest']) {
    const h = harness(operation === 'manifest' ? { initialManifest: null } : {}); await settleInitial(h);
    if (operation === 'inspection') click(refreshButton(h));
    if (operation === 'delete') click(button(h, '删除 A001'));
    if (operation === 'batch') click(byClass(h.tree, 'option-batch-download'));
    if (operation === 'manifest') click(find(h.tree, node => node.type === 'button' && /检查更新$/.test(text(node))));
    h.tree; const readCount = h.reads.length, callbackCount = h.callbacks.length;
    h.unmount();
    h.reads.forEach(read => read.resolve(directory(rootA, ['A001', 'A002'])));
    h.deletions.forEach(call => call.resolve(true));
    h.jobs.forEach(job => job.resolve({ kind: 'option', id: job.request.id, path: 'anonymous' }));
    h.manifestReads.forEach(call => call.resolve(manifest));
    await h.flush();
    assert.equal(h.reads.length, readCount, `${operation}: no new scan after unmount`);
    assert.equal(h.callbacks.length, callbackCount, `${operation}: no stale parent callback`);
    assert.equal(h.lateWrites, 0, `${operation}: no state writes after unmount`);
  }
});

test('cancellation and installation failure do not mark a package installed and remain retryable', async () => {
  for (const phase of ['cancelled', 'error']) {
    const h = harness(); await settleInitial(h);
    click(button(h, '下载 A002')); h.tree; const count = h.reads.length;
    if (phase === 'cancelled') {
      click(find(row(h, 'A002'), node => node.type === 'button' && text(node) === '取消'));
      assert.equal(h.cancellations[0], h.jobs[0].request.downloadId);
    }
    h.emit({ ...progress(h.jobs[0], phase), message: phase === 'cancelled' ? '已取消' : 'checksum rejected', error: 'checksum rejected' });
    h.jobs[0].reject(new Error(phase === 'cancelled' ? '下载已取消。' : 'checksum rejected')); await h.flush();
    assert.equal(h.reads.length, count, 'a terminal failure is not an installation');
    assert.equal(rowStatus(h, 'A002'), '未下载');
    assert.equal(button(h, '下载 A002').props.disabled, false);
    if (phase === 'error') assert.match(text(row(h, 'A002')), /checksum rejected/);
    click(button(h, '下载 A002')); h.tree; assert.equal(h.jobs.length, 2);
    h.unmount();
  }
});

test('unknown progress cannot attach a download from another root to the current package', async () => {
  const h = harness(); await settleInitial(h); const count = h.reads.length;
  h.emit({ downloadId: 'foreign', kind: 'option', id: 'A002', phase: 'downloading', received: 1, total: 100, percent: 1, speed: 1 });
  assert.equal(byClass(row(h, 'A002'), 'option-row-download'), undefined);
  h.emit({ downloadId: 'foreign', kind: 'option', id: 'A002', phase: 'completed', received: 100, total: 100, percent: 100, speed: 0 });
  assert.equal(h.reads.length, count);
  assert.equal(rowStatus(h, 'A002'), '未下载');
  assert.equal(byClass(row(h, 'A002'), 'option-row-download'), undefined);
  h.unmount();
});

test('duplicate batch clicks do not start concurrent installs of the same missing packages', async () => {
  const h = harness(); await settleInitial(h);
  const control = byClass(h.tree, 'option-batch-download');
  click(control); click(control); h.tree;
  assert.equal(h.jobs.length, 2);
  h.unmount();
});

test('cancelling a retry does not reveal the previous failed attempt again', async () => {
  const h = harness(); await settleInitial(h);
  click(button(h, '下载 A002')); h.tree;
  h.emit({ ...progress(h.jobs[0], 'error'), message: 'previous failed attempt' });
  h.jobs[0].reject(new Error('previous failed attempt')); await h.flush();
  click(button(h, '下载 A002')); h.tree;
  assert.doesNotMatch(text(row(h, 'A002')), /previous failed attempt/);
  h.emit(progress(h.jobs[1], 'cancelled'));
  h.jobs[1].reject(new Error('下载已取消。')); await h.flush();
  assert.equal(byClass(row(h, 'A002'), 'option-row-download'), undefined);
  assert.equal(rowStatus(h, 'A002'), '未下载');
  h.unmount();
});

test('equal package IDs in Option and GameData remain separately selectable with fresh metadata', async () => {
  const local = directory(rootA, ['A001']);
  const secondary = { ...local.packages[0], directoryPath: `${rootA}\\mu3_Data\\StreamingAssets\\GameData\\A001`, version: '1.1.0', fileCount: 27 };
  local.packages.push(secondary);
  const h = harness({ initialDirectory: local }); await settleInitial(h, local);
  const secondaryRow = all(h.tree, node => node.props?.className?.split(' ').includes('option-package-row')).find(node => /27 个文件/.test(text(node)));
  click(secondaryRow); h.tree;
  assert.match(text(inspector(h)), /GameData\\A001/);
  assert.match(text(inspector(h)), /版本 1\.1\.0/);
  const next = { ...local, packages: [local.packages[0], { ...secondary, version: '1.2.0', fileCount: 33 }] };
  h.setProps({ initialDirectory: next });
  assert.match(text(inspector(h)), /GameData\\A001/);
  assert.match(text(inspector(h)), /版本 1\.2\.0/);
  assert.match(text(inspector(h)), /文件数量33/);
  h.unmount();
});
