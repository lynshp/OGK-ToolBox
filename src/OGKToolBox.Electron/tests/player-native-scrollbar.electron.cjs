const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../../../artifacts/player-native-scrollbar-review');
if (!process.versions.electron) {
  const env = { ...process.env, OGK_RATING_UI_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', path.join(output, `profile-${Date.now()}`));
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu');
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: {
      preload: path.join(__dirname, 'player-saves.preload.cjs'), contextIsolation: false, sandbox: false, offscreen: true, backgroundThrottling: false
    } });
    const label = (process.env.OGK_NATIVE_DRAG_LABEL || 'current').replace(/[^a-z0-9-]/gi, '_');
    const report = { label, environment: { electron: process.versions.electron, chromium: process.versions.chrome,
      renderer: 'offscreen software, anonymous 110-card bridge, network blocked except optional local Vite' }, samples: [], rendererErrors: [] };
    win.webContents.on('console-message', detail => { if (detail.level === 'error' && !detail.message.includes('frame-ancestors') && !detail.message.includes('ERR_INVALID_URL')) report.rendererErrors.push(detail.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (event, done) => done({ cancel: !/^http:\/\/127\.0\.0\.1:5173\//.test(event.url) }));
    const ev = code => win.webContents.executeJavaScript(code, true);
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const wait = async condition => { const deadline = Date.now() + 12000; while (Date.now() < deadline) {
      if (await ev(`Boolean(${condition})`)) return; await pause(40);
    } throw new Error(`Timeout: ${condition}`); };
    const snapshot = async name => {
      for (let attempt=0;attempt<3;attempt++) { await pause(100); const png=(await win.webContents.capturePage()).toPNG();
        if(png.length>8){fs.writeFileSync(path.join(output,`${label}-${name}.png`),png);return;} }
      throw new Error('Empty Electron capture');
    };
    const sample = async note => {
      const state = await ev(`(()=>{const list=document.querySelector('.player-best-scroll'),r=list.getBoundingClientRect();
        return {top:list.scrollTop,height:list.clientHeight,scrollHeight:list.scrollHeight,x:r.x,y:r.y,width:r.width,
          focus:Number(document.querySelector('.player-save-results').style.getPropertyValue('--player-focus')),
          offset:Number.parseFloat(document.querySelector('.player-best-content').style.getPropertyValue('--player-reveal-offset')),
          playerInert:document.querySelector('.player-direct-collapse').inert,playerHeight:document.querySelector('.player-direct-collapse').getBoundingClientRect().height};})()`);
      report.samples.push({ note, ...state }); return state;
    };
    const drag = async (direction, name = direction) => {
      const start = await sample(`${name}-before`);
      const coords = await ev(`(()=>{const list=document.querySelector('.player-best-scroll'),r=list.getBoundingClientRect();
        const track=list.clientHeight-36, thumb=Math.max(18,track*list.clientHeight/list.scrollHeight);
        return {x:Math.floor(r.right-5),y:Math.floor(r.top+18+(track-thumb)*list.scrollTop/(list.scrollHeight-list.clientHeight)+thumb/2)};})()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', ...coords }); await pause(60);
      win.webContents.sendInputEvent({ type: 'mouseDown', ...coords, button: 'left', clickCount: 1 }); await pause(60);
      await sample(`${name}-held`);
      let currentY = coords.y;
      for (let index = 1; index <= 48; index++) {
        currentY = direction === 'down' ? coords.y + index * 2 : Math.round(coords.y + (start.y + 19 - coords.y) * index / 48);
        currentY = Math.max(Math.ceil(start.y + 19), currentY);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: coords.x, y: currentY, button: 'left' });
        await pause(35); await sample(`${name}-${index}`);
      }
      await ev(`window.__nativeSettle=[];{const until=performance.now()+330;const observe=now=>{const list=document.querySelector('.player-best-scroll'),r=list.getBoundingClientRect();
        window.__nativeSettle.push({now,top:list.scrollTop,y:r.y,right:r.right,height:r.height,focus:Number(document.querySelector('.player-save-results').style.getPropertyValue('--player-focus')),
          offset:Number.parseFloat(document.querySelector('.player-best-content').style.getPropertyValue('--player-reveal-offset'))});if(now<until)requestAnimationFrame(observe);};requestAnimationFrame(observe);}`);
      win.webContents.sendInputEvent({ type: 'mouseUp', x: coords.x, y: currentY, button: 'left', clickCount: 1 });
      await pause(360);
      report.settlements ??= []; report.settlements.push({ name, frames: await ev('window.__nativeSettle') });
      return sample(`${name}-released`);
    };
    const checkDrag = (name, direction, reduced = false) => {
      const points = report.samples.filter(item => new RegExp(`^${name}-\\d+$`).test(item.note));
      const geometry = { right: points.map(item => item.x+item.width), y: points.map(item => item.y), height: points.map(item=>item.height), scrollHeight: points.map(item=>item.scrollHeight) };
      for (const [property, values] of Object.entries(geometry)) assert.ok(Math.max(...values)-Math.min(...values)<1, `${name}: held native ${property} must stay stable`);
      assert.ok(points.slice(1).every((point,index)=>direction==='down'?point.top>=points[index].top-2:point.top<=points[index].top+2), `${name}: scrolling follows the pointer without reversing`);
      const frames = report.settlements.find(item=>item.name===name).frames;
      assert.ok(frames.slice(1).every((frame,index)=>direction==='down'?frame.focus>=frames[index].focus-.001:frame.focus<=frames[index].focus+.001), `${name}: release does not alternate reveal direction`);
      if (direction==='down' && !reduced && frames.length>8) assert.ok(frames.filter(frame=>frame.focus>0&&frame.focus<1).length>2, `${name}: release expands over several frames`);
    };
    const home = async () => {
      await ev(`document.querySelector('.player-best-scroll').focus()`);
      win.webContents.sendInputEvent({ type:'keyDown', keyCode:'Home' }); win.webContents.sendInputEvent({ type:'keyUp', keyCode:'Home' });
      await wait(`document.querySelector('.player-best-scroll').scrollTop===0&&Number(document.querySelector('.player-save-results').style.getPropertyValue('--player-focus'))===0`);
    };
    const wheel = async amount => {
      const coords = await ev(`(()=>{const r=document.querySelector('.player-best-scroll').getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
      win.webContents.sendInputEvent({ type:'mouseMove', ...coords }); await pause(25);
      win.webContents.sendInputEvent({ type:'mouseWheel', ...coords, deltaX:0, deltaY:-amount, canScroll:true }); await pause(150);
    };
    try {
      if (process.env.OGK_NATIVE_DRAG_DEV_URL) await win.loadURL(process.env.OGK_NATIVE_DRAG_DEV_URL);
      else await win.loadFile(path.resolve(__dirname, '../dist/index.html'));
      win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      await wait(`document.querySelector('[data-nav-page="player-saves"]')`);
      await ev(`document.querySelector('[data-nav-page="player-saves"]').click()`);
      await wait(`document.querySelector('[data-player-data-intro-dismiss]')`);await ev(`document.querySelector('[data-player-data-intro-dismiss]').click()`);await wait(`!document.querySelector('[data-player-data-intro]')`);
      await wait(`document.querySelectorAll('.player-best-list>li').length===110`); await pause(250);
      await ev(`window.__nativeDragEvents=[];for(const type of ['pointerdown','pointerup','pointermove','mousedown','mouseup','mousemove'])
        document.addEventListener(type,event=>window.__nativeDragEvents.push({type,buttons:event.buttons,x:event.clientX,y:event.clientY,target:event.target.className}),true);`);
      const after = await drag('down');
      report.pointerEvents = await ev(`window.__nativeDragEvents`);
      const forward = report.samples.filter(item => /^down-\d+$/.test(item.note));
      report.down = { minimumDelta: Math.min(...forward.slice(1).map((item, index) => item.top-forward[index].top)),
        advances: forward.filter(item => item.top > 0).length, finalTop: after.top, finalFocus: after.focus,
        xRange: Math.max(...forward.map(item=>item.x+item.width))-Math.min(...forward.map(item=>item.x+item.width)),
        yRange: Math.max(...forward.map(item=>item.y))-Math.min(...forward.map(item=>item.y)) };
      if (process.env.OGK_NATIVE_DRAG_BASELINE !== '1') {
        assert.ok(after.top > 300, 'continuous held thumb must advance the list from its default state');
        assert.ok(report.down.minimumDelta >= -2, 'moving the held thumb down must not repeatedly reset native scrolling');
        assert.equal(after.focus, 1); assert.equal(after.playerInert, true); assert.ok(after.playerHeight < 1);
        checkDrag('down','down');
        await snapshot('landscape-focused');
        const restored = await drag('up'); checkDrag('up','up');
        assert.equal(restored.top,0); assert.equal(restored.focus,0); assert.equal(restored.playerInert,false);

        // Ordinary content clicks and touch pointers must not acquire the native-gutter lock.
        const content = await ev(`(()=>{const r=document.querySelector('.player-best-scroll').getBoundingClientRect();return{x:Math.round(r.left+40),y:Math.round(r.top+65)};})()`);
        win.webContents.sendInputEvent({type:'mouseDown',...content,button:'left',clickCount:1});
        win.webContents.sendInputEvent({type:'mouseUp',...content,button:'left',clickCount:1});
        // A synthetic outstanding pointer lets real wheel input isolate the gutter
        // hit test without Chromium's native text-selection drag consuming that wheel.
        await ev(`document.querySelector('.player-best-scroll').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',pointerId:77,button:0,clientX:${content.x},clientY:${content.y}}))`);
        await wheel(75);
        assert.ok((await sample('content-pointer-wheel')).focus>0);
        await ev(`document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'mouse',pointerId:77}))`); await home();
        await ev(`(()=>{const list=document.querySelector('.player-best-scroll'),r=list.getBoundingClientRect();list.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'touch',pointerId:99,button:0,clientX:r.right-5,clientY:r.top+30}));})()`);
        await wheel(75); assert.ok((await sample('touch-pointer-wheel')).focus>0);
        await ev(`document.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerType:'touch',pointerId:99}))`); await home();

        const track = await ev(`(()=>{const r=document.querySelector('.player-best-scroll').getBoundingClientRect();return{x:Math.floor(r.right-5),y:Math.floor(r.top+r.height*.7)};})()`);
        win.webContents.sendInputEvent({type:'mouseMove',...track}); await pause(50);
        win.webContents.sendInputEvent({type:'mouseDown',...track,button:'left',clickCount:1}); await pause(90);
        win.webContents.sendInputEvent({type:'mouseUp',...track,button:'left',clickCount:1}); await pause(300);
        const clicked = await sample('track-click'); assert.ok(clicked.top>0&&clicked.focus>0); await home();

        win.setSize(720,900); await pause(300);
        const portrait = await drag('down','portrait-down'); checkDrag('portrait-down','down');
        assert.ok(portrait.top>300); assert.equal(portrait.focus,1); assert.equal(portrait.playerInert,true);
        await snapshot('portrait-focused');
        const portraitRestored = await drag('up','portrait-up'); checkDrag('portrait-up','up');
        assert.equal(portraitRestored.top,0); assert.equal(portraitRestored.focus,0);
        await wheel(75); const partial=await sample('portrait-wheel'); assert.ok(partial.focus>0&&partial.focus<1);
        await wheel(250); await wait(`Number(document.querySelector('.player-save-results').style.getPropertyValue('--player-focus'))===1`);
        await home();

        win.setSize(1440,900); await pause(250);
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
        const reduced=await drag('down','reduced-down');
        checkDrag('reduced-down','down',true); assert.ok(reduced.top>300); assert.equal(reduced.focus,1); await home();
        assert.deepEqual(report.rendererErrors, []);
      }
      report.settlementSummary = report.settlements.map(({name,frames})=>({name,frames:frames.length,
        intermediateFrames:frames.filter(frame=>frame.focus>0&&frame.focus<1).length,
        maxFocusChange:Math.max(...frames.slice(1).map((frame,index)=>Math.abs(frame.focus-frames[index].focus))),
        maxOffsetChange:Math.max(...frames.slice(1).map((frame,index)=>Math.abs(frame.offset-frames[index].offset))),
        finalFocus:frames.at(-1).focus}));
      report.status = 'passed'; fs.writeFileSync(path.join(output, `${label}.json`), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ label, down: report.down, rendererErrors: report.rendererErrors, nativePointerEvents: report.pointerEvents.filter(item=>item.type.endsWith('down')||item.type.endsWith('up')) }, null, 2));
      win.destroy(); app.exit(0);
    } catch (error) {
      report.status = 'failed'; report.error = String(error); report.stack = error.stack;
      fs.writeFileSync(path.join(output, `${label}.json`), JSON.stringify(report, null, 2));
      console.error(error); win.destroy(); app.exit(1);
    }
  }).catch(error => { console.error(error); app.exit(1); });
}
