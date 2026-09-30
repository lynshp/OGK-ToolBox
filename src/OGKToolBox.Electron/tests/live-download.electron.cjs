// Opt-in live network integration test: run after npm run build.
// Uses real frontend buttons, production IPC/download/install code and live public resources.
// Library/hardware data are fixtures; only two smallest Option/Mod entries are shown.
// All writes stay in a fresh artifacts/live-download-* tree; installer execution is excluded.
const fs=require('node:fs'),path=require('node:path');
if(!process.versions.electron){
 const root=path.resolve(__dirname,'../artifacts/live-download-'+Date.now());fs.mkdirSync(root,{recursive:true});
 const env={...process.env,OGK_LIVE_DOWNLOAD_ROOT:root,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'};delete env.ELECTRON_RUN_AS_NODE;
 const child=require('node:child_process').spawn(require('electron'),[__filename],{env,stdio:'inherit',windowsHide:true});
 child.on('exit',code=>process.exitCode=code??1);
}else{
 const {app,BrowserWindow,ipcMain,dialog}=require('electron');
 const root=process.env.OGK_LIVE_DOWNLOAD_ROOT;if(!root)throw Error('Run via Node');
 for(const name of ['profile','temp','game','cache'])fs.mkdirSync(path.join(root,name),{recursive:true});
 app.setPath('userData',path.join(root,'profile'));app.setPath('temp',path.join(root,'temp'));
 Object.defineProperty(app,'isPackaged',{get:()=>true});app.getVersion=()=> process.env.OGK_LIVE_CURRENT_VERSION||'1.1.7';
 Object.defineProperty(process,'resourcesPath',{value:process.env.OGK_LIVE_RESOURCES||path.resolve(__dirname,'../../../artifacts/update-review/win-unpacked/resources')});
 app.disableHardwareAcceleration();app.commandLine.appendSwitch('in-process-gpu');
 const report={root,querySource:process.env.OGK_LIVE_QUERY_SOURCE||'github',assetSource:process.env.OGK_LIVE_ASSET_SOURCE||'ghproxy',results:[],requests:[]};let win,manager;const deadline=setTimeout(()=>finish(Error('Live test deadline')),12*60*1000);
 function record(kind,data){report.results.push({kind,...data});console.log(kind,JSON.stringify(data));fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));}
 async function finish(error){clearTimeout(deadline);if(error)record('fatal',{error:String(error),stack:error.stack});try{await manager?.stop();}catch{}win?.destroy();app.exit(error?1:0);}
 (async()=>{

 const mainFile=path.resolve(__dirname,'../dist-electron/electron/main.js');const Module=require('node:module');const mod=new Module(mainFile,module);mod.filename=mainFile;mod.paths=Module._nodeModulePaths(path.dirname(mainFile));
 const source=fs.readFileSync(mainFile,'utf8');const marker=source.indexOf('electron_1.app.whenReady().then');if(marker<0)throw Error('Lifecycle marker missing');
 // Keep production IPC, manifest, streaming, hash and installation functions; omit unrelated app/hardware startup.
 mod._compile(source.slice(0,marker)+'\nexports.live={updateManager,packageManifest};',mainFile);manager=mod.exports.live.updateManager;
 await app.whenReady();
 const {githubSources}=require('../dist-electron/electron/github-sources');await githubSources.save(process.env.OGK_LIVE_QUERY_SOURCE||'github',process.env.OGK_LIVE_ASSET_SOURCE||'ghproxy');
 const originalFetch=githubSources.fetch.bind(githubSources);githubSources.fetch=async(...args)=>{const start=Date.now();try{const r=await originalFetch(...args);report.requests.push({url:args[0],status:r.status,ms:Date.now()-start});return r;}catch(e){report.requests.push({url:args[0],error:String(e)});throw e;}};
 const {autoUpdater}=require('electron-updater');autoUpdater.downloadedUpdateHelper=new (require('electron-updater/out/DownloadedUpdateHelper').DownloadedUpdateHelper)(path.join(root,'cache')); autoUpdater.updateConfigPath=path.join(root,'update.yml');fs.writeFileSync(path.join(root,'update.yml'),'provider: github\nowner: lynshp\nrepo: OGKToolBox-releases\nupdaterCacheDirName: ogk-live-download\n');
 const check=manager.check;manager.check=async()=>manager.status;await manager.start();manager.check=check;
 dialog.showMessageBox=async()=>{record('update-dialog',{shown:true});return {response:1,checkboxChecked:false};};
 ipcMain.handle('live:root',()=>path.join(root,'game'));
 let fullManifest;const originalManifest=mod.exports.live.packageManifest;
 ipcMain.removeHandler('packages:manifest');ipcMain.handle('packages:manifest',async()=>{
  fullManifest=await originalManifest();const options=[...fullManifest.optionPackages].filter(x=>x.size>0).sort((a,b)=>a.size-b.size).slice(0,2);const mods=[...fullManifest.mods].filter(x=>x.size>0&&x.sha256).sort((a,b)=>a.size-b.size).slice(0,2);
  if(!report.samples){report.samples={options,mods};record('manifest',{options:fullManifest.optionPackages.length,mods:fullManifest.mods.length,samples:report.samples});}
  return {...fullManifest,optionPackages:options,mods};
 });
 win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{preload:path.join(__dirname,'live-download.preload.cjs'),contextIsolation:false,sandbox:false,offscreen:true,backgroundThrottling:false}});
 manager.hooks.getWindow=()=>win;
 const ev=s=>win.webContents.executeJavaScript(s,true);
 async function waitFor(s,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){if(await ev(s))return;await new Promise(r=>setTimeout(r,200));}throw Error('Timeout: '+s+'; '+await ev('document.body.textContent'));}
 await win.loadFile(path.resolve(__dirname,'../dist/index.html'));await waitFor("!!document.querySelector('.app.boot-ready')");
 if(!process.env.OGK_LIVE_APP_ONLY){
 await ev("document.querySelector('[data-nav-page=option-packages]').click()");
 await waitFor("document.querySelectorAll('.option-download-row-button').length>0",90000);
 await ev("document.querySelector('.option-download-row-button').click()");
 await waitFor("window.__live.results.length>=1",240000);record('option-single',await ev('window.__live.results[0]'));
 await ev("document.querySelector('.option-batch-download').click()");
 await waitFor("window.__live.results.length>=3",300000);record('option-batch',await ev('({results:window.__live.results.slice(1)})'));
 await ev("document.querySelector('[data-nav-page=mods]').click()");
 await waitFor("!!document.querySelector('.mods .option-download-row-button')");
 await ev("document.querySelector('.mods .option-download-row-button').click()");
 await waitFor("window.__live.results.length>=4",180000);record('mod-single',await ev('window.__live.results[3]'));
 }
 if(process.env.OGK_LIVE_PACKAGES_ONLY){if((await ev('window.__live.results')).some(x=>!x.ok))throw Error('Package failure');await finish();return;}
 await ev("document.querySelector('[data-nav-page=settings]').click()");await waitFor("!!document.querySelector('.settings-nav')");await ev("[...document.querySelectorAll('.settings-nav button')].find(x=>x.textContent==='关于').click()");await waitFor("!!document.querySelector('.update-actions')");
 await ev("[...document.querySelectorAll('.update-actions button')].find(x=>x.textContent==='检查更新').click()");
 const started=Date.now();let lastLog=0;while(Date.now()-started<600000){await new Promise(r=>setTimeout(r,1000));const s=manager.status;if(Date.now()-lastLog>20000){lastLog=Date.now();record('app-progress',{state:s.state,progress:s.progress,node:s.proxyNode});}if(['ready','error','not-available'].includes(s.state)){record('app-update',{status:s});break;}}
 fs.writeFileSync(path.join(root,'final.png'),(await win.webContents.capturePage()).toPNG());
 const failures=report.results.flatMap(item=>item.results??[item]).filter(item=>item.ok===false);
 if(failures.length)throw Error('Package downloads failed; see report');
 if(manager.status.state!=='ready'&&!(process.env.OGK_LIVE_CURRENT_VERSION&&manager.status.state==='not-available'))throw Error('Application download did not reach verified ready state');
 await finish();
 })().catch(finish);
}
