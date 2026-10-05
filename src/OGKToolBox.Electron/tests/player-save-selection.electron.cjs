// Actual provider, page and editor, isolated from the backend and real game.
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const output = process.env.OGK_CAPTURE_SELECTION_OUTPUT ? path.resolve(process.env.OGK_CAPTURE_SELECTION_OUTPUT) : path.resolve(__dirname, '../../../artifacts/player-capture-selection-review');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  fs.mkdirSync(output, { recursive: true });
  const profile = path.join(output, `profile-${Date.now()}`); fs.mkdirSync(profile);
  app.setPath('userData', profile); app.disableHardwareAcceleration();
  const checks = [];
  app.whenReady().then(async () => {
    const provider = process.env.OGK_CAPTURE_SELECTION_PROVIDER ? path.resolve(process.env.OGK_CAPTURE_SELECTION_PROVIDER) : null;
    await require('esbuild').build({ stdin: { contents: `
      import React,{useRef,useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {PlayerSaveProvider,usePlayerSave} from './src/player-save-context';
      import {PlayerSavesPage} from './src/player-saves-page';
      const rootA='C:/anonymous/game-a',rootB='C:/anonymous/game-b';
      const save=(id,name,source='direct',time='2026-10-04T00:02:00.000Z',scope={serverId:'server-a',cardId:'card-a'})=>({id,playerName:name,source,updatedAt:time,sequence:1,scope,scores:[],collections:[],warnings:[],inventory:{version:1,items:[],itemsRecorded:true}});
      function state(root){return {capture:{enabled:true,installed:true,status:'ready',sessions:1,canRefresh:false},profiles:{cards:[{id:'card-a',accessCode:'10000000000000000001'},{id:'card-b',accessCode:'10000000000000000002'}],machines:[{id:'machine-a',name:'机台一',server:{id:'server-a',label:'server-a.invalid'},values:{dns:{},netenv:{},keychip:{}},keychipHint:''},{id:'machine-b',name:'机台二',server:{id:'server-b',label:'server-b.invalid'},values:{dns:{},netenv:{},keychip:{}},keychipHint:''}],players:[{id:'player-a',name:'玩家一',machineId:'machine-a',cardId:'card-a'},{id:'player-b',name:'玩家二',machineId:'machine-b',cardId:'card-b'}],selectedPlayerId:'player-a',activeMachineId:'machine-a',defaultCardId:'card-a',server:{id:'server-a',label:'server-a.invalid'},configurationError:''},saves:[save('newest','默认最新'),save('history','手动历史','json','2026-10-04T00:01:00.000Z'),save('player-b-save','另一个玩家','direct','2026-10-04T00:02:00.000Z',{serverId:'server-b',cardId:'card-b'})]};}
      const states=new Map([[rootA,state(rootA)],[rootB,{...state(rootB),saves:[save('root-b-save','另一个目录')]}]]);
      const probe=window.__captureSelection={rootA,rootB,states,captureA:'game-'+'a'.repeat(32),captureB:'game-'+'b'.repeat(32),captureC:'game-'+'c'.repeat(32),reads:0,pending:[],holdNext:0,editorReads:[],saveCalls:[],uploadCalls:[],uploadResolve:null,cancelCalls:0};
      const interval=window.setInterval.bind(window),clear=window.clearInterval.bind(window),polls=new Map();probe.poll=()=>{for(const fn of [...polls.values()])fn();};window.setInterval=(fn,ms,...args)=>{if(ms===5000){const id=interval(()=>{},ms);polls.set(id,fn);return id;}return interval(fn,ms,...args);};window.clearInterval=id=>{polls.delete(id);clear(id);};
      Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});
      window.ogk={playerSaves:async root=>{probe.reads++;const snapshot=structuredClone(states.get(root));if(probe.holdNext>0){probe.holdNext--;await new Promise(resolve=>probe.pending.push({root,resolve}));}return snapshot;},cancelPlayerRefresh:()=>{probe.cancelCalls++;},selectPlayerProfile:async(root,id)=>{states.get(root).profiles.selectedPlayerId=id;},
        getPlayerSaveEditor:async(root,id,playerId)=>{probe.editorReads.push({root,id,playerId});return {saveId:id,playerId,gameEditEnabled:true,techScoreMax:1010000,scoreConstraints:[],resources:[{key:'data:point',name:'金币',category:'金币',value:10,max:999999999,editable:true}]};},
        playerUploadPolicy:async()=>({scoreUpload:'frontend',frontendService:null,serverHost:'server-a.invalid'}),
        savePlayerSaveEditor:async(root,id,playerId,patch)=>{probe.saveCalls.push({root,id,playerId,patch});const s=save('edited','固定的编辑目标','json','2026-10-04T00:04:00.000Z');s.edit={version:1,parentId:id,playerId,createdAt:s.updatedAt,...patch};states.get(root).saves.push(s);return structuredClone(s);},
        queuePlayerSaveEdit:async(...args)=>{probe.uploadCalls.push(args);await new Promise(resolve=>probe.uploadResolve=resolve);return {id:'queued',status:'pending',...args[3]};},playerSaveEditStatus:async()=>undefined,
        thumbnail:async()=>''};
      function Probe({root}){const context=usePlayerSave();probe.context=context;return <PlayerSavesPage root={root} music={[]}/>;}
      function Fixture(){const [root,setRoot]=useState(rootA),[page,setPage]=useState(true);probe.setRoot=setRoot;probe.setPage=setPage;return <PlayerSaveProvider key={root} root={root} active={true} savePageActive={page}><Probe root={root}/></PlayerSaveProvider>;}
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `, resolveDir: path.resolve(__dirname, '..'), sourcefile: 'capture-selection-fixture.tsx', loader: 'tsx' },
      outfile: path.join(profile, 'fixture.js'), bundle: true, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
      nodePaths: [path.resolve(__dirname, '../node_modules')], plugins: provider ? [{ name: 'reviewed-provider-baseline', setup(build) { build.onResolve({ filter: /(?:^|\/)player-save-context$/ }, () => ({ path: provider })); } }] : [] });
    fs.writeFileSync(path.join(profile, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
    const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { contextIsolation: false, sandbox: false, offscreen: true } });
    const errors = [];
    win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
    const evaluate = code => win.webContents.executeJavaScript(code, true);
    const wait = async condition => { const end = Date.now() + 6000; while (Date.now() < end) { if (await evaluate(`Boolean(${condition})`)) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('Timeout: ' + condition); };
    const check = async (condition, name) => { assert.equal(await evaluate(`Boolean(${condition})`), true, name); checks.push(name); };
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const poll = async () => { const reads = await evaluate('window.__captureSelection.reads'); await evaluate('window.__captureSelection.poll()'); await wait(`window.__captureSelection.reads>${reads}`); await new Promise(resolve => setTimeout(resolve, 70)); };
    const select = async id => { await evaluate(`window.__captureSelection.context.selectSave(${JSON.stringify(id)})`); await wait(`window.__captureSelection.context.save?.id===${JSON.stringify(id)}`); };
    const change = code => evaluate(`(()=>{const p=window.__captureSelection,s=p.states.get(p.rootA);${code}})()`);
    try {
      await win.loadFile(path.join(profile, 'index.html'));
      await wait('window.__captureSelection.context.save?.id==="newest"'); checks.push('entering page selects the latest scoped save');
      await wait('document.querySelector("[data-player-data-intro-dismiss]")');await click('[data-player-data-intro-dismiss]');await wait('!document.querySelector("[data-player-data-intro]")');
      await select('history'); await poll(); await poll();
      await check('window.__captureSelection.context.save?.id==="history"', 'unchanged polls preserve manual historical selection');
      await evaluate('window.__captureSelection.setPage(false)'); await new Promise(resolve => setTimeout(resolve, 70));
      await evaluate('window.__captureSelection.setPage(true)'); await wait('window.__captureSelection.context.save?.id==="newest"');
      checks.push('re-entering page restores the latest snapshot independently of manual history');
      await select('history');
      await change(`s.saves.push({...s.saves[0],id:'mod-one',sessionId:'b'.repeat(32),source:'game',playerName:'新采集',sequence:2,updatedAt:'2026-10-04T00:03:00.000Z'});`); await poll();
      await check('window.__captureSelection.context.save?.id==="mod-one"', 'new current-player Mod archive automatically selects newest');
      await select('history'); await change(`Object.assign(s.saves.find(x=>x.id==='mod-one'),{sequence:3,updatedAt:'2026-10-04T00:04:00.000Z'});`); await poll();
      await check('window.__captureSelection.context.save?.id==="mod-one"', 'same Mod archive revision automatically selects newest');
      await select('history'); await change(`s.saves.find(x=>x.id==='mod-one').latestCapture={id:p.captureB,at:'2026-10-04T00:04:00.000Z'};`); await poll();
      await check('window.__captureSelection.context.save?.id==="history"', 'same-session legacy completion marker backfill preserves manual history');
      await change(`s.saves.push({...s.saves[0],id:'mod-partial',sessionId:'c'.repeat(32),source:'game',playerName:'尚未收齐',sequence:4,updatedAt:'2026-10-04T00:05:00.000Z',warnings:['Item：尚未读取。']});`); await poll();
      await check('window.__captureSelection.context.save?.id==="history"', 'incomplete core capture leaves manual history selected');
      await change(`Object.assign(s.saves.find(x=>x.id==='mod-partial'),{warnings:[],latestCapture:{id:p.captureC,at:'2026-10-04T00:05:00.000Z'}});`); await poll();
      await check('window.__captureSelection.context.save?.id==="mod-partial"', 'same archive selects when its core capture completes');
      await select('history'); await change(`Object.assign(s.saves.find(x=>x.id==='mod-partial'),{latestCapture:undefined,warnings:['Music：分页未收齐。'],updatedAt:'2026-10-04T00:05:01.000Z',sequence:5});`); await poll();
      await change(`Object.assign(s.saves.find(x=>x.id==='mod-partial'),{warnings:[],updatedAt:'2026-10-04T00:05:00.000Z',latestCapture:{id:p.captureC,at:'2026-10-04T00:05:00.000Z'},sequence:6});`); await poll(); await poll();
      await check('window.__captureSelection.context.save?.id==="history"', 'partial rescan and prior completion replay do not repeatedly take manual history');
      await change(`Object.assign(s.saves.find(x=>x.id==='mod-partial'),{updatedAt:'2026-10-04T00:05:30.000Z',latestCapture:{id:p.captureC,at:'2026-10-04T00:05:30.000Z'}});`); await poll();
      await check('window.__captureSelection.context.save?.id==="mod-partial"', 'later complete revision of a previously partial archive still selects newest');
      await select('history'); await change(`s.saves.push({...s.saves[0],id:'foreign-mod',source:'game',scope:{serverId:'server-b',cardId:'card-b'},updatedAt:'2026-10-04T00:06:00.000Z'});`); await poll();
      await check('window.__captureSelection.context.save?.id==="history"', 'another player server capture does not take selection');
      await change(`s.saves[0].latestCapture={id:p.captureA,at:'2026-10-04T00:07:00.000Z'};`); await poll();
      await check('window.__captureSelection.context.save?.id==="newest"', 'completed Mod deduplication selects the retained direct archive');
      await select('history'); await poll(); await check('window.__captureSelection.context.save?.id==="history"', 'unchanged completed marker does not repeatedly take history');
      await change(`s.saves[0].latestCapture={id:'game-invalid',at:'2030-10-04T00:07:00.000Z'};`); await poll();
      await check('window.__captureSelection.context.save?.id==="history"', 'invalid completion identity cannot take manual history');
      await change(`s.saves[0].latestCapture={id:p.captureA,at:'invalid-date'};`); await poll();
      await check('window.__captureSelection.context.save?.id==="history"', 'invalid completion date cannot take manual history');
      await change(`s.saves[0].latestCapture={id:p.captureA,at:'2026-10-04T00:06:00.000Z'};`); await poll();
      await check('window.__captureSelection.context.save?.id==="history"', 'completion time rollback cannot take manual history');
      await evaluate('window.__captureSelection.context.showUnknown()'); await wait('window.__captureSelection.context.unknownSource');
      await change(`s.saves[0].latestCapture={id:p.captureA,at:'2026-10-04T00:08:00.000Z'};`); await poll();
      await check('window.__captureSelection.context.unknownSource', 'new capture preserves an explicit unknown-source view');
      await evaluate('window.__captureSelection.context.showUnassigned(false)'); await select('history');
      await change(`s.saves[0].latestCapture={id:p.captureA,at:'2026-10-04T00:09:00.000Z'};p.holdNext=1;`); await evaluate('window.__captureSelection.poll()'); await wait('window.__captureSelection.pending.length===1');
      await select('history'); await evaluate('window.__captureSelection.pending.shift().resolve()'); await poll();
      await check('window.__captureSelection.context.save?.id==="history"', 'manual choice made during a delayed read invalidates auto-selection');
      await change(`s.saves[0].latestCapture={id:p.captureA,at:'2026-10-04T00:10:00.000Z'};p.holdNext=1;`); await evaluate('window.__captureSelection.poll()'); await wait('window.__captureSelection.pending.length===1');
      await evaluate('window.__captureSelection.context.selectPlayer("player-b")'); await wait('window.__captureSelection.context.playerId==="player-b"');
      await evaluate('window.__captureSelection.pending.shift().resolve()'); await new Promise(resolve => setTimeout(resolve, 70));
      await check('window.__captureSelection.context.playerId==="player-b"&&window.__captureSelection.context.save?.id==="foreign-mod"', 'late original-player capture read cannot replace the new player scope');
      await evaluate('window.__captureSelection.context.selectPlayer("player-a")'); await select('history');
      await click('[data-player-save-edit]'); await wait('document.querySelector("[data-editor-resource]")');
      await change(`s.saves[0].latestCapture={id:p.captureA,at:'2026-10-04T00:11:00.000Z'};`); await poll();
      await check('window.__captureSelection.context.save?.id==="newest"&&document.querySelector(".player-save-editor-heading p").textContent.includes("手动历史")&&window.__captureSelection.editorReads.length===1', 'actual editor retains its original snapshot when capture changes page selection');
      await evaluate(`(()=>{const input=document.querySelector('[data-editor-resource="data:point"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'11');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await click('[data-save-editor-more]'); await wait('document.querySelector("[data-save-editor-local]")');await click('[data-save-editor-local]'); await wait('window.__captureSelection.saveCalls.length===1');
      await check('window.__captureSelection.saveCalls[0].id==="history"', 'actual editor saves its original archive rather than the new capture');
      await wait('!document.querySelector("[data-editor-resource]").disabled');
      await evaluate(`(()=>{const input=document.querySelector('[data-editor-resource="data:point"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'12');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await click('[data-save-editor-commit]'); await wait('window.__captureSelection.uploadCalls.length===1');
      await change(`s.saves[0].latestCapture={id:p.captureA,at:'2026-10-04T00:12:00.000Z'};`); await poll();
      await check('window.__captureSelection.uploadCalls[0][1]==="edited"&&window.__captureSelection.context.save?.id==="newest"&&!!document.querySelector("[data-save-editor]")', 'actual in-flight queue target stays fixed while current capture refreshes');
      await evaluate('window.__captureSelection.uploadResolve()');await wait('!document.querySelector("[data-save-editor-close]").disabled');await click('[data-save-editor-close]'); await wait('!document.querySelector("[data-save-editor]")');
      await change(`s.saves.push({...s.saves[0],id:'unuploaded-local',source:'json',latestCapture:undefined,updatedAt:'2030-01-01T00:00:00Z',edit:{version:1,playerId:'player-a',resources:[],scores:[]},scores:[{musicId:101,difficulty:3,techScore:1010000,fullCombo:true,fullBell:true,allBreak:true}]});`);await poll();await select('unuploaded-local');await poll();
      await check('window.__captureSelection.context.save?.id==="unuploaded-local"', 'ordinary polling preserves an explicitly selected local export');
      await evaluate('window.__captureSelection.setPage(false)');await new Promise(resolve=>setTimeout(resolve,70));
      await change(`s.saves[0].scores=[{musicId:101,difficulty:3,techScore:900000,fullCombo:false,fullBell:false,allBreak:false}];s.saves[0].latestCapture={id:p.captureA,at:'2026-10-04T00:13:00.000Z'};`);await poll();
      await check('window.__captureSelection.context.save?.id==="newest"&&window.__captureSelection.context.save.scores[0].techScore===900000', 'new server capture replaces unuploaded higher local score even off the saves page and with a later local timestamp');
      await check('window.__captureSelection.context.saves.find(s=>s.id==="unuploaded-local").scores[0].techScore===1010000', 'local export remains available in history without changing the read score');
      await evaluate('window.__captureSelection.setPage(true)');await new Promise(resolve=>setTimeout(resolve,70));
      await change('p.holdNext=1;'); await evaluate('window.__captureSelection.poll()'); await wait('window.__captureSelection.pending.length===1');
      await evaluate('window.__captureSelection.setRoot(window.__captureSelection.rootB)'); await wait('window.__captureSelection.context.save?.id==="root-b-save"');
      await evaluate('window.__captureSelection.pending.shift().resolve()'); await new Promise(resolve => setTimeout(resolve, 70));
      await check('window.__captureSelection.context.save?.id==="root-b-save"', 'late previous-root capture read cannot change the remounted root');
      await evaluate(`localStorage.removeItem('ogk-player-data-notice-dismissed:v1');window.__captureSelection.setRoot('');`);
      await wait('document.querySelector("[data-player-data-intro]")');
      await check('document.querySelector("[data-intro-capture-status]").textContent==="请先选择游戏目录"&&document.querySelector("[data-player-data-intro] [role=switch]").disabled', 'first entry without a game directory still explains risks and disables Mod installation');
      await click('[data-player-data-intro-continue]');await wait('!document.querySelector("[data-player-data-intro]")');
      await check('document.querySelector(".empty b").textContent==="请选择游戏目录"', 'directory selection guidance remains after dismissing the notice');
      assert.deepEqual(errors, []);
      fs.writeFileSync(path.join(output, 'electron-result.json'), JSON.stringify({ passed: true, checks, networkRequests: 0, backendOrRealGameStarted: false, fixture: 'actual renderer provider page and editor; anonymous mocks' }, null, 2));
      console.log(`Passed ${checks.length} actual renderer capture-selection checks without backend/game/network.`);
      win.destroy(); app.quit();
    } catch (error) { fs.writeFileSync(path.join(output, 'electron-failure.json'), JSON.stringify({ message: error.message, checks, errors }, null, 2)); console.error(error); win.destroy(); app.exit(1); }
  }).catch(error => { console.error(error); app.exit(1); });
}
