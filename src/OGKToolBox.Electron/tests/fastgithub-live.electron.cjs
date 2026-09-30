// Opt-in live FastGithub test, after npm run build:main. No system proxy/CA changes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], {
    env, stdio: 'inherit', windowsHide: true
  });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, session } = require('electron');
  const root = path.resolve(__dirname, '../artifacts/fastgithub-live-' + Date.now());
  fs.mkdirSync(root, { recursive: true }); app.setPath('userData', root);
  Object.defineProperty(process, 'resourcesPath', {
    value: process.env.OGK_LIVE_RESOURCES || path.resolve(__dirname, '../../../artifacts/update-review/win-unpacked/resources')
  });
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu');
  app.whenReady().then(async () => {
    const { fastGithubManager: manager } = require('../dist-electron/electron/fastgithub-manager');
    const result = { tests: [] }; let failed = false;
    try {
      const started = Date.now(); result.enabled = await manager.enable();
      result.startMs = Date.now() - started; result.error = manager.lastError;
      assert.equal(result.enabled, true, result.error);
      await manager.configureUpdater(true);
      const queries = [
        ['manifest', 'https://raw.githubusercontent.com/lynshp/OptionPackage/main/manifest.json', 'ogk-github'],
        ['api', 'https://api.github.com/repos/lynshp/OptionPackage/releases/tags/option', 'ogk-github'],
        ['update', 'https://github.com/lynshp/OGKToolBox-releases/releases/latest/download/latest.yml', 'electron-updater'],
        ['asset', 'https://github.com/lynshp/OptionPackage/releases/download/option/A033.zip', 'ogk-github']
      ];
      for (const [kind, url, partition] of queries) {
        const started = Date.now();
        try {
          const target = session.fromPartition(partition);
          assert.equal(await target.resolveProxy(url), 'PROXY 127.0.0.1:38457');
          const response = await target.fetch(url, { signal: AbortSignal.timeout(20000), cache: 'no-store' });
          assert.equal(response.status, 200);
          const bytes = Buffer.from(await response.arrayBuffer());
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          if (kind === 'manifest') assert.ok(Array.isArray(JSON.parse(bytes).optionPackages));
          if (kind === 'api') assert.equal(JSON.parse(bytes).tag_name, 'option');
          if (kind === 'update') assert.match(bytes.toString(), /^version:\s*\S+/m);
          if (kind === 'asset') assert.equal(sha256, '8c750eb8507c2d8ac83903be5d985910a2ef6d224dcfba8e8021f49b4fb79de1');
          const test = { kind, status: response.status, bytes: bytes.length, ms: Date.now() - started, sha256 };
          result.tests.push(test); console.log(JSON.stringify(test));
        } catch (error) {
          failed = true;
          const test = { kind, error: String(error), ms: Date.now() - started };
          result.tests.push(test); console.error(JSON.stringify(test));
        }
      }
    } catch (error) { failed = true; result.error = String(error); }
    finally {
      fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(result, null, 2));
      console.log('Report:', path.join(root, 'report.json'));
      await manager.disable(); app.exit(failed ? 1 : 0);
    }
  }).catch(error => { console.error(error); app.exit(1); });
}
