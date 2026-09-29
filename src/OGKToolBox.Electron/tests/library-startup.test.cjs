const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');

function load(relative, overrides = {}, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true
  }}).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => overrides[name] ?? require(name),
    __dirname, process, console, Buffer, URL, AbortController, setTimeout, clearTimeout, ...globals });
  return exports;
}

const { loadInitialLibrary } = load('src/library-startup.ts');
const { libraryFailureMessage } = load('src/library-startup.ts');
const { resolveGameDirectory } = load('electron/game-directory.ts');

test('retry bypasses even a valid cache and propagates a failed rebuild', async () => {
  let reads = 0, scans = 0;
  const result = await loadInitialLibrary(async () => { reads++; return {}; },
    async () => { scans++; return { rebuilt: true }; }, () => true, true);
  assert.equal(reads, 0);
  assert.equal(scans, 1);
  assert.equal(result.cached, false);
  assert.equal(result.value.rebuilt, true);
  await assert.rejects(loadInitialLibrary(async () => ({}), async () => { throw new Error('disk unavailable'); }, () => true, true), /disk unavailable/);
});

test('readable errors retain paths and causes without IPC and parameter boilerplate', () => {
  const message = libraryFailureMessage(new Error("Error invoking remote method 'library:scan': Error: 没有找到完整的游戏目录。\n当前选择：D:\\game (Parameter 'rootPath')"));
  assert.match(message, /当前选择：D:\\game/);
  assert.doesNotMatch(message, /invoking remote|Parameter/);
  assert.match(libraryFailureMessage(new Error('SQLite Error 10: disk I/O error')), /磁盘可用/);
  assert.match(libraryFailureMessage(new Error('SQLite Error 19: UNIQUE constraint failed: resources.logical_id')), /重复记录/);
});

async function withGameTree(run) {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ogk-directory-'));
  const game = (...parts) => {
    const target = path.join(root, ...parts);
    fs.mkdirSync(path.join(target, 'mu3_Data/StreamingAssets/GameData/A000'), { recursive: true });
    fs.mkdirSync(path.join(target, 'mu3_Data/StreamingAssets/assets'), { recursive: true });
    return target;
  };
  try { await run(root, game); }
  finally {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('ogk-directory-')) throw new Error('Unsafe test directory');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('finds direct, parent and nested game folders and returns the actual package path', () => withGameTree(async (root, game) => {
  const actual = game('ongeki', 'Ongeki', 'package');
  assert.equal(await resolveGameDirectory(root), actual);
  assert.equal(await resolveGameDirectory(path.dirname(actual)), actual);
  assert.equal(await resolveGameDirectory(actual), actual);
}));

test('multiple installations require a specific choice instead of guessing', () => withGameTree(async (root, game) => {
  const a = game('one', 'package'), b = game('two', 'package');
  await assert.rejects(resolveGameDirectory(root), error => error.message.includes(a) && error.message.includes(b) && error.message.includes('多套游戏'));
}));

test('missing files report the selected root and missing asset path', () => withGameTree(async (root, game) => {
  const actual = game('package');
  fs.rmdirSync(path.join(actual, 'mu3_Data/StreamingAssets/assets'));
  await assert.rejects(resolveGameDirectory(root), error => error.message.includes(root) && error.message.includes(path.join(actual, 'mu3_Data/StreamingAssets/assets')));
  await assert.rejects(resolveGameDirectory(path.join(root, 'missing')), /不存在/);
}));

test('bounded search explains when a closer folder is required', () => withGameTree(async (root, game) => {
  const actual = game('a', 'b', 'c', 'd', 'package');
  await assert.rejects(resolveGameDirectory(root), /4 层/);
  assert.equal(await resolveGameDirectory(path.join(root, 'a')), actual);
}));

test('does not follow junctions into another tree', () => withGameTree(async (root, game) => {
  game('outside', 'package');
  const selected = path.join(root, 'selected');
  fs.mkdirSync(selected);
  fs.symlinkSync(path.join(root, 'outside'), path.join(selected, 'link'), 'junction');
  await assert.rejects(resolveGameDirectory(selected), /没有找到/);
}));

test('valid cache enters the app without a second summary request or scan', async () => {
  const cached = { summary: { resourceCount: 26807 } };
  const result = await loadInitialLibrary(async () => cached,
    async () => { throw new Error('Unexpected scan'); }, () => true);
  assert.equal(result.value, cached);
  assert.equal(result.cached, true);
});

for (const failure of [false, true]) {
  test(`missing or failed cache is rebuilt (failure=${failure})`, async () => {
    let scans = 0;
    const rebuilt = {};
    const result = await loadInitialLibrary(async () => {
      if (failure) throw new Error('Cache request timed out');
      return null;
    }, async () => { scans++; return rebuilt; }, () => true);
    assert.equal(result.value, rebuilt);
    assert.equal(result.cached, false);
    assert.equal(scans, 1);
  });
}

test('rebuild errors preserve the actual reason for the error screen', async () => {
  await assert.rejects(loadInitialLibrary(async () => null,
    async () => { throw new Error('Directory unavailable'); }, () => true), /Directory unavailable/);
});

test('an abandoned startup does not launch a scan or publish a result', async () => {
  assert.equal(await loadInitialLibrary(async () => null,
    async () => { throw new Error('Unexpected scan'); }, () => false), null);
  let active = true;
  assert.equal(await loadInitialLibrary(async () => null,
    async () => { active = false; return {}; }, () => active), null);
});

test('failed API startup can be retried, and concurrent callers share the retry', async () => {
  let starts = 0;
  let instanceId;
  const spawn = (_file, _args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.kill = () => { child.exitCode = 1; child.emit('exit', 1); };
    starts++;
    instanceId = options.env.OGK_INSTANCE_ID;
    const fails = starts === 1;
    setImmediate(() => {
      if (fails) { child.stderr.emit('data', Buffer.from('startup failed')); child.kill(); }
      else child.stdout.emit('data', Buffer.from('OGK_READY ' + JSON.stringify({
        address: 'http://127.0.0.1:12345', instanceId
      }) + '\n'));
    });
    return child;
  };
  const { BackendManager } = load('electron/backend-manager.ts', {
    electron: { app: { isPackaged: false } }, 'node:child_process': { spawn }
  }, { fetch: async () => ({ ok: true, json: async () => ({ instanceId }) }) });
  const backend = new BackendManager();
  await assert.rejects(backend.start(), /startup failed/);
  await Promise.all([backend.start(), backend.start()]);
  assert.equal(starts, 2);
});
