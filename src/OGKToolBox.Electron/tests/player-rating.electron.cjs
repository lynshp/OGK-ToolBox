const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../../../artifacts/player-save-review');
if (!process.versions.electron) {
  const env = { ...process.env, OGK_RATING_UI_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1; }); child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', path.join(output, `rating-profile-${Date.now()}`));
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu');
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { preload: path.join(__dirname, 'player-saves.preload.cjs'), contextIsolation: false, sandbox: false, offscreen: true } });
    const errors = [];
    win.webContents.on('console-message', detail => { if (detail.level === 'error' && !detail.message.includes('frame-ancestors')) errors.push(detail.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*'] }, (_event, done) => done({ cancel: true }));
    const run = code => win.webContents.executeJavaScript(code, true);
    const wait = async condition => { const end = Date.now() + 9000; while (Date.now() < end) { if (await run(`Boolean(${condition})`)) return; await new Promise(resolve => setTimeout(resolve, 40)); } throw new Error(`Timeout: ${condition}`); };
    const press = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const snap = async name => { await new Promise(resolve=>setTimeout(resolve,400));fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG()); };
    const overflow = async () => { await new Promise(resolve=>setTimeout(resolve,400));assert.equal(await run(`(()=>{const workspace=document.querySelector('.workspace'),scroller=document.querySelector('.player-best-scroll');return workspace.scrollHeight<=workspace.clientHeight+1&&workspace.scrollWidth<=workspace.clientWidth+1&&scroller.scrollWidth<=scroller.clientWidth+1&&scroller.scrollHeight>scroller.clientHeight;})()`),true); };
    try {
      await win.loadFile(path.resolve(__dirname,'../dist/index.html'));
      await wait(`document.querySelector('[data-nav-page="player-saves"]')`);await press('[data-nav-page="player-saves"]');
      await wait(`document.querySelector('[data-player-data-intro-dismiss]')`);await press('[data-player-data-intro-dismiss]');await wait(`!document.querySelector('[data-player-data-intro]')`);
      await wait(`document.querySelectorAll('.player-best-list>li').length===110`);
      assert.deepEqual(await run(`Array.from(document.querySelectorAll('.player-best-list')).map(list=>list.children.length)`),[50,10,50]);
      assert.equal(await run(`document.querySelector('.player-current-rating b').textContent`),'16.875');
      assert.equal(await run(`document.querySelectorAll('.player-best-incomplete').length`),0);
      assert.equal(await run(`(()=>{const cards=Array.from(document.querySelectorAll('.player-best-list>li'));return cards.every(c=>getComputedStyle(c).borderTopWidth==='1px'&&c.querySelector('.player-best-artwork')&&c.querySelector('.player-best-score')&&c.querySelector('.player-best-contribution'))&&getComputedStyle(document.querySelector('.player-best-list')).display==='grid';})()`),true);
      await overflow();await snap('best110-full-light');
      const listHeight = await run(`document.querySelector('.player-best-scroll').clientHeight`);
      await run(`document.querySelector('.player-best-scroll').scrollTop=1e6`);await snap('best110-platinum');
      assert.equal(await run(`document.querySelector('.player-summary-collapse').inert`),true);
      assert.equal(await run(`Number(getComputedStyle(document.querySelector('.player-save-results')).getPropertyValue('--player-focus'))`),1);
      assert.ok(await run(`document.querySelector('.player-best-scroll').clientHeight`)>listHeight);
      await press('[data-record-tab="recent"]');await wait(`document.querySelectorAll('.player-recent li').length===10`);
      assert.equal(await run(`document.querySelector('.player-recent-grid').scrollHeight<=document.querySelector('.player-recent-grid').clientHeight+1`),true);
      await press('[data-nav-page="settings"]');await wait(`document.querySelector('.theme-choice')`);await run(`Array.from(document.querySelectorAll('.theme-choice')).find(b=>b.textContent==='深色').click()`);await press('[data-nav-page="player-saves"]');await wait(`document.querySelector('.player-best-scroll')`);
      await overflow();await snap('best110-full-dark');
      win.setSize(720,900);await overflow();await snap('best110-narrow');
      win.setSize(540,1100);await overflow();await snap('best110-small');
      await run(`window.__playerSaveTest.ratingMissing()`);await wait(`document.querySelector('.player-current-rating b').textContent==='—'`);assert.equal(await run(`document.querySelectorAll('.player-best-incomplete').length`),3);
      assert.deepEqual(errors,[]);console.log('BEST 110 UI passed: 50/10/50, rating, tabs, scroll, dark/narrow and missing data.');
    } catch(error) { console.error(error);process.exitCode=1;await snap('best110-failure'); }
    finally { win.destroy();app.exit(process.exitCode??0); }
  });
}
