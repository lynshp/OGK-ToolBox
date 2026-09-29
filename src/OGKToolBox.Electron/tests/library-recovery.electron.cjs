const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const os = require('node:os');
  const root = path.resolve(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(root, 'ogk-library-ui-'));
  const env = { ...process.env, OGK_LIBRARY_TEST_PROFILE: profile, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  child.on('exit', code => {
    if (path.dirname(path.resolve(profile)) !== root || !path.basename(profile).startsWith('ogk-library-ui-')) throw new Error('Invalid test profile');
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    process.exitCode = code ?? 1;
  });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  if (!process.env.OGK_LIBRARY_TEST_PROFILE) throw new Error('Run via Node');
  app.setPath('userData', process.env.OGK_LIBRARY_TEST_PROFILE);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
  const timeout = setTimeout(() => { console.error('Library UI test timed out'); app.exit(1); }, 30000);
  (async () => {
    await app.whenReady();
    const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
      preload: path.join(__dirname, 'library-recovery.preload.cjs'), contextIsolation: false,
      sandbox: false, offscreen: true, backgroundThrottling: false
    } });
    const errors = [];
    win.webContents.on('console-message', details => {
      if (details.level === 'error' && !details.message.includes('frame-ancestors')) errors.push(details.message);
    });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, done) => done({ cancel: true }));
    const evaluate = text => win.webContents.executeJavaScript(text, true);
    async function waitFor(text) {
      for (let i = 0; i < 150; i++) { if (await evaluate(text)) return; await new Promise(resolve => setTimeout(resolve, 30)); }
      throw new Error(`UI failed: ${text}; ${await evaluate('document.body.textContent')}`);
    }
    const output = path.resolve(__dirname, '../artifacts/library-recovery');
    fs.mkdirSync(output, { recursive: true });
    await win.loadFile(path.resolve(__dirname, '../dist/index.html'));
    await waitFor("!!document.querySelector('.boot-error-details')");
    assert.match(await evaluate("document.querySelector('.boot-error-details').textContent"), /磁盘可用/);
    assert.doesNotMatch(await evaluate("document.querySelector('.boot-error-details').textContent"), /invoking remote method/);
    assert.match(await evaluate("document.querySelector('.boot-loading-content').textContent"), /重新扫描并建立资源清单/);
    await evaluate('new Promise(resolve=>setTimeout(resolve,300))');
    fs.writeFileSync(path.join(output, 'error.png'), (await win.webContents.capturePage()).toPNG());
    await evaluate("[...document.querySelectorAll('.boot-directory-action')].find(b=>b.textContent==='重试加载').focus()");
    assert.equal(await evaluate('document.activeElement?.textContent'), '重试加载');
    await evaluate('document.activeElement.click()');
    await waitFor("!!document.querySelector('.app.boot-ready')");
    assert.deepEqual(await evaluate('window.__libraryTest.counts()'), { reads: 1, scans: 2 });
    assert.equal(await evaluate("localStorage.getItem('ogk-toolbox.game-root.v1')"), 'C:\\fixture\\package');
    await evaluate("document.querySelector('[data-nav-page=diagnostics]').click()");
    await waitFor("document.querySelector('.diagnostic-row')?.textContent.includes('RESOURCE_DUPLICATE')");
    assert.match(await evaluate("document.querySelector('.diagnostic-row').textContent"), /已使用：.*\n已跳过：/);
    await evaluate('new Promise(resolve=>setTimeout(resolve,400))');
    fs.writeFileSync(path.join(output, 'report-light.png'), (await win.webContents.capturePage()).toPNG());
    await evaluate("document.documentElement.classList.add('dark');document.querySelector('.app').classList.add('dark')");
    win.setSize(900, 1200);
    await evaluate('new Promise(resolve=>setTimeout(resolve,400))');
    assert.equal(await evaluate("(()=>{const row=document.querySelector('.diagnostic-row');return row.scrollWidth<=row.clientWidth+1})()"), true);
    fs.writeFileSync(path.join(output, 'report-dark-portrait.png'), (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, []);
    console.log('PASS: retry skips cache, enters app, persists package path, displays duplicate report; focus/light/dark/portrait verified.');
    clearTimeout(timeout); win.destroy(); app.exit(0);
  })().catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
}
