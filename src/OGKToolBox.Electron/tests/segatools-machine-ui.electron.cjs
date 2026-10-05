const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../../../artifacts/machine-spines-review');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1; }); child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, `profile-${Date.now()}`));
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu');
  app.whenReady().then(async () => {
    const url = process.env.OGK_MACHINE_UI_URL;
    const report = { environment: { electron: process.versions.electron, chromium: process.versions.chrome, source: url || 'production dist', renderer: 'isolated offscreen software, anonymous in-memory bridge' }, assets: url ? undefined : fs.readFileSync(path.resolve(__dirname, '../dist/index.html'), 'utf8').match(/index-[A-Za-z0-9_-]+\.(?:js|css)/g), checks: [] };
    const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { preload: path.join(__dirname, 'segatools-machine-ui.preload.cjs'), contextIsolation: false, sandbox: false, offscreen: true, backgroundThrottling: false } });
    const errors = [];
    win.webContents.on('console-message', detail => { if (detail.level === 'error' && !detail.message.includes('frame-ancestors')) errors.push(detail.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (event, done) => done({ cancel: !url || !event.url.startsWith(new URL(url).origin) }));
    const ev = expression => win.webContents.executeJavaScript(expression, true);
    const pause = (ms = 70) => new Promise(resolve => setTimeout(resolve, ms));
    const key = async keyCode => { win.webContents.focus(); win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); if (keyCode === 'Enter' || keyCode === 'Space') win.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : ' ' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await pause(); };
    const wait = async expression => { const deadline = Date.now() + 10000; while (Date.now() < deadline) { if (await ev(`Boolean(${expression})`)) return; await pause(30); } throw new Error(`Timeout ${expression}: ${await ev('document.body.textContent')}`); };
    const press = async selector => {
      await ev(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element||element.disabled)throw new Error('Unavailable: '+${JSON.stringify(selector)});if(!element.closest('[role=menu]'))element.scrollIntoView({block:'nearest'});})()`); await pause(30);
      await ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
    };
    const nav = async page => { await press(`[data-nav-page="${page}"]`); await wait(`document.querySelector(${JSON.stringify(page === 'sega' ? '.sega-page' : page === 'home' ? '.home-page' : '.player-saves-page')})`); };
    const input = async (selector, value, commitOnBlur = true) => {
      await ev(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await pause(); if (commitOnBlur) await ev(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});let delivered=false;const mark=()=>{delivered=true};input.addEventListener('focusout',mark,{once:true});input.blur();if(!delivered)input.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));input.removeEventListener('focusout',mark)})()`); await pause();
    };
    const activeEditor = '.machine-editor[data-machine-panel]';
    const chooseServer = async host => { await press(`${activeEditor} [data-machine-field-group="server"] .server-picker .filter-trigger`); await wait('document.querySelector(".server-menu")'); await ev(`Array.from(document.querySelectorAll('.server-menu button')).find(button=>button.textContent===${JSON.stringify(host)}).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`); await wait('!document.querySelector(".machine-operation")'); await pause(); };
    const settlePanel = () => pause(230);
    const geometry = () => ev(`(()=>{const measure=element=>{if(!element)return null;const rect=element.getBoundingClientRect();return {width:rect.width,height:rect.height,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom}},list=document.querySelector('.machine-list'),editor=document.querySelector('${activeEditor}');return {cards:Array.from(list.querySelectorAll('[data-machine-card]')).map(card=>{const name=card.querySelector('.machine-spine-name'),summary=card.querySelector('.machine-card-summary');return {...measure(card),id:card.dataset.machineCard,expanded:card.classList.contains('is-expanded'),spine:card.classList.contains('is-spine'),name:measure(name),caret:measure(card.querySelector('.machine-card-caret')),writingMode:name?getComputedStyle(name).writingMode:null,summary:measure(summary),summaryHidden:!summary||summary.getBoundingClientRect().height<=1||getComputedStyle(summary).display==='none'}}),list:{...measure(list),scrollLeft:list.scrollLeft,scrollWidth:list.scrollWidth,clientWidth:list.clientWidth,overflowX:getComputedStyle(list).overflowX,flexWrap:getComputedStyle(list).flexWrap},panel:editor?{...measure(editor),id:editor.dataset.machinePanel,scrollWidth:editor.scrollWidth,clientWidth:editor.clientWidth}:null,title:measure(editor?.querySelector('.machine-editor-title'))}})()`);
    const equalRow = cards => cards.forEach(card => { assert.ok(Math.abs(card.top - cards[0].top) <= 1, 'expanded cards remain in one row'); assert.ok(Math.abs(card.height - cards[0].height) <= 1, 'spines match the full expanded card height'); });
    const validateSpines = cards => cards.filter(card => card.spine).forEach(card => {
      assert.ok(card.width >= 52 && card.width <= 64, `narrow spine width ${card.width}`);
      assert.equal(card.summaryHidden, true); assert.match(card.writingMode, /^vertical/);
      assert.ok(card.name.height > card.name.width, 'the machine name is written vertically');
      assert.ok(Math.abs((card.name.left + card.name.right) / 2 - (card.left + card.right) / 2) <= 2, 'spine name is horizontally centered');
      assert.ok(Math.abs((card.name.top + card.name.bottom) / 2 - (card.top + card.bottom) / 2) <= 2, 'spine name is vertically centered');
    });
    const singlePanel = async id => {
      assert.equal(await ev(`document.querySelectorAll('${activeEditor}').length`), 1);
      assert.equal(await ev(`document.querySelector('${activeEditor}').dataset.machinePanel`), id);
      assert.equal(await ev(`document.querySelector('${activeEditor}').getAttribute('role')`), 'region');
      assert.equal(await ev(`document.querySelectorAll('.machine-card.is-expanded').length`), 1);
      assert.equal(await ev(`document.querySelector('${activeEditor}').closest('[data-machine-card]').dataset.machineCard`), id);
      assert.equal(await ev(`document.querySelector('[data-machine-id="${id}"]').getAttribute('aria-expanded')`), 'true');
    };
    const collapsed = async () => { assert.equal(await ev(`document.querySelectorAll('${activeEditor},.machine-card.is-expanded,.machine-card.is-spine').length`), 0); assert.equal(await ev('Array.from(document.querySelectorAll("[data-machine-id]")).every(button=>button.getAttribute("aria-expanded")==="false")'), true); };
    const advanced = async () => { if (!await ev(`document.querySelector('${activeEditor} [data-machine-advanced]').open`)) await press(`${activeEditor} [data-machine-advanced-toggle]`); await wait(`document.querySelector('${activeEditor} [data-machine-advanced]').open`); };
    const snapshot = async name => { for (let i = 0; i < 3; i++) { await pause(100); const png = (await win.webContents.capturePage()).toPNG(); if (png.length > 8) { fs.writeFileSync(path.join(output, `${name}.png`), png); return; } } throw new Error('Empty screenshot'); };
    try {
      if (url) await win.loadURL(url); else await win.loadFile(path.resolve(__dirname, '../dist/index.html'));
      await wait('document.querySelector(".app.boot-ready")'); await nav('sega'); await wait('document.querySelectorAll(".machine-list [data-machine-id]").length===2');
      await collapsed();
      assert.equal(await ev('document.querySelectorAll(".sega-page select").length'), 0);
      assert.doesNotMatch(await ev('document.querySelector(".machine-section").textContent'), /A69EANON00000/);
      assert.equal(await ev(`Array.from(document.querySelectorAll('.config-section-title')).filter(title=>['网络与服务器','网络环境','Keychip'].includes(title.textContent)).length`), 0);
      assert.equal(await ev('document.querySelectorAll(".machine-tabs,[role=tablist]").length'), 0);
      assert.doesNotMatch(await ev('Array.from(document.querySelectorAll(".machine-card-summary")).map(summary=>summary.textContent).join(" ")'), /网络|启用|关闭/);
      report.checks.push('machine summaries replace independent groups; all begin collapsed, Keychip stays masked and network status, native selects and top tabs are absent');
      report.spineCounts = [];
      for (const count of [1, 2, 3, 4]) {
        await ev(`window.__machineUi.machineCount(${count})`); await nav('home'); await nav('sega');
        await wait(`document.querySelectorAll('.machine-list [data-machine-id]').length===${count}`); await settlePanel(); await collapsed();
        const initial = await geometry(); report.spineCounts.push({ count, initial });
        assert.equal(initial.list.flexWrap, 'nowrap');
        initial.cards.forEach(card => { assert.ok(Math.abs(card.width - 270) <= 1, `default width with ${count} cards: ${card.width}`); assert.ok(Math.abs(card.top - initial.cards[0].top) <= 1, 'default summaries stay in one scrollable rail'); });
        const last = initial.cards.at(-1).id;
        await snapshot(`spines-default-count-${count}`);
        await press(`[data-machine-id="${last}"]`); await settlePanel(); await singlePanel(last);
        const expanded = await geometry(); equalRow(expanded.cards); validateSpines(expanded.cards);
        assert.ok(expanded.cards.find(card=>card.expanded).width > 270, 'the selected card grows into the available rail');
        assert.ok(expanded.title.height >= 40 && expanded.title.height <= 64, `title stays compact: ${expanded.title.height}`);
        assert.ok(expanded.panel.height <= 560, `common detail stays substantially shorter than the previous 684px row: ${expanded.panel.height}`);
        expanded.cards.forEach((card, index) => assert.ok(Math.abs(card.top - initial.cards[index].top) <= 1, 'expansion keeps the original horizontal rail'));
        assert.equal((await ev('window.__machineUi.state()')).current.activeMachineId, 'machine-0-a');
        assert.equal(await ev(`Array.from(document.querySelectorAll('.machine-card.is-spine')).every(card=>!card.querySelector('em')&&card.textContent.trim()===card.querySelector('.machine-spine-name').textContent.trim())`), true);
        if (last !== 'machine-0-a') {
          const dot = await ev(`(()=>{const button=document.querySelector('[data-machine-id="machine-0-a"]'),dot=button.querySelector('.machine-current-dot'),rect=dot.getBoundingClientRect();return {width:rect.width,height:rect.height,title:dot.title,label:button.getAttribute('aria-label')}})()`);
          assert.equal(dot.width, 6); assert.equal(dot.height, 6); assert.equal(dot.title, '当前机台'); assert.match(dot.label, /当前机台/);
        }
        report.spineCounts.at(-1).expanded = expanded; await snapshot(`spines-common-count-${count}`);
        if (count === 4) {
          report.narrowSpines = []; report.narrowSelections = [];
          for (const width of [720, 420]) {
            win.setSize(width, 1000); await pause(350);
            await ev(`document.querySelector('[data-machine-id="${last}"]').focus()`); await key('Home'); await key('End'); await settlePanel(); await singlePanel(last);
            const layout = await ev(`(()=>{const list=document.querySelector('.machine-list'),card=list.querySelector('.is-expanded'),panel=document.querySelector('${activeEditor}'),scroll=document.querySelector('.config-scroll'),server=panel.querySelector('[data-machine-field-group=server]').getBoundingClientRect(),identity=panel.querySelector('[data-machine-field-group=identity]').getBoundingClientRect(),view=list.getBoundingClientRect(),rect=card.getBoundingClientRect();return {width:innerWidth,viewport:list.clientWidth,scrollWidth:list.scrollWidth,scrollLeft:list.scrollLeft,overflowX:getComputedStyle(list).overflowX,expandedVisible:rect.left>=view.left-1&&rect.right<=view.right+1,expandedWidth:rect.width,outerOverflow:scroll.scrollWidth>scroll.clientWidth+1,panelOverflow:panel.scrollWidth>panel.clientWidth+1,groupStacked:Math.abs(server.left-identity.left)<=1&&identity.top>=server.bottom-1}})()`);
            const narrow = await geometry(); equalRow(narrow.cards); validateSpines(narrow.cards);
            assert.match(layout.overflowX, /auto|scroll/); assert.equal(layout.expandedVisible, true);
            assert.equal(layout.outerOverflow, false); assert.equal(layout.panelOverflow, false); assert.equal(layout.groupStacked, true);
            assert.ok(layout.expandedWidth <= layout.viewport + 1);
            if (width === 420) { assert.ok(layout.scrollWidth > layout.viewport); assert.ok(layout.scrollLeft > 0); }
            for (let index = 0; index < initial.cards.length; index++) {
              const target = initial.cards[index].id;
              await key('Home'); for (let step = 0; step < index; step++) await key('Right');
              await settlePanel(); await singlePanel(target);
              const selectedRow = await geometry(); equalRow(selectedRow.cards); validateSpines(selectedRow.cards);
              assert.deepEqual(selectedRow.cards.map(card=>card.id), initial.cards.map(card=>card.id), 'selection preserves the original card order');
              const selectedCard = selectedRow.cards[index];
              assert.equal(selectedCard.expanded, true);
              assert.ok(selectedCard.left >= selectedRow.list.left - 1 && selectedCard.right <= selectedRow.list.right + 1, `selected ${target} is fully visible at ${width}px`);
              assert.equal(await ev('document.querySelector(".config-scroll").scrollWidth<=document.querySelector(".config-scroll").clientWidth+1'), true);
              report.narrowSelections.push({ width, index, id: target, geometry: selectedRow });
            }
            report.narrowSpines.push({ ...layout, geometry: narrow }); await snapshot(`spines-common-narrow${width}`);
          }
          win.setSize(1440, 900); await pause(350);
        }
        await press(`[data-machine-id="${last}"]`); await settlePanel(); await collapsed();
        const restored = await geometry(); restored.cards.forEach((card, index) => { assert.ok(Math.abs(card.width - 270) <= 1); assert.equal(card.height, initial.cards[index].height); });
      }
      report.checks.push('one through four fixed-width summaries expand in place; peers become 52–64px centered vertical name spines and share the full selected-card height');
      report.checks.push('720px and 420px spines remain on one scrollable rail, reveal the selected card and stack common fields without overflowing the page');
      await ev('window.__machineUi.machineCount(2)'); await nav('home'); await nav('sega'); await wait('document.querySelectorAll(".machine-list [data-machine-id]").length===2'); await settlePanel();
      await pause(450); await snapshot('spines-default');
      await press('[data-machine-id=machine-0-a]'); await settlePanel(); await singlePanel('machine-0-a'); await snapshot('spines-common');
      assert.equal(await ev(`document.querySelector('${activeEditor} .machine-editor-title [aria-label="机台名称"]').maxLength`), 40);
      assert.equal(await ev(`document.querySelector('${activeEditor} [data-machine-advanced]').open`), false);
      const commonLabels = await ev(`Array.from(document.querySelectorAll('${activeEditor} [data-machine-field-group] .config-entry>span>b')).map(label=>label.textContent)`);
      for (const label of ['游戏服务器', '读卡服务器', 'Keychip', 'LAN 子网']) assert.ok(commonLabels.includes(label), `Chinese common label ${label}`);
      assert.equal(commonLabels.length, 4);
      const collapseSize = await ev(`(()=>{const rect=document.querySelector('[data-machine-collapse]').getBoundingClientRect();return {width:rect.width,height:rect.height}})()`);
      assert.ok(collapseSize.width <= 40 && collapseSize.height <= 40, 'a small collapse control fits the white title bar');
      await press('[data-machine-collapse]'); await settlePanel(); await collapsed();
      report.checks.push('the 40-character name lives in a compact white title; a small collapse control returns to summaries and four common fields keep advanced settings closed');

      report.switchFrames = await ev(`new Promise(resolve=>{const frames=[],start=performance.now();document.querySelector('[data-machine-id=machine-0-b]').click();function sample(now){const panel=document.querySelector('${activeEditor}'),card=document.querySelector('[data-machine-card=machine-0-b]');frames.push({time:Math.round(now-start),panelCount:document.querySelectorAll('${activeEditor}').length,id:panel?.dataset.machinePanel,width:card.getBoundingClientRect().width,opacity:panel?Number(getComputedStyle(panel).opacity):0});if(now-start<280)requestAnimationFrame(sample);else resolve(frames)}requestAnimationFrame(sample)})`);
      report.switchFrames.forEach(frame => { assert.equal(frame.panelCount, 1); assert.equal(frame.id, 'machine-0-b'); assert.ok(frame.opacity >= 0 && frame.opacity <= 1); });
      assert.ok(report.switchFrames.at(-1).opacity >= .99);
      report.panelMotion = await ev(`(()=>{const style=getComputedStyle(document.querySelector('${activeEditor}')),cardStyle=getComputedStyle(document.querySelector('.machine-card.is-expanded'));return {animation:style.animationName,duration:style.animationDuration,cardTransition:cardStyle.transitionDuration}})()`);
      assert.ok(report.panelMotion.duration.split(',').some(duration => parseFloat(duration) > 0 && parseFloat(duration) <= .22));
      assert.ok(report.panelMotion.cardTransition.split(',').some(duration => parseFloat(duration) > 0 && parseFloat(duration) <= .22));
      for (const id of ['machine-0-a', 'machine-0-b', 'machine-0-a']) { await ev(`document.querySelector('[data-machine-id=${id}]').click()`); await pause(35); await singlePanel(id); }
      await settlePanel(); await singlePanel('machine-0-a'); const finalRow = await geometry(); equalRow(finalRow.cards); validateSpines(finalRow.cards);
      assert.equal((await ev('window.__machineUi.state()')).current.activeMachineId, 'machine-0-a');
      await press('[data-machine-collapse]'); await settlePanel(); await collapsed();
      report.checks.push('width and content motion stay brief; rapid selection leaves one in-place panel, equal-height spines and no stale inputs, and reselecting the main card restores summaries');

      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await press('[data-machine-id=machine-0-b]'); await settlePanel(); await singlePanel('machine-0-b');
      assert.equal(await ev(`getComputedStyle(document.querySelector('${activeEditor}')).animationDuration.split(',').every(duration=>parseFloat(duration)<=.001)`), true);
      assert.equal(await ev(`getComputedStyle(document.querySelector('.machine-card.is-expanded')).transitionDuration.split(',').every(duration=>parseFloat(duration)<=.001)`), true);
      await press('[data-machine-id=machine-0-b]'); await settlePanel(); await collapsed();
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }); win.webContents.debugger.detach();
      report.checks.push('reduced motion removes width and content animations while expansion and repeated-click collapse still work');

      await ev('document.querySelector("[data-machine-id=machine-0-b]").focus()'); await key('Enter'); await singlePanel('machine-0-b');
      await key('Space'); await settlePanel(); await collapsed(); assert.equal(await ev('document.activeElement.dataset.machineId'), 'machine-0-b');
      for (const [keyCode, id] of [['Left','machine-0-a'], ['Right','machine-0-b'], ['Home','machine-0-a'], ['End','machine-0-b']]) {
        await key(keyCode); await singlePanel(id); assert.equal(await ev('document.activeElement.dataset.machineId'), id);
      }
      await key('Enter'); await settlePanel(); await collapsed(); await key('Enter'); await settlePanel(); await singlePanel('machine-0-b');
      assert.equal((await ev('window.__machineUi.state()')).current.activeMachineId, 'machine-0-a');
      report.checks.push('native Enter and Space toggle expansion; Left, Right, Home and End focus and reveal profiles without activating them');

      await advanced();
      assert.equal(await ev(`document.querySelector('${activeEditor} [role=switch][aria-label="服务器地址替换"]')!==null`), true);
      assert.equal(await ev(`document.querySelector('${activeEditor} [role=switch][aria-label="模拟网络环境"]')!==null`), true);
      assert.equal(await ev(`document.querySelector('${activeEditor} input[aria-label="dns.unknownSetting"]').value`), '保留参数');
      await input(`${activeEditor} input[aria-label="dns.unknownSetting"]`, '已修改的附加参数');
      assert.equal((await ev('window.__machineUi.state()')).current.machines[1].values.dns.unknownSetting, '已修改的附加参数');
      const hintSelector = `${activeEditor} [aria-label="模拟网络环境说明"]`;
      await ev(`document.querySelector(${JSON.stringify(hintSelector)}).scrollIntoView({block:'nearest'})`); await pause(30);
      const hintPoint = await ev(`(()=>{const rect=document.querySelector(${JSON.stringify(hintSelector)}).getBoundingClientRect();return {x:Math.round((rect.left+rect.right)/2),y:Math.round((rect.top+rect.bottom)/2)}})()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', ...hintPoint }); await wait('document.querySelector("[role=tooltip]")');
      assert.match(await ev('document.querySelector("[role=tooltip]").textContent'), /网络|虚拟|模拟/);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 }); await wait('!document.querySelector("[role=tooltip]")');
      // Hidden offscreen windows have no OS focus; emulate page focus so DOM
      // focus generates a real focusin before sending the native Escape key.
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      await ev(`document.querySelector(${JSON.stringify(hintSelector)}).focus()`); await wait('document.querySelector("[role=tooltip]")');
      await key('Escape'); await wait('!document.querySelector("[role=tooltip]")');
      report.tooltipFocus = await ev(`({documentFocus:document.hasFocus(),buttonFocus:document.activeElement===document.querySelector(${JSON.stringify(hintSelector)})})`);
      assert.equal(report.tooltipFocus.buttonFocus, true);
      win.webContents.debugger.detach();
      await snapshot('spines-advanced');
      await press('[data-machine-id=machine-0-a]'); await singlePanel('machine-0-a');
      assert.equal(await ev(`document.querySelector('${activeEditor} [data-machine-advanced]').open`), false);
      await press('[data-machine-id=machine-0-b]'); await singlePanel('machine-0-b');
      assert.equal(await ev(`document.querySelector('${activeEditor} [data-machine-advanced]').open`), false);
      await advanced(); assert.equal(await ev(`document.querySelector('${activeEditor} input[aria-label="dns.unknownSetting"]').value`), '已修改的附加参数');
      report.checks.push('advanced settings expose the Chinese switches, explanatory tooltip and unknown extra fields; edits persist and switching cards resets only the disclosure');
      await chooseServer('play.mumur.net');
      let state = await ev('window.__machineUi.state()');
      assert.equal(state.current.machines[1].values.dns.AimeDB, 'aime.mumur.net'); assert.equal(state.current.machines[0].values.dns.default, 'ea.naominet.live');
      assert.equal(state.operations.at(-1).applied, false);
      await chooseServer('ea.naominet.live'); state = await ev('window.__machineUi.state()'); assert.equal(state.current.machines[1].values.dns.replaceHost, '1'); assert.equal(state.current.machines[1].values.dns.AimeDB, '');
      await chooseServer('nageki-net.com'); state = await ev('window.__machineUi.state()'); assert.equal(state.current.machines[1].values.keychip.id, '');
      await input('.machine-editor[data-machine-panel] [aria-label="机台名称"]', '独立备用机台');
      assert.equal((await ev('window.__machineUi.state()')).current.machines[1].name, '独立备用机台');
      assert.equal(state.current.machines[1].values.dns.unknownSetting, '已修改的附加参数');
      await press('[data-machine-activate]'); await wait('window.__machineUi.state().current.activeMachineId==="machine-0-b"'); await wait('!document.querySelector(".machine-operation")'); await singlePanel('machine-0-b');
      assert.equal((await ev('window.__machineUi.state()')).current.activeMachineId, 'machine-0-b');
      report.checks.push('inactive edits preserve the active machine; server association rules persist independently and explicit activation applies the selected machine');

      await press('[data-machine-add]'); await wait('document.querySelectorAll(".machine-list [data-machine-id]").length===3');
      state = await ev('window.__machineUi.state()'); assert.deepEqual(state.current.machines[2].values, state.current.machines[1].values);
      assert.equal(await ev('document.querySelector("[data-machine-id=new-2]").getAttribute("aria-expanded")'), 'true');
      await singlePanel('new-2'); assert.equal((await ev('window.__machineUi.state()')).current.activeMachineId, 'machine-0-b');
      report.checks.push('adding a machine copies the current values, expands its card and preserves the current machine');

      await press('[data-machine-id="machine-0-b"]'); await advanced(); await press('.machine-editor[data-machine-panel] [role="switch"][aria-label="模拟网络环境"]'); await wait('!document.querySelector(".machine-operation")');
      state = await ev('window.__machineUi.state()'); assert.equal(state.operations.at(-1).applied, true);
      await ev('window.__machineUi.running(true)'); await press('.machine-editor[data-machine-panel] [role="switch"][aria-label="模拟网络环境"]');
      await wait('document.querySelector(".machine-section [role=alert]")?.textContent.includes("游戏正在运行")');
      assert.equal(await ev(`document.querySelector('${activeEditor} [role=switch][aria-label="模拟网络环境"]').disabled`), false);
      assert.equal(await ev(`document.querySelector('${activeEditor} [data-machine-advanced]').open`), true);
      assert.notEqual(await ev(`document.querySelector('${activeEditor} [role=switch][aria-label="模拟网络环境"]').getAttribute('aria-checked')==='true'`), (await ev('window.__machineUi.state()')).current.machines[1].values.netenv.enable === '1');
      assert.equal(await ev(`document.querySelector('${activeEditor} input[aria-label="dns.unknownSetting"]').value`), '已修改的附加参数');
      const rejectedSwitch = await ev(`document.querySelector('${activeEditor} [role=switch][aria-label="模拟网络环境"]').getAttribute('aria-checked')`);
      await press(`${activeEditor} [data-machine-advanced-toggle]`);
      assert.equal(await ev(`document.querySelector('${activeEditor} [data-machine-advanced]').open`), false);
      assert.match(await ev('document.querySelector(".machine-section [role=alert]").textContent'), /游戏正在运行/);
      await advanced();
      assert.equal(await ev(`document.querySelector('${activeEditor} [role=switch][aria-label="模拟网络环境"]').getAttribute('aria-checked')`), rejectedSwitch);
      await ev('window.__machineUi.running(false)'); await press('[data-machine-retry]'); await wait('!document.querySelector(".machine-section [role=alert]")');
      report.checks.push('current edits apply immediately; game-running rejection keeps the advanced disclosure, error and draft with extra fields intact; retry succeeds');
      await snapshot('spines-editor-light');

      await ev('window.__machineUi.running(true)'); await press('.backup-menu>button'); await press('.backup-popover>button'); await press('.confirm-dialog .primary');
      await wait('document.querySelector(".confirm-dialog [role=alert]")?.textContent.includes("游戏正在运行")');
      assert.equal(await ev('document.querySelector(".confirm-dialog .primary").disabled'), false);
      await ev('window.__machineUi.running(false)'); await press('.confirm-dialog .primary'); await wait('!document.querySelector(".confirm-dialog")');
      report.checks.push('backup restoration surfaces a game-running rejection in the confirmation and remains retryable');

      report.virtualTriggerHeights = await ev('Array.from(document.querySelectorAll(".virtual-card-controls>button,.virtual-card-controls .filter-trigger")).map(button=>button.getBoundingClientRect().height)');
      assert.equal(new Set(report.virtualTriggerHeights).size, 1); assert.equal(await ev('document.querySelector("[data-virtual-card-edit]")===null'), true);
      await press('[data-player-picker="虚拟卡号"]'); await wait('document.querySelector(".player-picker-menu")');
      report.virtualMenuActionHeights = await ev('Array.from(document.querySelectorAll(".virtual-card-menu [data-virtual-card-edit],.virtual-card-menu [data-player-add]")).map(button=>button.getBoundingClientRect().height)');
      assert.equal(new Set(report.virtualMenuActionHeights).size, 1);
      await snapshot('aime-card-options');
      await key('End'); await wait('document.activeElement.classList.contains("player-add-option")'); await key('Escape'); await wait('!document.querySelector(".player-picker-menu")');
      assert.equal(await ev('document.activeElement.getAttribute("data-player-picker")'), '虚拟卡号');
      await key('Enter'); await wait('document.querySelector(".player-picker-menu")');
      report.checks.push('native keyboard input navigates the Aime menu and Escape restores trigger focus');
      assert.equal(await ev('Array.from(document.querySelectorAll(".player-picker-menu .filter-options>button")).at(-1).textContent'), '＋ 添加新卡号');
      assert.doesNotMatch(await ev('document.querySelector(".player-picker-menu").textContent'), /01234567890123456789|98765432109876543210/);
      await press('.player-picker-menu [data-option-id="card-b"]'); await wait('document.querySelector("[data-player-picker=虚拟卡号]").textContent.includes("卡号 2")');
      state = await ev('window.__machineUi.state()'); assert.equal(state.current.virtualCard.cardId, 'card-b'); assert.equal(state.current.virtualCard.path, 'DEVICE/aime.txt');
      await press('[data-player-picker="虚拟卡号"]'); await press('.player-picker-menu .player-add-option');
      const count = (await ev('window.__machineUi.state()')).operations.length;
      const codeInput = '.virtual-card-menu [aria-label="20 位卡号"]';
      await wait('document.querySelector(".virtual-card-menu[role=dialog] [data-virtual-card-editor]")');
      await input(codeInput, '12345678901234567890', false); await ev(`document.querySelector('${codeInput}').setSelectionRange(9,9)`);
      await key('Home'); assert.equal(await ev(`document.querySelector('${codeInput}').selectionStart`), 0);
      await key('Right'); assert.equal(await ev(`document.querySelector('${codeInput}').selectionStart`), 1);
      await key('End'); assert.equal(await ev(`document.querySelector('${codeInput}').selectionStart`), 20);
      await key('Left'); assert.equal(await ev(`document.querySelector('${codeInput}').selectionStart`), 19);
      await key('Up'); await key('Down'); assert.equal(await ev('document.activeElement.getAttribute("aria-label")'), '20 位卡号');
      await key('Tab'); assert.equal(await ev('document.activeElement.classList.contains("player-card-eye")'), true);
      await key('Tab'); assert.equal(await ev('document.activeElement.hasAttribute("data-virtual-card-cancel")'), true);
      await key('Tab'); assert.equal(await ev('document.activeElement.hasAttribute("data-virtual-card-save")'), true);
      assert.equal(await ev('document.querySelector(".virtual-card-menu")!==null'), true);
      await input(codeInput, '123', false); await press('[data-virtual-card-save]'); await wait('document.querySelector(".virtual-card-menu [role=alert]")?.textContent.includes("20 位")');
      assert.equal((await ev('window.__machineUi.state()')).operations.length, count);
      assert.equal(await ev('document.querySelector(".virtual-card-editor>label").getBoundingClientRect().height<40'), true);
      await snapshot('aime-card-editor');
      await press('.virtual-card-menu .player-card-eye'); assert.equal(await ev(`document.querySelector('${codeInput}').type`), 'text');
      await key('Escape'); await wait('!document.querySelector(".virtual-card-menu")');
      assert.equal(await ev('document.querySelector(".virtual-card-controls>.player-card-eye").getAttribute("aria-pressed")'), 'false');
      await key('Enter'); await wait('document.querySelector(".virtual-card-menu [data-virtual-card-editor]")');
      assert.equal(await ev(`document.querySelector('${codeInput}').type`), 'password');
      assert.equal(await ev(`document.querySelector('${codeInput}').value`), '123');
      report.checks.push('virtual-card trigger buttons and menu actions have matching heights; editing stays in the menu, cursor keys and Tab work natively and closing resets secret visibility');
      await input(codeInput, '0000 1111 2222 3333 4444', false); await press('[data-virtual-card-save]'); await wait('!document.querySelector(".virtual-card-editor")');
      state = await ev('window.__machineUi.state()'); assert.equal(state.current.cards.length, 3); assert.equal(state.current.virtualCard.accessCode, '00001111222233334444');
      await press('[data-player-picker="虚拟卡号"]'); await press('[data-virtual-card-edit]');
      await input(codeInput, '0000-1111-2222-3333-4444', false); await press('[data-virtual-card-save]'); await wait('!document.querySelector(".virtual-card-editor")');
      assert.equal((await ev('window.__machineUi.state()')).current.cards.length, 3);
      report.checks.push('Aime selects saved masked cards, keeps add last, rejects incomplete input, normalizes 20 digits, persists the path and deduplicates edited codes');

      await ev('window.__machineUi.running(true)'); await press('[data-player-picker="虚拟卡号"]'); await press('.player-picker-menu [data-option-id="card-a"]');
      await wait('document.querySelector(".virtual-aime-card>.virtual-card-error")?.textContent.includes("游戏正在运行")');
      assert.equal((await ev('window.__machineUi.state()')).current.virtualCard.cardId, 'card-2');
      assert.equal(await ev('document.querySelector("[data-player-picker=虚拟卡号]").disabled'), false);
      report.checks.push('virtual-card game-running rejection leaves the selected card intact and controls retryable');

      await press('[data-player-picker="虚拟卡号"]'); await press('[data-virtual-card-edit]'); await input(codeInput, '00001111222233334444', false); await press('[data-virtual-card-save]');
      await wait('document.querySelector(".virtual-card-menu [role=alert]")?.textContent.includes("游戏正在运行")');
      assert.equal(await ev(`document.querySelector('${codeInput}').value`), '00001111222233334444');
      assert.equal(await ev('document.querySelector("[data-virtual-card-save]").disabled'), false);
      await ev('window.__machineUi.running(false)'); await press('[data-virtual-card-save]'); await wait('!document.querySelector(".virtual-card-menu")');
      report.checks.push('an inline card-file rejection keeps the input and dialog retryable; retry refreshes cards and selected value before closing');

      await press('[role=switch][aria-label="虚拟读卡器"]'); await wait('document.querySelector("[data-player-picker=虚拟卡号]").disabled');
      assert.equal(await ev('document.querySelector(".virtual-card-controls>.player-card-eye").disabled'), true);
      await press('[role=switch][aria-label="虚拟读卡器"]'); await wait('!document.querySelector("[data-player-picker=虚拟卡号]").disabled');
      report.checks.push('turning off the virtual reader disables virtual-card editing while device controls retain their existing workflow');

      const virtualWrites = await ev('window.__machineUi.state().operations.filter(item=>item.kind==="virtual-card").length');
      await ev('window.__machineUi.holdCards(true)'); await press('[data-player-picker="虚拟卡号"]'); await press('.player-picker-menu .player-add-option');
      await input(codeInput, '11112222333344445555', false); await press('[data-virtual-card-save]'); await nav('home');
      await ev('window.__machineUi.holdCards(false);window.__machineUi.releaseCards()'); await pause(150);
      assert.equal(await ev('window.__machineUi.state().operations.filter(item=>item.kind==="virtual-card").length'), virtualWrites);
      report.checks.push('leaving during card registration prevents a subsequent virtual-card file write');

      await nav('sega'); await wait('document.querySelector("[data-machine-id=machine-0-a]")'); await press('[data-machine-id=machine-0-a]');
      await press('[data-machine-activate]'); await wait('window.__machineUi.state().current.activeMachineId==="machine-0-a"'); await wait('!document.querySelector(".machine-operation")');
      await nav('player-saves'); await wait('document.querySelector("[data-player-profile-id=player-a]")');
      await wait('document.querySelector("[data-player-data-intro-dismiss]")');await press('[data-player-data-intro-dismiss]');await wait('!document.querySelector("[data-player-data-intro]")');
      if (await ev('document.querySelector("[data-player-profile-id=player-a]").getAttribute("aria-pressed")!=="true"')) { await press('[data-player-profile-id=player-a]'); await wait('document.querySelector("[data-player-profile-id=player-a]").getAttribute("aria-pressed")==="true"'); }
      await press('[data-player-profile-id=player-a]'); await wait('document.querySelector("[data-player-profile-edit-machine]")');
      await press('[data-player-profile-edit-machine]'); await wait('document.querySelector("[data-machine-id=machine-0-b]")?.getAttribute("aria-expanded")==="true"'); await singlePanel('machine-0-b');
      assert.equal((await ev('window.__machineUi.state()')).current.activeMachineId, 'machine-0-a');
      assert.equal(await ev(`document.querySelector('${activeEditor} [data-machine-activate]')!==null`), true);
      report.checks.push('edit-machine navigation expands the player-bound inactive card while the explicitly activated current machine remains unchanged');

      await ev('document.querySelector(".app").classList.add("dark")'); report.darkLayouts = [];
      for (const width of [720, 420]) {
        win.setSize(width, 1000); await pause(350); await singlePanel('machine-0-b');
        assert.equal(await ev('document.querySelector(".config-scroll").scrollWidth<=document.querySelector(".config-scroll").clientWidth+1'), true);
        assert.equal(await ev(`document.querySelector('${activeEditor}').scrollWidth<=document.querySelector('${activeEditor}').clientWidth+1`), true);
        report.darkLayouts.push({ width, geometry: await geometry() }); await snapshot(`spines-dark-narrow${width}`);
      }
      report.darkStyles = await ev(`(()=>{const panel=document.querySelector('${activeEditor}'),spine=document.querySelector('.machine-card.is-spine'),button=spine.querySelector('[data-machine-id]');return {background:getComputedStyle(panel).backgroundColor,color:getComputedStyle(panel).color,titleColor:getComputedStyle(panel.querySelector('[aria-label="机台名称"]')).color,spineBackground:getComputedStyle(spine).backgroundColor,disabled:button.disabled}})()`);
      await advanced(); await snapshot('spines-dark-advanced420');
      report.checks.push('dark 720px and 420px windows retain one readable expanded card and centered side spines without overflowing controls');

      report.virtualEditorLayouts = [];
      for (const width of [720, 420]) {
        win.setSize(width, 1000); await pause(280);
        await press('[data-player-picker="虚拟卡号"]'); await wait('document.querySelector(".virtual-card-menu")'); await press('[data-virtual-card-edit]');
        await input(codeInput, '00001111222233334444', false); await press('.virtual-card-menu .player-card-eye'); await pause(180);
        const layout = await ev(`(()=>{const menu=document.querySelector('.virtual-card-menu'),form=menu.querySelector('form'),input=menu.querySelector('input'),rect=menu.getBoundingClientRect(),styles=getComputedStyle(input),canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.font=styles.font;return {width:innerWidth,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,height:innerHeight,overflow:form.scrollWidth>form.clientWidth+1,inputWidth:input.clientWidth,codeTextWidth:context.measureText(input.value).width,actionHeights:Array.from(form.querySelectorAll('.virtual-card-editor-actions>button')).map(button=>button.getBoundingClientRect().height)}})()`);
        assert.ok(layout.left >= 0 && layout.right <= width && layout.top >= 0 && layout.bottom <= layout.height);
        assert.equal(layout.overflow, false); assert.ok(layout.inputWidth >= layout.codeTextWidth + 16); assert.equal(new Set(layout.actionHeights).size, 1);
        report.virtualEditorLayouts.push(layout); await snapshot(`aime-card-editor-dark-${width}`);
        await press('[data-virtual-card-cancel]'); await key('Escape'); await wait('!document.querySelector(".virtual-card-menu")');
      }
      win.setSize(720, 900); await pause(300);
      report.checks.push('inline Aime editing fits dark 720px and 420px windows with the full 20-digit text and equal-height save/cancel controls');

      await ev('window.__machineUi.holdSaves(true)'); await input('.machine-editor[data-machine-panel] [aria-label="机台名称"]', '迟到旧目录');
      await ev('window.__machineUi.selectRoot(1)'); await ev(`Array.from(document.querySelectorAll('.header-actions button')).find(button=>button.textContent.includes('选择目录')).click()`);
      await wait('!document.querySelector(".sega-page")'); await nav('sega'); await wait('document.querySelector("[data-machine-id=machine-1-a]")');
      await ev('window.__machineUi.holdSaves(false);window.__machineUi.releaseSaves()'); await pause(200);
      assert.doesNotMatch(await ev('document.querySelector(".machine-section").textContent'), /迟到旧目录|备用机台 1|主机台 1/);
      report.checks.push('a late save from the previous directory cannot replace the newly selected directory');

      await press('[data-machine-id=machine-1-b]'); await settlePanel();
      await press(`${activeEditor} [data-machine-delete]`);
      report.deleteButtons = await ev(`Array.from(document.querySelectorAll('${activeEditor} .option-delete-button')).map(button=>{const range=document.createRange();range.selectNodeContents(button);return {text:button.textContent,width:button.getBoundingClientRect().width,height:button.getBoundingClientRect().height,textLines:range.getClientRects().length,overflow:button.scrollWidth>button.clientWidth+1}})`);
      report.deleteButtons.forEach(button => { assert.equal(button.textLines, 1); assert.equal(button.overflow, false); assert.ok(button.height >= 32); });
      await press(`${activeEditor} [data-machine-delete-confirm]`);
      await wait('document.querySelector(".machine-editor [role=alert]")?.textContent.includes("请先修改使用此机台的玩家")');
      assert.equal(await ev(`document.querySelector('${activeEditor} [data-machine-delete-confirm]').disabled`), false);
      assert.equal(await ev('document.querySelector("[data-machine-id=machine-1-b]")!==null'), true);
      assert.equal(await ev('document.querySelector("[data-machine-retry]")===null'), true);
      await ev('document.querySelector(".machine-editor [role=alert]").scrollIntoView({block:"nearest"})'); await pause(150);
      await snapshot('spines-delete-referenced');
      await press(`${activeEditor} [data-machine-delete-cancel]`); await press('[data-machine-id=machine-1-a]'); await settlePanel();
      assert.equal(await ev(`document.querySelector('${activeEditor} [data-machine-delete]').disabled`), true);
      assert.match(await ev(`document.querySelector('${activeEditor} .machine-editor-footer').textContent`), /请先将另一机台设为当前/);
      report.checks.push('a player reference rejects deletion with one actionable error and retryable confirmation; the current machine is protected');

      await press('[data-machine-add]'); await wait('document.querySelectorAll(".machine-list [data-machine-id]").length===3'); await settlePanel();
      await ev('window.__machineUi.running(true)'); await press(`${activeEditor} [data-machine-delete]`); await press(`${activeEditor} [data-machine-delete-confirm]`);
      await wait('document.querySelectorAll(".machine-list [data-machine-id]").length===2'); await wait('document.activeElement.hasAttribute("data-machine-add")');
      await collapsed();
      assert.equal((await ev('window.__machineUi.state()')).current.activeMachineId, 'machine-1-a');
      assert.equal((await ev('window.__machineUi.state()')).operations.at(-1).kind, 'delete');
      await ev('window.__machineUi.running(false);window.__machineUi.clearReferences()');
      await press('[data-machine-id=machine-1-b]'); await settlePanel(); await press(`${activeEditor} [data-machine-delete]`); await press(`${activeEditor} [data-machine-delete-confirm]`);
      await wait('document.querySelectorAll(".machine-list [data-machine-id]").length===1'); await wait('document.activeElement.hasAttribute("data-machine-add")'); await collapsed(); await press('[data-machine-id=machine-1-a]'); await settlePanel(); await singlePanel('machine-1-a');
      assert.equal(await ev(`document.querySelector('${activeEditor} [data-machine-delete]').disabled`), true);
      assert.match(await ev(`document.querySelector('${activeEditor} .machine-editor-footer').textContent`), /至少保留一个机台/);
      report.checks.push('inactive unreferenced deletion succeeds during a running game, retains the current machine, restores add focus and protects the last machine');

      assert.deepEqual(errors, []); report.status = 'passed'; report.rendererErrors = errors;
      fs.writeFileSync(path.join(output, url ? 'dev-results.json' : 'electron-results.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(0);
    } catch (error) {
      report.status = 'failed'; report.error = String(error); report.stack = error.stack; report.rendererErrors = errors;
      fs.writeFileSync(path.join(output, url ? 'dev-results.json' : 'electron-results.json'), JSON.stringify(report, null, 2)); console.error(error); win.destroy(); app.exit(1);
    }
  }).catch(error => { console.error(error); app.exit(1); });
}
