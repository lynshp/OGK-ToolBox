const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../../../artifacts/player-upload-policy-review/merge');
const headerOutput = output;
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  fs.mkdirSync(output, { recursive: true });
  const profile = path.join(output, `profile-${Date.now()}`); fs.mkdirSync(profile);
  const preload = path.join(profile, 'merge.preload.cjs');
  fs.writeFileSync(preload, `
    require(${JSON.stringify(path.join(__dirname, 'player-saves.preload.cjs'))});
    const ts = require(${JSON.stringify(require.resolve('typescript'))});
    const source = require('node:fs').readFileSync(${JSON.stringify(path.resolve(__dirname, '../src/player-best-merge.ts'))}, 'utf8');
    const mod = {exports:{}}; new Function('exports','require','module',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(mod.exports,require,mod);
    const score=(musicId,techScore)=>({musicId,difficulty:3,techScore,platinumScore:1900,fullCombo:false,fullBell:false,allBreak:false});
    const scope={cardId:'card-a',serverId:'server-a'};
    const target={id:'target',scope,serverLabel:'server-a.invalid',source:'direct',updatedAt:'2026-10-02T12:00:00Z',playerName:'目标玩家',scores:[score(101,900000)],newPlayerRating:12345,inventory:{version:1,cardCount:8,itemsRecorded:true,items:[]},collections:[],warnings:[]};
    const rows=[target,
      {...target,id:'same-history',updatedAt:'2026-10-01T12:00:00Z',scores:[score(101,920000)]},
      {...target,id:'server-b-new',scope:{...scope,serverId:'server-b'},serverLabel:'server-b.invalid',updatedAt:'2026-10-02T11:00:00Z',playerName:'另一服务器玩家',scores:[{...score(101,1000000),fullCombo:true},score(202,980000)]},
      {...target,id:'server-b-old',scope:{...scope,serverId:'server-b'},serverLabel:'server-b.invalid',updatedAt:'2026-09-30T12:00:00Z',scores:[score(101,950000)]},
      {...target,id:'other-card',scope:{cardId:'card-other',serverId:'server-b'},playerName:'不应显示的其他卡号'},
      {...target,id:'unassigned',scope:undefined,playerName:'不应显示的未归属'}
    ];
    const probe=window.__mergeTest={mergeCalls:0,uploadCalls:0,uploadMode:'error',mergeFail:false,lastRequest:null,complete:null,cancelled:false,policyMode:'ok',policy:{scoreUpload:'direct',frontendService:'munet',serverHost:'play.mumur.net'},policyCalls:0,completePolicy:null,exportCalls:0,portalCalls:0};
    window.ogk.playerUploadPolicy=async()=>{probe.policyCalls++;const result=structuredClone(probe.policy);if(probe.policyMode==='wait')await new Promise(resolve=>probe.completePolicy=resolve);if(probe.policyMode==='error')throw Error("Error invoking remote method 'player-saves:upload-policy': Error: 上传方式读取失败，请重试。");return result;};
    window.ogk.exportPlayerSave=async(root,id)=>{probe.exportCalls++;probe.exportRequest={root,id};return true;};
    window.ogk.openHddPortal=async service=>{probe.portalCalls++;probe.portalService=service;};
    window.ogk.playerSaves=async()=>({saves:structuredClone(rows),profiles:window.__playerSaveTest.profiles(),capture:{enabled:false,installed:false,status:'',sessions:0,canRefresh:false}});
    window.ogk.mergePlayerBest=async(root,targetId,sourceIds,cardId,serverId)=>{
      probe.mergeCalls++; probe.lastRequest={root,targetId,sourceIds,cardId,serverId};
      if(probe.mergeFail)throw new Error('来源存档已移除，请重新选择。');
      const base=rows.find(s=>s.id===targetId),preview=mod.exports.mergeBestScores(base.scores,rows.filter(s=>sourceIds.includes(s.id)).map(s=>s.scores));
      const result={...base,id:'merged-'+probe.mergeCalls,updatedAt:new Date().toISOString(),scores:preview.scores,bestMerge:{targetId,sourceIds}};delete result.newPlayerRating;rows.unshift(result);probe.lastLocalId=result.id;return structuredClone(result);
    };
    window.ogk.uploadPlayerBest=async(root,id,cardId,serverId)=>{
      probe.uploadCalls++;
      if(probe.uploadMode==='wait')await new Promise(resolve=>probe.complete=resolve);
      if(probe.cancelled){probe.cancelled=false;throw new Error('已取消上传，请重新获取确认服务器成绩。');}
      if(probe.uploadMode==='error')throw new Error('服务器拒绝写入，上传未完成。');
      const local=rows.find(s=>s.id===id),result={...local,id:'verified-'+probe.uploadCalls,bestMerge:undefined,source:'direct'};rows.unshift(result);return {save:structuredClone(result),uploadedCharts:2};
    };
    window.ogk.cancelPlayerRefresh=()=>{probe.cancelled=true;probe.complete?.();};
  `);
  app.setPath('userData', profile); app.disableHardwareAcceleration(); app.commandLine.appendSwitch('in-process-gpu');
  app.whenReady().then(async () => {
    const win = new BrowserWindow({show:false,width:1440,height:900,webPreferences:{preload,contextIsolation:false,sandbox:false,offscreen:true}});
    const errors=[];
    win.webContents.on('console-message',detail=>{if(detail.level==='error'&&!detail.message.includes('frame-ancestors'))errors.push(detail.message);});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_event,done)=>done({cancel:true}));
    const evaluate=value=>win.webContents.executeJavaScript(value,true);
    const wait=async condition=>{const end=Date.now()+10000;while(Date.now()<end){if(await evaluate(`Boolean(${condition})`))return;await new Promise(r=>setTimeout(r,40));}throw new Error('Timeout: '+condition);};
    const click=selector=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw new Error('Missing/enabled: '+${JSON.stringify(selector)});e.focus();e.click();})()`);
    const snap=async(name,directory=output)=>{await evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);await new Promise(r=>setTimeout(r,500));win.webContents.invalidate();await new Promise(r=>setTimeout(r,100));fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,name+'.png'),(await win.webContents.capturePage()).toPNG());};
    const open=async()=>{await click('[data-player-best-merge]');await wait(`document.querySelector('.player-best-merge')`);await wait(`window.__mergeTest.policyMode==='wait'||document.querySelector('[data-merge-upload]')||document.querySelector('[data-merge-policy-retry]')||document.querySelector('.player-merge-footer')?.textContent.includes('NET 前端')`);};
    const escape=async()=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await wait(`!document.querySelector('.player-best-merge')`);};
    const geometry=async()=>await wait(`(()=>{const p=document.querySelector('.player-popover').getBoundingClientRect(),buttons=Array.from(document.querySelectorAll('.player-merge-footer button')).map(button=>button.getBoundingClientRect());return p.left>=0&&p.right<=innerWidth&&p.top>=0&&p.bottom<=innerHeight&&buttons.every(b=>b.left>=p.left&&b.right<=p.right&&b.top>=p.top&&b.bottom<=p.bottom)&&document.querySelector('.player-best-merge').scrollWidth<=document.querySelector('.player-best-merge').clientWidth;})()`);
    try {
      await win.loadFile(path.resolve(__dirname,'../dist/index.html'));await wait(`document.querySelector('[data-nav-page="player-saves"]')`);await click('[data-nav-page="player-saves"]');await wait(`document.querySelector('#player-save-name')?.textContent==='目标玩家'`);
      await wait(`document.querySelector('[data-player-data-intro-dismiss]')`);await click('[data-player-data-intro-dismiss]');await wait(`!document.querySelector('[data-player-data-intro]')`);
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.page-title .player-utility-actions>button')).map(button=>button.firstChild.textContent)`),['自动读取 Mod','历史存档','合并最佳']);
      assert.equal(await evaluate(`document.querySelectorAll('[data-player-best-merge]').length===1&&!document.querySelector('.player-record-actions [data-player-best-merge]')`),true);
      await open();
      assert.equal(await evaluate(`(()=>{const p=document.querySelector('.player-popover').getBoundingClientRect(),a=document.querySelector('[data-player-best-merge]').getBoundingClientRect();return p.top>=a.bottom&&p.top-a.bottom<=12&&Math.abs(p.right-a.right)<2;})()`),true);
      await snap('player-best-merge-header-anchor',headerOutput);
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('[data-merge-source]')).map(e=>e.dataset.mergeSource).sort()`),['same-history','server-b-new','server-b-old']);
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('[data-merge-source][aria-checked="true"]')).map(e=>e.dataset.mergeSource)`),['server-b-new']);
      assert.equal(await evaluate(`document.querySelector('[data-merge-added]').textContent`),'+1');assert.equal(await evaluate(`document.querySelector('[data-merge-improved]').textContent`),'1');
      assert.equal(await evaluate(`document.querySelector('[data-merge-rating]').textContent.includes('—')`),false);
      assert.equal(await evaluate(`(()=>{const p=document.querySelector('.player-popover').getBoundingClientRect(),b=document.querySelector('[data-merge-upload]').getBoundingClientRect();return b.bottom<=p.bottom&&b.top>=p.top;})()`),true);
      await snap('merge-light');
      await click('[data-merge-clear]');assert.equal(await evaluate(`document.querySelector('[data-merge-upload]').disabled`),true);
      await click('[data-merge-source="server-b-old"]');assert.equal(await evaluate(`document.querySelector('[data-merge-added]').textContent`),'+0');
      await click('[data-merge-select-all]');assert.equal(await evaluate(`document.querySelectorAll('[data-merge-source][aria-checked="true"]').length`),3);
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await wait(`!document.querySelector('.player-best-merge')`);
      assert.equal(await evaluate(`document.activeElement.hasAttribute('data-player-best-merge')`),true);assert.equal(await evaluate(`window.__mergeTest.mergeCalls`),0);
      await open();await click('[data-merge-upload]');await wait(`document.querySelector('.player-best-merge [role="alert"]')?.textContent.includes('本地已保存')`);
      assert.equal(await evaluate(`window.__mergeTest.mergeCalls`),1);assert.equal(await evaluate(`window.__mergeTest.uploadCalls`),1);assert.equal(await evaluate(`document.querySelector('[data-merge-upload]').textContent`),'重试上传');
      await snap('upload-retry');
      await evaluate(`window.__mergeTest.uploadMode='wait'`);await click('[data-merge-upload]');await wait(`document.querySelector('[data-merge-upload]')?.textContent==='上传中…'`);
      assert.equal(await evaluate(`document.querySelector('[data-player-best-merge]').disabled`),true);
      assert.equal(await evaluate(`document.querySelector('[data-archives-toggle]').disabled&&document.querySelector('[data-capture-toggle]').disabled`),true);
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});assert.equal(await evaluate(`!!document.querySelector('.player-best-merge')`),true);
      await click('[data-merge-cancel]');await wait(`document.querySelector('.player-best-merge [role="alert"]')?.textContent.includes('已取消上传')&&!document.querySelector('[data-merge-upload]').disabled`);
      await evaluate(`window.__mergeTest.uploadMode='ok'`);await click('[data-merge-upload]');await wait(`!document.querySelector('.player-best-merge')&&document.querySelector('.player-save-toast')?.textContent.includes('上传 2')`);
      assert.equal(await evaluate(`window.__mergeTest.mergeCalls`),1);assert.equal(await evaluate(`window.__mergeTest.uploadCalls`),3);
      await open();await click('[data-merge-clear]');await click('[data-merge-source="server-b-old"]');await evaluate(`window.__mergeTest.mergeFail=true`);await click('[data-merge-local]');await wait(`document.querySelector('.player-best-merge [role="alert"]')?.textContent.includes('来源存档已移除')`);assert.equal(await evaluate(`document.querySelector('[data-merge-source="server-b-old"]').getAttribute('aria-checked')`),'true');
      await evaluate(`window.__mergeTest.mergeFail=false`);await click('[data-merge-local]');await wait(`!document.querySelector('.player-best-merge')&&document.querySelector('.player-merged-badge')`);assert.equal(await evaluate(`window.__mergeTest.uploadCalls`),3);
      await click('[data-nav-page="settings"]');await wait(`document.querySelector('.theme-choice')`);await evaluate(`Array.from(document.querySelectorAll('.theme-choice')).find(b=>b.textContent==='深色').click()`);await click('[data-nav-page="player-saves"]');await wait(`document.querySelector('[data-player-best-merge]')`);await open();await snap('merge-dark');
      win.setSize(720,1000);await snap('merge-narrow');
      assert.equal(await evaluate(`(()=>{const r=document.querySelector('.player-popover').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()`),true);
      assert.equal(await evaluate(`document.querySelector('.player-best-merge').scrollWidth<=document.querySelector('.player-best-merge').clientWidth`),true);
      await escape();win.setSize(1440,900);await evaluate(`window.__mergeTest.policy={scoreUpload:'frontend',frontendService:'nageki',serverHost:'nageki-net.com'}`);await open();await wait(`document.querySelector('.player-merge-footer').textContent.includes('请按 NET 前端支持的方式上传')`);assert.equal(await evaluate(`!!document.querySelector('[data-merge-local]')&&!document.querySelector('[data-merge-upload]')&&!document.querySelector('[data-merge-net]')`),true);
      const frontendUploads=await evaluate(`window.__mergeTest.uploadCalls`);await click('[data-merge-local]');await wait(`document.querySelector('[data-merge-local]')?.textContent==='查看本地'&&document.querySelector('[data-merge-export]')`);assert.equal(await evaluate(`window.__mergeTest.uploadCalls`),frontendUploads);assert.equal(await evaluate(`document.querySelector('[data-merge-export]').textContent`),'导出备份');await click('[data-merge-export]');await wait(`window.__mergeTest.exportCalls===1&&document.querySelector('.player-merge-footer').textContent.includes('备份已导出')`);assert.equal(await evaluate(`window.__mergeTest.exportRequest.id===window.__mergeTest.lastLocalId`),true);await click('[data-merge-net]');await wait(`window.__mergeTest.portalCalls===1`);assert.equal(await evaluate(`window.__mergeTest.portalService`),'nageki');assert.equal(await evaluate(`!!document.querySelector('.player-best-merge')&&!document.querySelector('[data-merge-upload]')`),true);
      await evaluate(`document.querySelector('.app').classList.remove('dark')`);await geometry();await snap('merge-net-saved-light');win.setSize(420,900);await geometry();await snap('merge-net-saved-phone-light');await evaluate(`document.querySelector('.app').classList.add('dark')`);await geometry();await snap('merge-net-saved-phone-dark');await click('[data-merge-local]');await wait(`!document.querySelector('.player-best-merge')&&document.querySelector('.player-save-toast')?.textContent.includes('最佳成绩已保存在本地')`);assert.equal(await evaluate(`window.__mergeTest.uploadCalls`),frontendUploads);win.setSize(1440,900);
      await evaluate(`window.__mergeTest.policy={scoreUpload:'frontend',frontendService:null,serverHost:'custom.invalid'}`);await open();await wait(`document.querySelector('.player-merge-footer').textContent.includes('NET 前端')`);await click('[data-merge-local]');await wait(`document.querySelector('[data-merge-export]')`);assert.equal(await evaluate(`!document.querySelector('[data-merge-net]')&&!document.querySelector('[data-merge-upload]')&&document.querySelector('.player-merge-footer').textContent.includes('请打开所用服务器的 NET 前端。')`),true);await escape();
      await evaluate(`window.__mergeTest.policyMode='error'`);await open();await wait(`document.querySelector('[data-merge-policy-retry]')`);assert.equal(await evaluate(`!document.querySelector('[data-merge-upload]')&&!document.querySelector('.player-best-merge [role="alert"]').textContent.includes('Error invoking remote method')`),true);await evaluate(`window.__mergeTest.policyMode='ok';window.__mergeTest.policy={scoreUpload:'frontend',frontendService:'rinnet',serverHost:'ea.naominet.live'}`);await click('[data-merge-policy-retry]');await wait(`!document.querySelector('[data-merge-policy-retry]')&&document.querySelector('.player-merge-footer').textContent.includes('NET 前端')`);await click('[data-merge-local]');await wait(`document.querySelector('[data-merge-net]')`);await click('[data-merge-net]');assert.equal(await evaluate(`window.__mergeTest.portalService`),'rinnet');await escape();
      await evaluate(`window.__mergeTest.policyMode='wait';window.__mergeTest.completePolicy=null`);await open();await wait(`window.__mergeTest.completePolicy`);assert.equal(await evaluate(`!document.querySelector('[data-merge-upload]')&&!document.querySelector('[data-merge-net]')`),true);await escape();await evaluate(`window.__mergeTest.policyMode='ok';window.__mergeTest.completePolicy()`);await new Promise(resolve=>setTimeout(resolve,100));assert.equal(await evaluate(`!!document.querySelector('.player-best-merge')`),false);assert.equal(await evaluate(`window.__mergeTest.uploadCalls`),frontendUploads);
      assert.deepEqual(errors,[]);console.log('Best merge UI passed: MuNET direct uploads and retry; other-server local merge keeps saved dialog for export and whitelisted NET portal, unknown portal stays manual, failed/pending policy prevents direct upload, late policy never revives dialog, same-card source isolation, newest defaults, busy/focus, light/dark and 420 geometry.');
    } catch(error) {await snap('failure');throw error;} finally {win.destroy();app.quit();}
  }).catch(error=>{console.error(error);app.exit(1);});
}
