// Run after npm run build: node tests/update-ui.electron.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
if (!process.versions.electron) {
  const root = path.resolve(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(root, 'ogk-update-ui-'));
  const env = { ...process.env, OGK_UPDATE_TEST_PROFILE: profile, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  child.on('exit', code => {
    if (path.dirname(path.resolve(profile)) !== root || !path.basename(profile).startsWith('ogk-update-ui-')) throw new Error('Invalid test profile');
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    process.exitCode = code ?? 1;
  });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  if (!process.env.OGK_UPDATE_TEST_PROFILE) throw new Error('Run via Node');
  app.setPath('userData', process.env.OGK_UPDATE_TEST_PROFILE);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
  const deadline = setTimeout(() => { console.error('UI test timed out'); app.exit(1); }, 30000);
  (async () => {
    await app.whenReady();
    const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
      preload: path.join(__dirname, 'update-ui.preload.cjs'), contextIsolation: false,
      sandbox: false, backgroundThrottling: false, offscreen: true
    } });
    const errors = [];
    win.webContents.on('console-message', details => {
      if (details.level === 'error' && !details.message.includes("frame-ancestors")) errors.push(details.message);
    });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, done) => done({ cancel: true }));
    const evaluate = script => win.webContents.executeJavaScript(script, true).catch(error => { throw new Error(`${script}: ${error.message}; ${errors.join('\n')}`); });
    async function waitFor(script) {
      for (let n = 0; n < 100; n++) { if (await evaluate(script)) return; await new Promise(r => setTimeout(r, 30)); }
      throw new Error(`UI condition failed: ${script}; ${errors.join('\n')}; ${await evaluate('document.body.textContent')}`);
    }
    await win.loadFile(path.resolve(__dirname, '../dist/index.html'));
    await waitFor("!!document.querySelector('.app.boot-ready')");
    await evaluate("document.querySelector('[data-nav-page=settings]').click()");
    await waitFor("!!document.querySelector('.settings-nav')");
    await evaluate("[...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent==='关于').click()");
    await waitFor("!!document.querySelector('.update-channel-picker')");
    assert.match(await evaluate('document.body.textContent'), /加入群聊：827579852获取更新/);
    await evaluate("document.querySelector('.update-channel-picker button').click()");
    await waitFor("document.querySelectorAll('[role=menuitemradio]').length===4");
    assert.match(await evaluate("document.querySelector('[role=menu]').textContent"), /检测失败.*原生 GitHub · 可连通/);
    await evaluate("document.querySelector('[role=menu]').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})); document.activeElement.click()");
    await waitFor("!document.querySelector('[role=menu]')");
    await waitFor("document.activeElement===document.querySelector('.update-channel-picker button')");
    await evaluate("[...document.querySelectorAll('.update-actions button')].find(b=>b.textContent==='检查更新').click()");
    await waitFor("window.__updateTest.calls().length===1");
    assert.equal(await evaluate('window.__updateTest.calls()[0]'), 'github');
    await evaluate("document.querySelector('.update-diagnostics summary').click()");
    await evaluate("new Promise(resolve=>setTimeout(resolve,1200))");
    const output = path.resolve(__dirname, '../artifacts/update-ui'); fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'light.png'), (await win.webContents.capturePage()).toPNG());
    await evaluate("window.__updateTest.publish({state:'verifying',progress:99,activeChannel:'github'})");
    await waitFor("document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')==='99'");
    assert.equal(await evaluate("document.querySelector('.update-channel-picker button').disabled"), true);
    assert.equal(await evaluate("[...document.querySelectorAll('.update-actions button')].every(b=>b.disabled)"), true);
    await evaluate("window.__updateTest.publish({state:'ready',progress:100}); document.documentElement.classList.add('dark'); document.querySelector('.app').classList.add('dark')");
    await waitFor("!document.querySelectorAll('.update-actions button')[1].disabled");
    await evaluate("new Promise(resolve=>setTimeout(resolve,300))");
    fs.writeFileSync(path.join(output, 'dark.png'), (await win.webContents.capturePage()).toPNG());
    assert.equal(await evaluate("parseFloat(getComputedStyle(document.querySelector('.update-diagnostics textarea')).borderRadius)>0"), true);
    assert.doesNotMatch(await evaluate("document.querySelector('.about-panel').textContent"), /每次检查更新都会/);
    win.setSize(900, 1200);
    await evaluate("new Promise(resolve=>setTimeout(resolve,400))");
    await evaluate("document.querySelector('.update-channel-picker button').click()");
    await waitFor("!!document.querySelector('[role=menu]')");
    assert.equal(await evaluate("(()=>{const r=document.querySelector('[role=menu]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()"), true);
    fs.writeFileSync(path.join(output, 'portrait-menu.png'), (await win.webContents.capturePage()).toPNG());
    await evaluate("document.querySelector('[role=menu]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await waitFor("!document.querySelector('[role=menu]')");
    await evaluate("document.querySelector('.update-channel-picker button').click()");
    await waitFor("!!document.querySelector('[data-source=ghproxy]')");
    await evaluate("document.querySelector('[data-source=ghproxy]').click()");
    await waitFor("document.querySelector('.update-channel-picker button').textContent.includes('GH-Proxy')&&!document.querySelector('.update-channel-picker button').disabled");
    assert.equal(await evaluate("window.ogk.getUpdateStatus().then(value=>value.source)"), 'ghproxy');
    for (const page of ['option-packages', 'mods']) {
      await evaluate(`document.querySelector('[data-nav-page="${page}"]').click()`);
      const action = page === 'mods' ? '刷新' : '检查更新';
      await waitFor(`!document.querySelector('.about-panel') && !![...document.querySelectorAll('button')].find(b=>b.textContent.includes('${action}')&&!b.disabled)`);
      await evaluate(`window.ogk.packageManifest=async()=>{throw new Error('GitHub test connection failed')}; [...document.querySelectorAll('button')].find(b=>b.textContent.includes('${action}')).click()`);
      await waitFor("!![...document.querySelectorAll('button')].find(b=>b.textContent==='前往设置')");
      await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='前往设置').click()");
      await waitFor("document.querySelectorAll('.update-channel-picker').length===1");
      assert.match(await evaluate("document.querySelector('.update-channel-picker button').textContent"), /GH-Proxy/);
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('Update UI passed: channel status, keyboard selection/focus, manual route IPC, diagnostics, progress/install states, GH-Proxy selection, Option/Mod failure navigation; screenshots:', output);
    win.destroy(); clearTimeout(deadline); app.exit(0);
  })().catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
