const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const load = require('./helpers/load-controller-module.cjs');
const { safeUpdateError } = load('electron/update-network.ts', { electron: {}, './fastgithub-manager': {} });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(options = {}) {
  const handlers = {}, probes = [], checks = [], routes = [], snapshots = [], prompts = [];
  let active, downloads = 0;
  const updater = new EventEmitter();
  updater.setFeedURL = () => {};
  updater.checkForUpdates = async () => {
    checks.push(active); updater.emit('checking-for-update');
    if (options.checkFail?.includes(active)) { const error = new Error('net::ERR_CONNECTION_TIMED_OUT'); updater.emit('error', error); throw error; }
    updater.emit(options.available ? 'update-available' : 'update-not-available', { version: '1.1.9' });
    return { cancellationToken: { cancel() {} } };
  };
  updater.downloadUpdate = async () => {
    downloads++;
    updater.emit('download-progress', { percent: 100 });
    if (options.downloadGate) await options.downloadGate.promise;
    if (options.downloadFail) { const error = new Error('sha512 checksum mismatch'); updater.emit('error', error); throw error; }
    updater.emit('update-downloaded', { version: '1.1.9' });
    return ['installer.exe'];
  };
  let preference = { source: 'auto', downloadSource: 'auto' };
  const sharedSources = {
    useChannel: () => {},
    probeMetadata: async () => {
      if (options.proxyGate) await options.proxyGate.promise;
      if (options.proxyLatency !== undefined) await new Promise(r => setTimeout(r, options.proxyLatency));
      return options.proxyLatency === undefined ? ({results:[]}) : ({node:"https://gh-proxy.org",latencyMs:options.proxyLatency,results:[]});
    },
    load: async () => {}, get: () => preference,
    save: async (source, downloadSource) => { preference = { source, downloadSource }; },
    selectAsset: async () => {
      const node = options.assetFail ? undefined : 'https://v4.gh-proxy.org';
      const results = [{ node: 'https://v4.gh-proxy.org', ...(node ? { latencyMs: 25 } : { error: 'HTTP 502' }) }];
      sharedSources.onNodes?.(results, node); return { node, latencyMs: node ? 25 : undefined, results };
    }
  };
  const { UpdateManager } = load('electron/update-manager.ts', {
    electron: {
      app: { isPackaged: true, getVersion: () => '1.1.8', getPath: () => '/test-data' },
      ipcMain: { handle: (name, handler) => handlers[name] = handler, on() {} },
      dialog: { showMessageBox: async (_window, message) => { prompts.push(message); return { response: 1 }; } }, safeStorage: {}
    },
    'electron-updater': { autoUpdater: updater },
    'node:fs': { existsSync: file => file.endsWith('app-update.yml'), readFileSync: () => 'owner: lynshp\nrepo: OGKToolBox-releases\nprivate: false' },
    './fastgithub-manager': { fastGithubManager: { disable: async () => {} } },
    './github-sources': { githubSources: sharedSources },
    './release-asset-provider': { createReleaseAssetProvider: onAssets => {
      onAssets(['https://github.com/lynshp/OGKToolBox-releases/releases/download/v1.1.9/Setup.exe']); return class {};
    } },
    './update-network': {
      safeUpdateError,
      selectUpdateChannel: async channel => { active = channel; routes.push(channel); },
      probeUpdateChannel: async (_feed, _token, channel) => {
        probes.push(channel);
        if (options.probeGate) await options.probeGate.promise;
        if (options.channelGates?.[channel]) await options.channelGates[channel].promise;
        if (options.latencies?.[channel] !== undefined) await new Promise(r => setTimeout(r, options.latencies[channel]));
        if (options.probeFail?.includes(channel)) throw new Error('HTTP 502 at https://github.com/a?token=secret');
        return options.latencies?.[channel] ?? 12;
      }
    }
  }, { process: { ...process, resourcesPath: '/resources', env: { ...process.env } } });
  const manager = new UpdateManager({ getWindow: () => options.window ? { isDestroyed: () => false } : undefined });
  manager.listeners.add(status => snapshots.push(status));
  return { manager, updater, handlers, probes, checks, routes, snapshots, prompts, downloads: () => downloads };
}

test('auto starts all probes and uses the first reachable channel; every click probes again', async () => {
  const f = fixture(); await f.manager.start();
  assert.deepEqual(f.probes, ['fastgithub', 'github']);
  assert.deepEqual(f.checks, ['fastgithub']);
  assert.equal(f.manager.status.channels.github.state, 'reachable');
  await f.handlers['update:check'](null, 'auto');
  assert.equal(f.probes.length, 4);
});
test('auto falls back after probe failure and retains useful sanitized diagnostics', async () => {
  const f = fixture({ probeFail: ['fastgithub'] }); await f.manager.start();
  assert.deepEqual(f.checks, ['github']);
  assert.equal(f.manager.status.state, 'not-available');
  assert.match(f.manager.status.diagnostics.join('\n'), /HTTP 502/);
  assert.doesNotMatch(f.manager.status.diagnostics.join('\n'), /secret/);
});
test('a successful probe does not prevent fallback when the actual version request fails', async () => {
  const f = fixture({ checkFail: ['fastgithub'] }); await f.manager.start();
  assert.deepEqual(f.checks, ['fastgithub', 'github']);
  assert.equal(f.manager.status.activeChannel, 'github');
  assert.equal(f.manager.status.channels.fastgithub.state, 'failed');
});
test('manual route is honored; both routes are re-probed without silently overriding the choice', async () => {
  const f = fixture({ probeFail: ['fastgithub'] }); await f.manager.start();
  f.checks.length = 0;
  await f.handlers['update:check'](null, 'fastgithub');
  assert.equal(f.manager.status.state, 'error');
  assert.equal(f.checks.length, 0);
  await f.handlers['update:check'](null, 'github');
  assert.deepEqual(f.checks, ['github']);
});
test('two failed routes retain separate errors and reject invalid IPC choices', async () => {
  const f = fixture({ probeFail: ['fastgithub', 'github'] }); await f.manager.start();
  assert.equal(f.manager.status.state, 'error');
  assert.equal(f.manager.status.diagnostics.length, 3);
  assert.throws(() => f.handlers['update:check'](null, 'http://evil.test'));
});
test('a complete operation lock prevents duplicate checks during probing and downloading', async () => {
  const gate = deferred(), f = fixture({ available: true, downloadGate: gate });
  const first = f.manager.start(); await tick();
  assert.equal(f.manager.status.state, 'verifying');
  assert.equal(f.manager.status.progress, 99);
  const again = f.handlers['update:check'](null, 'github'); await tick();
  assert.equal(f.probes.length, 2); assert.equal(f.downloads(), 1);
  gate.resolve(); await Promise.all([first, again]);
  assert.equal(f.manager.status.state, 'ready'); assert.equal(f.manager.status.progress, 100);
  assert.equal(f.updater.autoDownload, false); assert.equal(f.updater.disableDifferentialDownload, true);
});
test('verification failure is explicit and never silently restarts a full download', async () => {
  const f = fixture({ available: true, downloadFail: true }); await f.manager.start();
  assert.equal(f.downloads(), 1); assert.equal(f.manager.status.state, 'error');
  assert.match(f.manager.status.error, /校验安装包.*sha512/);
  assert.equal(f.manager.status.progress, 99);
});
test('stop while probing prevents subsequent version checks and downloads', async () => {
  const gate = deferred(), f = fixture({ probeGate: gate, available: true });
  const start = f.manager.start(); await tick(); await f.manager.stop(); gate.resolve(); await start;
  assert.equal(f.checks.length, 0); assert.equal(f.downloads(), 0);
});
test('diagnostics redact provided tokens, known token prefixes and signed query strings', () => {
  const text = safeUpdateError(new Error('Bearer secret-value https://x.test/file.exe?sig=hidden github_pat_123abc'), 'secret-value');
  assert.doesNotMatch(text, /secret-value|hidden|123abc/); assert.match(text, /file.exe/);
});

for (const trigger of ['startup', 'manual']) {
  test(`${trigger} automatically downloads an available update and prompts only after verification`, async () => {
    const gate = deferred();
    const options = { window: true, available: trigger === 'startup', downloadGate: gate };
    const f = fixture(options);
    let operation;
    if (trigger === 'startup') operation = f.manager.start();
    else { await f.manager.start(); options.available = true; operation = f.handlers['update:check'](null, 'github'); }
    await tick();
    assert.equal(f.downloads(), 1, 'No separate download click should be required');
    assert.equal(f.manager.status.state, 'verifying');
    assert.equal(f.prompts.length, 0, '100% transport progress must not prompt before verification');
    gate.resolve(); await operation; await tick();
    assert.equal(f.prompts.length, 1);
    assert.match(f.prompts[0].message, /1.1.9/);
    assert.equal(f.prompts[0].buttons.join(','), '立即重启,稍后');
    assert.equal(f.manager.status.state, 'ready');
    await f.manager.promptInstall('1.1.9');
    assert.equal(f.prompts.length, 1, 'Choosing later should not immediately prompt again');
  });
}
test('failed verification never opens the installation prompt', async () => {
  const f = fixture({ window: true, available: true, downloadFail: true });
  await f.manager.start(); await tick();
  assert.equal(f.prompts.length, 0); assert.equal(f.manager.status.state, 'error');
});
test('automatic selection uses fastest reachable source for both version and installer', async () => {
  const f = fixture({ available:true, proxyLatency:2, latencies:{fastgithub:25,github:25} }); await f.manager.start();
  assert.equal(f.manager.status.activeChannel, 'ghproxy');
  assert.equal(f.manager.status.activeDownload, 'ghproxy');
  assert.equal(f.downloads(),1);
});
test('manual GH-Proxy does not silently fall back when its version probe fails', async () => {
  const f=fixture(); await f.manager.start(); f.checks.length=0;
  await f.handlers['update:check'](null,'ghproxy');
  assert.equal(f.manager.status.state,'error'); assert.equal(f.checks.length,0);
});
test('native source can win automatic detection and is also used for downloads', async () => {
  const f=fixture({available:true,proxyLatency:40,latencies:{fastgithub:25,github:2}});await f.manager.start();
  assert.equal(f.manager.status.activeChannel,'github');assert.equal(f.manager.status.activeDownload,'github');
});

test('a reachable native channel starts downloading while FastGithub and GH-Proxy are still pending', async () => {
  const slow = deferred(), proxy = deferred();
  const f = fixture({available:true, channelGates:{fastgithub:slow}, proxyGate:proxy});
  const operation = f.manager.start(); await tick();
  assert.deepEqual(f.probes,['fastgithub','github']);
  assert.equal(f.downloads(),1);
  assert.equal(f.manager.status.state,'ready');
  assert.equal(f.manager.status.channels.fastgithub.state,'checking');
  assert.deepEqual(f.routes,['github'],'Background probes must not switch the updater session');
  slow.resolve();proxy.resolve();await operation;await tick();
  assert.equal(f.manager.status.state,'ready');
  assert.equal(f.manager.status.activeChannel,'github');
});

test('manual source begins immediately when ready without waiting for other probes', async () => {
  const options={}; const f=fixture(options);await f.manager.start();
  const slow=deferred();options.channelGates={fastgithub:slow};options.proxyGate=slow;
  f.checks.length=0;
  const operation=f.handlers['update:check'](null,'github');await tick();
  assert.deepEqual(f.checks,['github']);
  assert.equal(f.manager.status.state,'not-available');
  slow.resolve();await operation;await tick();
});

test('late probes from a previous check cannot overwrite the next check diagnostics', async () => {
  const old=deferred(),current=deferred();
  const options={channelGates:{fastgithub:old}};const f=fixture(options);
  await f.manager.start();
  options.channelGates={fastgithub:current};
  await f.handlers['update:check'](null,'github');
  old.resolve();await tick();
  assert.equal(f.manager.status.channels.fastgithub.state,'checking');
  current.resolve();await tick();
  assert.equal(f.manager.status.channels.fastgithub.state,'reachable');
});
