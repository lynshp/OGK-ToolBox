const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/load-controller-module.cjs');
test('native update route is direct and does not change the package download session', async () => {
  const sessions = new Map();
  const { FastGithubManager } = load('electron/fastgithub-manager.ts', {
    electron: { session: { fromPartition: name => {
      if (!sessions.has(name)) sessions.set(name, { closed: 0, closeAllConnections: async function() { this.closed++; },
        setProxy: async function(value) { this.proxy = value; }, setCertificateVerifyProc(value) { this.verify = value; } });
      return sessions.get(name);
    } } }
  });
  const manager = new FastGithubManager();
  manager.enable = async () => { return true; };
  await manager.configureUpdater(true);
  const updater = sessions.get('electron-updater');
  assert.match(updater.proxy.proxyRules, /38457/);
  let result;
  updater.verify({ hostname: 'github.com', certificate: { issuerName: 'FastGithub', issuerCert: { fingerprint: 'other-cert' } }, verificationResult: 'ERR' }, code => result = code);
  assert.equal(result, -2);
  updater.verify({ hostname: 'github.com', certificate: { issuerName: 'FastGithub', issuerCert: { fingerprint: 'local-cert' } }, verificationResult: 'OK' }, code => result = code);
  assert.equal(result, 0);
  await manager.configureUpdater(false);
  assert.equal(updater.proxy.mode, 'direct'); assert.equal(updater.verify, null);
  assert.equal(sessions.has('ogk-github'), false);
});
test('FastGithub startup failure is not silently treated as an enabled route', async () => {
  const { FastGithubManager } = load('electron/fastgithub-manager.ts', { electron: {} });
  const manager = new FastGithubManager();
  manager.enable = async () => { manager.lastError = '安装目录缺少 fastgithub.exe'; return false; };
  await assert.rejects(manager.configureUpdater(true), /缺少 fastgithub.exe/);
});
test('shutdown still stops the owned process if Electron sessions are already destroyed', async () => {
  const { FastGithubManager } = load('electron/fastgithub-manager.ts', {
    electron: { session: { fromPartition() { throw new Error('session destroyed'); } } }
  });
  const manager = new FastGithubManager(); let stopped = false;
  manager.stopProcess = async () => { stopped = true; };
  await manager.disable(); assert.equal(stopped, true);
});

test('cold start creates DataRoot before spawning FastGithub', async () => {
  const calls = [];
  const { FastGithubManager } = load('electron/fastgithub-manager.ts', {
    electron: { app: { getPath: () => '/fixture/profile' } },
    'node:fs': { existsSync: () => true },
    'node:fs/promises': { mkdir: async (directory, options) => { assert.equal(options.recursive, true); calls.push(['mkdir', directory]); } },
    'node:child_process': { spawn: (_file, args) => { calls.push(['spawn', args]); return Object.assign(new (require('node:events').EventEmitter)(), { exitCode: 1 }); } }
  }, { process: { platform: 'win32', resourcesPath: '/fixture/resources', pid: 42 } });
  const manager = new FastGithubManager(); manager.waitUntilReady = async () => false;
  await manager.enable();
  assert.equal(calls[0][0], 'mkdir'); assert.equal(calls[1][0], 'spawn');
  assert.ok(calls[1][1].includes(`DataRoot=${calls[0][1]}`));
});

test('DataRoot creation failure stops startup with a useful error', async () => {
  const { FastGithubManager } = load('electron/fastgithub-manager.ts', {
    electron: { app: { getPath: () => '/fixture/profile' } },
    'node:fs': { existsSync: () => true },
    'node:fs/promises': { mkdir: async () => { throw Error('EACCES'); } },
    'node:child_process': { spawn: () => { throw Error('must not spawn'); } }
  }, { process: { platform: 'win32', resourcesPath: '/fixture/resources', pid: 42 } });
  const manager = new FastGithubManager();
  assert.equal(await manager.enable(), false); assert.match(manager.lastError, /EACCES/);
});

const certificates = require('./fixtures/fastgithub/certificates.json');
const { X509Certificate } = require('node:crypto');
const { isTrustedFastGithubCertificate: trusted } = load('electron/fastgithub-manager.ts', { electron: {} });
const now = Date.parse('2026-09-18T00:00:00Z');
test('a leaf-only chain is accepted only with a valid signature from the local CA', () => {
  assert.equal(trusted('raw.githubusercontent.com', certificates.leaf, new X509Certificate(certificates.ca), now), true);
  assert.equal(trusted('raw.githubusercontent.com', certificates.leaf, new X509Certificate(certificates.otherCa), now), false);
});
test('local certificate verification rejects incorrect hosts, expiry, missing CA and malformed data', () => {
  const ca = new X509Certificate(certificates.ca);
  assert.equal(trusted('api.github.com', certificates.leaf, ca, now), false);
  assert.equal(trusted('example.com', certificates.leaf, ca, now), false);
  assert.equal(trusted('raw.githubusercontent.com', certificates.leaf, ca, Date.parse('2031-01-01')), false);
  assert.equal(trusted('raw.githubusercontent.com', certificates.leaf, ca, Date.parse('2024-01-01')), false);
  assert.equal(trusted('raw.githubusercontent.com', certificates.leaf, undefined, now), false);
  assert.equal(trusted('raw.githubusercontent.com', 'invalid', ca, now), false);
});
