const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../../../artifacts/option-download-review');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', path.join(output, `profile-${Date.now()}`));
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu');
  app.whenReady().then(async () => {
    const report = { environment: { electron: process.versions.electron, chromium: process.versions.chrome, renderer: 'offscreen software, anonymous in-memory bridge, network blocked' },
      assets: fs.readFileSync(path.resolve(__dirname, '../dist/index.html'), 'utf8').match(/index-[A-Za-z0-9_-]+\.(?:js|css)/g), checks: [] };
    const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { preload: path.join(__dirname, 'option-download-state.preload.cjs'), contextIsolation: false, sandbox: false, offscreen: true, backgroundThrottling: false } });
    const errors = [];
    win.webContents.on('console-message', detail => { if (detail.level === 'error' && !detail.message.includes('frame-ancestors')) errors.push(detail.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_event, done) => done({ cancel: true }));
    const ev = value => win.webContents.executeJavaScript(value, true);
    const pause = () => new Promise(resolve => setTimeout(resolve, 100));
    const wait = async condition => { const deadline = Date.now() + 10000; while (Date.now() < deadline) { if (await ev(`Boolean(${condition})`)) return; await new Promise(resolve => setTimeout(resolve, 40)); } throw new Error(`Timeout: ${condition}; ${await ev('document.body.textContent')}`); };
    const press = selector => ev(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(!button||button.disabled)throw new Error('Unavailable control: '+${JSON.stringify(selector)});button.click();})()`);
    const navigate = async page => { await press(`[data-nav-page="${page}"]`); await wait(page === 'option-packages' ? `document.querySelector('.option-packages-page')` : `!document.querySelector('.option-packages-page')`); };
    const rowExpr = id => `Array.from(document.querySelectorAll('.option-package-row')).find(row=>row.querySelector('.option-package-copy>b')?.textContent===${JSON.stringify(id)})`;
    const statusExpr = id => `${rowExpr(id)}?.querySelector('.option-status')?.textContent`;
    const waitInstalled = id => wait(`${statusExpr(id)}==='已加载'`);
    const select = id => ev(`${rowExpr(id)}.click()`);
    const start = async id => { await press(`[aria-label="下载 ${id}"]`); return ev(`window.__optionStateTest.state().jobs.at(-1).sequence`); };
    const finish = (id, phase = 'completed') => ev(`window.__optionStateTest.finish(${id},${JSON.stringify(phase)})`);
    const refresh = () => ev(`Array.from(document.querySelectorAll('.option-page-actions button')).find(button=>button.textContent.endsWith('刷新')).click()`);
    const snapshot = async name => {
      for (let attempt = 0; attempt < 3; attempt++) { await pause(); const png = (await win.webContents.capturePage()).toPNG(); if (png.length > 8) { fs.writeFileSync(path.join(output, `${name}.png`), png); return; } }
      throw new Error('Empty Electron capture');
    };
    try {
      await win.loadFile(path.resolve(__dirname, '../dist/index.html'));
      await wait(`document.querySelector('.app.boot-ready')`);
      await navigate('option-packages'); await wait(`${statusExpr('A002')}==='未下载'`);
      await select('A002'); const single = await start('A002'); await finish(single); await waitInstalled('A002');
      assert.equal(await ev(`document.querySelector('.option-inspector-heading h2').textContent`), 'A002');
      assert.match(await ev(`document.querySelector('.option-package-inspector').textContent`), /目录路径.*option\\A002/);
      report.checks.push('single completion updates row, counts and selected local inspector');
      await ev('window.__optionStateTest.releaseRead(0)'); await pause();
      await ev('window.__optionStateTest.hold(true)'); await navigate('home'); await navigate('option-packages');
      await waitInstalled('A002');
      report.checks.push('late boot inspection cannot overwrite shared cache; returning shows installed state before held revalidation resolves');
      await ev('window.__optionStateTest.hold(false);window.__optionStateTest.releaseAll()'); await pause();

      await select('A003'); const concurrent = await start('A003');
      await ev('window.__optionStateTest.hold(true)'); await refresh();
      const oldRead = await ev('window.__optionStateTest.state().reads.at(-1).index');
      await ev('window.__optionStateTest.hold(false)'); await finish(concurrent); await waitInstalled('A003');
      await ev(`window.__optionStateTest.releaseRead(${oldRead})`); await pause(); await waitInstalled('A003');
      assert.equal(await ev(`document.querySelector('.option-inspector-heading h2').textContent`), 'A003');
      report.checks.push('late pre-install refresh cannot revert a newer completion');

      await ev('window.__optionStateTest.reset()'); await refresh(); await wait(`${statusExpr('A002')}==='未下载'`);
      await select('A002'); await press('.option-batch-download');
      const batch = await ev('window.__optionStateTest.state().jobs.filter(job=>!job.settled).map(job=>({sequence:job.sequence,id:job.request.id}))');
      assert.equal(batch.length, 2);
      await finish(batch.find(job => job.id === 'A002').sequence); await waitInstalled('A002');
      assert.equal(await ev('document.querySelector(".option-batch-download").disabled'), true);
      assert.equal(await ev(`${rowExpr('A003')}?.querySelector('.option-row-download')?.textContent.includes('准备下载')`), true);
      assert.equal(await ev('document.querySelector(".option-inspector-heading h2").textContent'), 'A002');
      await snapshot('batch-first-completed');
      await finish(batch.find(job => job.id === 'A003').sequence); await waitInstalled('A003');
      await wait('!document.querySelector(".option-batch-download").disabled');
      report.checks.push('first batch completion updates directory and selection while second job continues; final batch clears busy state');

      await ev('window.__optionStateTest.reset()'); await refresh(); await wait(`${statusExpr('A002')}==='未下载'`);
      const away = await start('A002'); await navigate('home'); await finish(away); await pause();
      await ev('window.__optionStateTest.hold(true)'); await navigate('option-packages'); await waitInstalled('A002');
      report.checks.push('completion while page is unmounted updates the root cache before returning with revalidation held');
      await ev('window.__optionStateTest.hold(false);window.__optionStateTest.releaseAll()'); await pause();

      await ev('window.__optionStateTest.reset()'); await refresh(); await wait(`${statusExpr('A002')}==='未下载'`);
      const failed = await start('A002'); await finish(failed, 'error');
      await wait(`${rowExpr('A002')}?.querySelector('[role=alert]')?.textContent.includes('checksum rejected')`);
      assert.equal(await ev(statusExpr('A002')), '未下载');
      const cancelled = await start('A002');
      await ev(`Array.from(${rowExpr('A002')}.querySelectorAll('button')).find(button=>button.textContent==='取消').click()`);
      await wait(`!${rowExpr('A002')}?.querySelector('.option-row-download')`);
      assert.equal(await ev(statusExpr('A002')), '未下载');
      assert.equal(await ev('window.__optionStateTest.state().jobs.find(job=>job.sequence===' + cancelled + ').settled'), true);
      report.checks.push('failed validation and cancellation remain missing and retryable');

      const oldJob = await start('A002'); await ev('window.__optionStateTest.hold(true)'); await refresh();
      const rootRead = await ev('window.__optionStateTest.state().reads.at(-1).index');
      await ev('window.__optionStateTest.selectRoot(1)');
      await ev('Array.from(document.querySelectorAll(".header-actions button")).find(button=>button.textContent.includes("选择目录")).click()');
      await wait('!document.querySelector(".option-packages-page")'); await navigate('option-packages');
      assert.doesNotMatch(await ev('document.querySelector(".option-packages-page").textContent'), /anonymous-options-a/);
      assert.equal(await ev('document.querySelectorAll(".option-package-row").length'), 0, 'new root must not borrow the previous root cache while its own reads are held');
      await ev('window.__optionStateTest.hold(false);window.__optionStateTest.releaseRoot(window.__optionStateTest.roots[1])');
      await wait(`document.querySelector('.option-directory-summary code')?.textContent.includes('anonymous-options-b')`);
      await finish(oldJob); await ev(`window.__optionStateTest.releaseRead(${rootRead})`); await pause();
      assert.equal(await ev(statusExpr('A002')), '未下载');
      assert.doesNotMatch(await ev('document.querySelector(".option-packages-page").textContent'), /anonymous-options-a/);
      report.checks.push('old-root download completion and directory result cannot contaminate newly selected root');

      await ev('window.__optionStateTest.duplicate()'); await refresh();
      await wait(`document.querySelectorAll('.option-package-row').length===4`);
      await ev('Array.from(document.querySelectorAll(".option-package-row")).find(row=>row.textContent.includes("27 个文件")).click()');
      assert.match(await ev('document.querySelector(".option-package-inspector").textContent'), /GameData\\A001/);
      await snapshot('final-option-state');
      report.checks.push('duplicate Option/GameData IDs retain independent path selection');
      assert.deepEqual(errors, []);
      report.status = 'passed'; report.rendererErrors = errors; report.fixture = await ev('window.__optionStateTest.state()');
      fs.writeFileSync(path.join(output, 'electron-results.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(0);
    } catch (error) {
      report.status = 'failed'; report.error = String(error); report.stack = error.stack; report.consoleErrors = errors;
      fs.writeFileSync(path.join(output, 'electron-results.json'), JSON.stringify(report, null, 2));
      console.error(error); win.destroy(); app.exit(1);
    }
  }).catch(error => { console.error(error); app.exit(1); });
}
