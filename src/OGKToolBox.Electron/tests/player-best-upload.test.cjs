const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const Module = require('node:module');
const ts = require('typescript');
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name).exports;
  const file = path.resolve(__dirname, `../electron/${name}.ts`), m = new Module(file, module);
  m.filename = file; m.paths = module.paths;
  m.require = id => {
    const dependency = path.resolve(path.dirname(file), `${id}.ts`);
    return id.startsWith('.') && fs.existsSync(dependency) ? load(path.relative(path.resolve(__dirname, '../electron'), dependency).slice(0, -3)) : require(id);
  };
  modules.set(name, m);
  m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText, file);
  return m.exports;
}
const {uploadPlayerBest, playerBestDelta, writePlayerBestApi, playerBestTechnicalRank, playerBestPlatinumRank} = load('player-best-upload');
const {persistSave, listSaves, saveDirectory} = load('player-save');
const {playerProfiles,mergePlayerBest} = load('player-profiles');
const {playerProtocolDigest,playerProtocolFromSalt,playerGameProtocol} = load('player-game-protocol');
const {discoverPlayerServer,lookupPlayerCard,playerReadRequests} = load('player-bootstrap');
const {readGameApi} = load('player-capture');
const {PlayerUploadError} = load('player-upload-diagnostics');
const syntheticProtocol = playerProtocolFromSalt(Buffer.from('synthetic salt for tests'));
const uploadServices = {discover:discoverPlayerServer,lookup:lookupPlayerCard,read:readGameApi,write:writePlayerBestApi,protocol:async()=>syntheticProtocol};
const card = '12345678901234567890';
const existing = {musicId:101,level:3,playCount:9,techScoreMax:980000,techScoreRank:7,battleScoreMax:100000,battleScoreRank:2,platinumScoreMax:700,platinumScoreStar:3,maxComboCount:600,maxOverKill:125,maxTeamOverKill:900,isFullBell:true,isFullCombo:false,isAllBreake:false,isLock:true,clearStatus:1,isStoryWatched:true};
const local = {musicId:101,level:3,techScoreMax:1008000,techScoreRank:11,battleScoreMax:90000,platinumScoreMax:600,platinumScoreStar:2,playCount:700,isFullBell:false,isFullCombo:true,isAllBreake:true};
function crypt(bytes, encrypt=true) {
  const cipher = (encrypt?crypto.createCipheriv:crypto.createDecipheriv)('aes-128-ecb',Buffer.from('Copyright(C)SEGA'),null);
  cipher.setAutoPadding(false); return Buffer.concat([cipher.update(bytes),cipher.final()]);
}
async function fixture(t, rows=[local], options={}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(),'ogk-best-upload-'));
  t.after(async()=>{ assert.equal(path.dirname(root),path.resolve(os.tmpdir())); assert.match(path.basename(root),/^ogk-best-upload-/); await fsp.rm(root,{recursive:true,force:true}); });
  const remoteRows = options.remoteRows ?? [{...existing},{...existing,musicId:999,level:10,techScoreMax:1010001,techScoreRank:12}];
  const remote = new Map(remoteRows.map(row=>[`${row.musicId}:${row.level}`,{...row}])), requests=[], writes=[];
  const aide = net.createServer(socket=>{
    socket.once('data', bytes=>{
      const decoded=crypt(bytes,false); assert.equal(decoded.readUInt16LE(4),0x0f); assert.equal(decoded.subarray(32,42).toString('hex'),card);
      const response=Buffer.alloc(48); response.writeUInt16LE(0xa13e);response.writeUInt16LE(0x3087,2);response.writeUInt16LE(0x10,4);response.writeUInt16LE(48,6);response.writeUInt16LE(1,8);response.writeUInt32LE(options.lookupUser??42,32);socket.end(crypt(response));
    });
  });
  await new Promise(resolve=>aide.listen(0,'127.0.0.1',resolve));
  const httpServer=http.createServer(async(req,res)=>{
    const bytes=[];for await(const chunk of req)bytes.push(chunk);
    if(req.url==='/sys/servlet/PowerOn') {
      assert.equal(req.headers['user-agent'],undefined);
      requests.push('PowerOn'); res.end(`stat=1&uri=${encodeURIComponent(`http://127.0.0.1:${httpServer.address().port}/ongeki/`)}&place_id=123`); return;
    }
    const request=JSON.parse(zlib.inflateSync(Buffer.concat(bytes))); const api=req.url.split('/').pop();requests.push(api);
    assert.equal(req.headers['user-agent'],syntheticProtocol.userAgent(api,42));
    assert.equal(req.headers['content-type'],'application/json'); assert.equal(req.headers.charset,'UTF-8');
    assert.ok(!JSON.stringify(req.headers).includes('OGKToolBox'));
    if(api==='UpsertUserAllApi') {
      writes.push(request);
      assert.deepEqual(Object.keys(request.upsertUserAll).sort(),['isNewMusicDetailList','userMusicDetailList']);
      assert.equal(request.userId,42);assert.equal(request.accessCode,card);assert.equal(request.placeId,123);assert.equal(request.clientId,'A1234567890');assert.equal(request.regionId,0);
      if(options.failBatch===writes.length) {res.statusCode=501;res.end('unsupported');return;}
      if(!options.noop) for(const row of request.upsertUserAll.userMusicDetailList)remote.set(`${row.musicId}:${row.level}`,row);
      if(options.changeConfigAfterBatch===writes.length)await fsp.writeFile(path.join(root,'segatools.ini'),'[dns]\ndefault=changed.invalid\n[keychip]\nid=A123-45678901234\n');
      if(options.partial)remote.set('101:3',{...existing});
      res.end(JSON.stringify({returnCode:options.returnCode??1,apiName:'upsertUserAll'})); return;
    }
    const response={userId:options.wrongUser?43:42,nextIndex:0};
    if(api==='GetUserDataApi')response.userData={userName:'TEST',newPlayerRating:12345,jewelCount:18};
    else if(api==='GetUserMusicApi'){
      const groups=new Map();for(const row of remote.values()){const group=groups.get(row.musicId)??[];group.push(row);groups.set(row.musicId,group);}
      const allGroups=[...groups.values()].map(rows=>({userMusicDetailList:rows,...(options.musicLengths?{length:rows.length}:{})}));
      const musicGroups=options.pagedMusic?request.nextIndex===0?allGroups.slice(0,1):allGroups.slice(1):allGroups;
      response.userMusicList=musicGroups;
      if(options.pagedMusic)response.nextIndex=request.nextIndex===0?100:0;
      if(options.musicLengths)response.length=musicGroups.length;
      if(options.badMusicLength==='page')response.length=musicGroups.length+1;
      if(options.badMusicLength==='group'&&musicGroups.length)musicGroups[0].length=musicGroups[0].userMusicDetailList.length+1;
    }
    else if(api==='GetUserCardApi')response.userCardList=[{cardId:7}];
    else if(api==='GetUserCharacterApi')response.userCharacterList=[];
    else if(api==='GetUserItemApi')response.userItemList=[];
    else if(api==='GetUserOptionApi')response.userOption={};
    else if(api==='GetUserActivityApi'){response.kind=2;response.userActivityList=[];}
    res.setHeader('Content-Encoding','deflate');res.end(zlib.deflateSync(Buffer.from(JSON.stringify(response))));
  });
  await new Promise(resolve=>httpServer.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await Promise.all([new Promise(resolve=>httpServer.close(resolve)),new Promise(resolve=>aide.close(resolve))]);});
  await fsp.mkdir(path.join(root,'DEVICE'),{recursive:true});await fsp.writeFile(path.join(root,'DEVICE','aime.txt'),card);
  const configuration=`[dns]\ndefault=${options.server??'play.mumur.net'}\nAimeDB=http://127.0.0.1:${aide.address().port}\n[keychip]\nid=A123-45678901234\n`;
  await fsp.writeFile(path.join(root,'segatools.ini'),configuration);
  const profiles=await playerProfiles(root), scope={cardId:profiles.defaultCardId,serverId:profiles.server.id};
  const save=await persistSave(root,{userData:{userName:'TEST'},userMusicList:[{userMusicDetailList:rows}]},'json','local-merged',scope);
  const original=await fsp.readFile(path.join(saveDirectory(root),'archives',`${save.id}.json`));
  // The policy sees the real configured host. Only the injected discovery
  // service is redirected to this fixture's loopback server.
  const services={...uploadServices,discover:(config,...args)=>discoverPlayerServer({...config,server:`http://127.0.0.1:${httpServer.address().port}`},...args)};
  return {root,save,scope,requests,writes,remote,original,configuration,services};
}
function upload(f,signal){return uploadPlayerBest(f.root,f.save.id,f.scope.cardId,f.scope.serverId,signal,f.services);}

test('full ALL.Net+Aime+read/write/read improves best and preserves higher server best and every non-score field',async t=>{
  const f=await fixture(t,[local,{...local,musicId:202,level:4}]);
  const result=await upload(f);
  assert.equal(result.uploadedCharts,2);assert.equal(result.save.newPlayerRating,undefined);assert.ok(result.save.bestMerge);assert.equal(result.save.scope.cardId,f.scope.cardId);
  assert.equal(result.save.scores.find(score=>score.musicId===999).techScore,1010000);
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].upsertUserAll.isNewMusicDetailList,'01');
  const row=f.remote.get('101:3');
  assert.equal(row.techScoreMax,1008000);assert.equal(row.isFullCombo,true);assert.equal(row.isAllBreake,true);assert.equal(row.platinumScoreMax,700);assert.equal(row.platinumScoreStar,3);assert.equal(row.battleScoreMax,100000);assert.equal(row.isFullBell,true);
  for(const field of ['playCount','maxComboCount','maxOverKill','maxTeamOverKill','isLock','clearStatus','isStoryWatched','battleScoreRank'])assert.equal(row[field],existing[field]);
  assert.equal(f.remote.get('999:10').techScoreMax,1010001);assert.equal(f.remote.get('202:10').playCount,0);assert.equal(f.remote.get('202:10').isStoryWatched,false);
  assert.deepEqual(await fsp.readFile(path.join(saveDirectory(f.root),'archives',`${f.save.id}.json`)),f.original);
  const saves=await listSaves(f.root);assert.equal(saves.length,4);assert.equal(saves.filter(s=>s.source==='direct').length,2);
  assert.ok(saves.filter(save=>save.source==='direct').every(save=>save.newPlayerRating===12345 && save.inventory.cardCount===1));
  assert.equal(f.requests.filter(api=>api==='GetUserMusicApi').length,2);assert.equal(f.requests[0],'PowerOn');
});
test('server already has better local best: makes no write and returns verified target',async t=>{
  const f=await fixture(t,[{...existing,techScoreMax:970000,isFullBell:false}]);
  const result=await upload(f);assert.equal(result.uploadedCharts,0);assert.equal(f.writes.length,0);assert.equal(result.save.scores.find(s=>s.musicId===101).techScore,980000);
});
test('success-looking no-op and partial persistence fail verification, retaining local merge and pre-upload backup',async t=>{
  for(const options of [{noop:true},{partial:true}]){
    const f=await fixture(t,[local],options);await assert.rejects(upload(f),/回读仍有 1 张谱面未同步/);assert.equal(f.writes.length,1);assert.ok((await listSaves(f.root)).some(s=>s.id===f.save.id));
  }
});
test('unsupported and rejected write responses report failure without inventing success',async t=>{
  for(const options of [{failBatch:1},{returnCode:0}]){
    const f=await fixture(t,[local],options);await assert.rejects(upload(f),/服务器未接受|服务器未确认/);assert.equal(f.writes.length,1);
  }
});
test('partial batches are explicit, and a retry only uploads remaining improvements',async t=>{
  const rows=Array.from({length:101},(_,i)=>({...local,musicId:200+i}));const f=await fixture(t,rows,{failBatch:2});
  await assert.rejects(upload(f),/已发送 100 张谱面/);assert.equal(f.writes.length,2);
  const result=await upload(f);assert.equal(result.uploadedCharts,1);assert.equal(f.writes.length,3);
});
test('stale server, wrong card and pre-cancel fail before any network request',async t=>{
  const f=await fixture(t);await assert.rejects(uploadPlayerBest(f.root,f.save.id,'unknown',f.scope.serverId),/有效卡号|当前玩家已变化/);
  await assert.rejects(uploadPlayerBest(f.root,f.save.id,f.scope.cardId,'unknown'),/服务器配置已变化/);
  const controller=new AbortController();controller.abort();await assert.rejects(upload(f,controller.signal),/已取消/);
  assert.equal(f.requests.length,0);assert.equal(f.writes.length,0);
});
test('non-MuNET and lookalike configurations cannot bypass score policy through injected services',async t=>{
  for(const server of ['nageki-net.com','ea.naominet.live','aqua.naominet.live','play.mumur.net.attacker.invalid','munet.invalid','127.0.0.1']){
    const f=await fixture(t,[local],{server});let invoked=0;
    const blockedServices={discover:async()=>{invoked++;throw new Error('discovery called');},lookup:async()=>{invoked++;return 42;},read:async()=>{invoked++;throw new Error('read called');},write:async()=>{invoked++;},protocol:async()=>{invoked++;return syntheticProtocol;}};
    await assert.rejects(uploadPlayerBest(f.root,f.save.id,f.scope.cardId,f.scope.serverId,undefined,blockedServices),/成绩仅保存本地.*Net 前端/);
    assert.equal(invoked,0);assert.equal(f.requests.length,0);assert.equal(f.writes.length,0);
    assert.deepEqual(await fsp.readFile(path.join(saveDirectory(f.root),'archives',`${f.save.id}.json`)),f.original);
  }
});
test('local best merging still works for a non-MuNET server without any network operation',async t=>{
  const f=await fixture(t,[local],{server:'nageki-net.com'});
  const other=await persistSave(f.root,{userMusicList:[{userMusicDetailList:[{...local,musicId:202}]}]},'json','second-save',f.scope);
  const merged=await mergePlayerBest(f.root,f.save.id,[other.id],f.scope.cardId,f.scope.serverId);
  assert.equal(merged.scores.length,2);assert.ok(merged.bestMerge);assert.equal(f.requests.length,0);assert.equal(f.writes.length,0);
});
test('mismatched remote response player fails before any upload',async t=>{
  const f=await fixture(t,[local],{wrongUser:true});await assert.rejects(upload(f),error=>error.diagnostic?.api==='GetUserDataApi'&&error.diagnostic.stage==='identity'&&error.diagnostic.reason==='identity_mismatch');assert.equal(f.writes.length,0);
});
test('music pagination reads every page and interprets response lengths as groups rather than nested details',async t=>{
  const f=await fixture(t,[local,{...local,level:2},{...existing,musicId:999,level:4,techScoreMax:900000}],{pagedMusic:true,musicLengths:true});
  const result=await upload(f);assert.equal(result.uploadedCharts,2);assert.equal(f.remote.get('999:10').techScoreMax,1010001);
  assert.equal(f.requests.filter(api=>api==='GetUserMusicApi').length,4);
  assert.ok(f.writes[0].upsertUserAll.userMusicDetailList.every(row=>row.musicId!==999));
});
test('LUNATIC protocol ten shares internal four, updates existing rows and writes game difficulty enums',async t=>{
  const rows=[{...local,musicId:303,level:10},...Array.from({length:4},(_,level)=>({...local,musicId:500+level,level})),{...local,musicId:202,level:4}];
  const f=await fixture(t,rows,{remoteRows:[{...existing,musicId:303,level:10}]});
  assert.ok(f.save.scores.filter(score=>[202,303].includes(score.musicId)).every(score=>score.difficulty===4));
  const result=await upload(f);assert.equal(result.uploadedCharts,6);assert.equal(f.writes.length,1);
  const sent=f.writes[0].upsertUserAll;
  assert.equal(sent.isNewMusicDetailList,'101111');
  assert.deepEqual(sent.userMusicDetailList.map(row=>row.level),[10,10,0,1,2,3]);
  assert.equal(f.remote.get('303:10').techScoreMax,1008000);assert.equal(f.remote.get('303:10').playCount,existing.playCount);
  assert.equal(f.remote.has('303:4'),false);assert.equal(f.remote.has('202:4'),false);
  assert.ok(result.save.scores.filter(score=>[202,303].includes(score.musicId)).every(score=>score.difficulty===4));
  assert.deepEqual(await fsp.readFile(path.join(saveDirectory(f.root),'archives',`${f.save.id}.json`)),f.original);
  const repeated=await upload(f);assert.equal(repeated.uploadedCharts,0);assert.equal(f.writes.length,1);
});
test('remote LUNATIC aliases four and ten collide as one chart and block all uploads',async t=>{
  const f=await fixture(t,[{...local,musicId:303,level:4}],{remoteRows:[{...existing,musicId:303,level:4},{...existing,musicId:303,level:10}]});
  await assert.rejects(upload(f),/重复谱面，未上传/);assert.equal(f.writes.length,0);
  assert.deepEqual(await fsp.readFile(path.join(saveDirectory(f.root),'archives',`${f.save.id}.json`)),f.original);
});
test('explicit truncated music-page and chart-group lengths block all writes',async t=>{
  for(const badMusicLength of ['page','group']){
    const f=await fixture(t,[local],{badMusicLength,musicLengths:true});await assert.rejects(upload(f),/数量不一致，未上传/);assert.equal(f.writes.length,0);
    assert.deepEqual(await fsp.readFile(path.join(saveDirectory(f.root),'archives',`${f.save.id}.json`)),f.original);
  }
});
test('delta rejects invalid scores and never copies a local play count',()=>{
  const safe={musicId:1,difficulty:3,techScore:990000,playCount:1234,fullCombo:false,fullBell:false,allBreak:false};
  const delta=playerBestDelta([safe],new Map());assert.equal(delta.changes[0].playCount,0);assert.equal(delta.isNew,'1');
  assert.throws(()=>playerBestDelta([{...safe,platinumScore:-1}],new Map()),/字段无效/);assert.throws(()=>playerBestDelta([safe,safe],new Map()),/重复谱面/);
  assert.equal(playerBestDelta([{...safe,techScore:0}],new Map()).changes.length,0);
});
test('missing ranks use verified game thresholds, including platinum five-star Ex',()=>{
  for(const [score,rank] of [[0,1],[499999,1],[500000,2],[939999,7],[940000,8],[970000,9],[990000,10],[1000000,11],[1007499,11],[1007500,12],[1010000,12]])assert.equal(playerBestTechnicalRank(score),rank);
  for(const [score,rank] of [[939,0],[940,1],[950,2],[960,3],[970,4],[980,5],[990,6]])assert.equal(playerBestPlatinumRank(score,1000),rank);
  const score={musicId:1,difficulty:3,techScore:1008000,platinumScore:990,fullCombo:false,fullBell:false,allBreak:false};
  const delta=playerBestDelta([score],new Map(),new Map([['1:3',1000]]));assert.equal(delta.changes[0].techScoreRank,12);assert.equal(delta.changes[0].platinumScoreStar,6);
});
test('upload derives missing platinum stars only from compatible local chart maximum metadata',async t=>{
  const f=await fixture(t,[{...local,techScoreRank:undefined,platinumScoreStar:undefined,platinumScoreMax:1980}]);
  const musicFolder=path.join(f.root,'mu3_Data','StreamingAssets','GameData','A000','music','music0101');await fsp.mkdir(musicFolder,{recursive:true});
  const chart='<FumenData><FumenConstIntegerPart>12</FumenConstIntegerPart><FumenConstFractionalPart>0</FumenConstFractionalPart><FumenFile><path>chart.ogkr</path></FumenFile></FumenData>';
  await fsp.writeFile(path.join(musicFolder,'Music.xml'),`<MusicData><Name><id>101</id></Name><IsBonusTrack>false</IsBonusTrack><FumenDataList>${chart.repeat(4)}</FumenDataList></MusicData>`);await fsp.writeFile(path.join(musicFolder,'chart.ogkr'),'[HEADER]\nT_TOTAL\t1000\n[NOTES]\n');
  const result=await upload(f);assert.equal(result.uploadedCharts,1);assert.equal(f.remote.get('101:3').platinumScoreStar,6);assert.equal(f.remote.get('101:3').techScoreRank,12);
});
test('configuration changing mid-upload stops later batches without sending scores to another server',async t=>{
  const f=await fixture(t,Array.from({length:101},(_,i)=>({...local,musicId:200+i})),{changeConfigAfterBatch:1});
  await assert.rejects(upload(f),/已发送 100 张谱面.*服务器配置已变化/);assert.equal(f.writes.length,1);
});
test('concurrent uploads for the same game root are blocked until the first completes',async t=>{
  const f=await fixture(t);const {discoverPlayerServer,lookupPlayerCard}=load('player-bootstrap'),{readGameApi}=load('player-capture');
  let entered,release;const started=new Promise(resolve=>entered=resolve),resume=new Promise(resolve=>release=resolve);let waiting=true;
  const pending=uploadPlayerBest(f.root,f.save.id,f.scope.cardId,f.scope.serverId,undefined,{...f.services,read:async(...args)=>{if(waiting){waiting=false;entered();await resume;}return readGameApi(...args);}});
  await started;await assert.rejects(upload(f),/正在上传/);release();assert.equal((await pending).uploadedCharts,1);
});
test('upload writer rejects credentials, paths without slash, and explicit response identity mismatch',async t=>{
  await assert.rejects(writePlayerBestApi('http://user:secret@localhost/',{}),/地址无效/);
  await assert.rejects(writePlayerBestApi('http://localhost/ongeki',{}),/地址无效/);
  const server=http.createServer((req,res)=>{req.resume();res.end(JSON.stringify({returnCode:1,userId:9}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  await assert.rejects(writePlayerBestApi(`http://127.0.0.1:${server.address().port}/ongeki/`,{userId:42},undefined,syntheticProtocol.userAgent('UpsertUserAllApi',42)),/服务器未确认/);
});

test('game identifiers use keyed BLAKE2b and the actual PBKDF2 parameters, with separate API and player identities',()=>{
  const key=Buffer.from(Array.from({length:32},(_,i)=>i));
  for(const [bytes,expected] of [[Buffer.alloc(0),'4e51e7a913fc80137da52880fecca175bf81e117d5c68126dc2774033517ea0d'],[Buffer.from('synthetic game resource'),'d25865c103ac7c4f903794959b61d4cadf2d26323ac670d9ac869b3a13b06aac'],[Buffer.from(Array.from({length:256},(_,i)=>i)),'b42be36ea26392f67d1d3706ffa72b6c61c2ff38e1fabd9a49e154d54b967d83']])assert.equal(playerProtocolDigest(bytes,key).toString('hex'),expected);
  const salt=Buffer.from('abcdefghmorebytes'),expected=crypto.pbkdf2Sync('UpsertUserAllApi',salt.subarray(0,8),64,16,'sha1').toString('hex').toUpperCase();
  const protocol=playerProtocolFromSalt(salt);salt.fill(0);
  assert.equal(protocol.userAgent('UpsertUserAllApi',42),`${expected}#42`);assert.equal(protocol.userAgent('UpsertUserAllApi',43),`${expected}#43`);
  assert.notEqual(protocol.userAgent('GetUserMusicApi',42),protocol.userAgent('UpsertUserAllApi',42));
  assert.throws(()=>protocol.userAgent('invalid\r\nheader',42),/标识/);assert.throws(()=>protocol.userAgent('UpsertUserAllApi',0),/身份/);
});

test('missing local protocol resources fail before ALL.Net, preserving the local merge without a tool identifier fallback',async t=>{
  const f=await fixture(t);await assert.rejects(uploadPlayerBest(f.root,f.save.id,f.scope.cardId,f.scope.serverId),/本机游戏的请求标识/);
  assert.equal(f.requests.length,0);assert.equal(f.writes.length,0);assert.deepEqual(await fsp.readFile(path.join(saveDirectory(f.root),'archives',`${f.save.id}.json`)),f.original);
  const cancel=new AbortController();cancel.abort();await assert.rejects(playerGameProtocol(f.root,cancel.signal),/已取消/);
});

test('standalone compatible read seeds retain their identifier while sync reads use the game identifier for every core and optional API',()=>{
  const regular=playerReadRequests('http://localhost/game/',42),sync=playerReadRequests('http://localhost/game/',42,syntheticProtocol.userAgent);
  assert.ok(regular.every(event=>event.connection.userAgent==='OGKToolBox/1.0'));
  assert.ok(sync.every(event=>event.connection.userAgent===syntheticProtocol.userAgent(event.api,42)));
  assert.ok(sync.some(event=>event.api==='GetUserActivityApi'));
});

test('writer fails closed for missing, foreign-player or injected request identifiers',async()=>{
  for(const ua of [undefined,'OGKToolBox/1.0',syntheticProtocol.userAgent('UpsertUserAllApi',43),'X\r\nOther: value'])await assert.rejects(writePlayerBestApi('http://localhost/game/',{userId:42},undefined,ua),/请求标识无效/);
});

test('game full-score raw counters survive updates to other best metrics',()=>{
  const old={...existing,techScoreMax:1019999,techScoreRank:12};
  const delta=playerBestDelta([{musicId:101,difficulty:3,techScore:1010000,platinumScore:701,fullCombo:false,fullBell:false,allBreak:false}],new Map([['101:3',old]]));
  assert.equal(delta.changes.length,1);assert.equal(delta.changes[0].techScoreMax,1019999);
  assert.equal(delta.changes[0].platinumScoreMax,701);assert.equal(delta.isNew,'0');
});

async function writerServer(t, respond) {
  const server=http.createServer((req,res)=>{req.resume();respond(req,res);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}/ongeki/`;
}
const diagnosticRequest={userId:42,regionId:0,placeId:123,clientId:'A1234567890',accessCode:card,upsertUserAll:{userData:[{userName:'PRIVATE_PLAYER',medalCount:19}]}};
function writeDiagnostic(url,signal){return writePlayerBestApi(url,diagnosticRequest,signal,syntheticProtocol.userAgent('UpsertUserAllApi',42));}
async function writerFailure(promise) {
  let error;try{await promise;}catch(value){error=value;}
  assert.ok(error instanceof PlayerUploadError);assert.equal(error.stack,undefined);return error;
}

test('HTTP 500 compressed JSON and HTTP 200 failure returnCode expose safe structured diagnostics only',async t=>{
  const traceId='c31b0778-947f-4a76-801a-bd382c958914',ua=syntheticProtocol.userAgent('UpsertUserAllApi',42);
  for(const [status,encoding] of [[500,'gzip'],[200,'deflate']]){
    const url=await writerServer(t,(_req,res)=>{
      res.statusCode=status;res.setHeader('Content-Encoding',encoding);res.setHeader('X-Request-ID',traceId);
      const raw=Buffer.from(JSON.stringify({returnCode:0,message:`Missing required field userOption for PRIVATE_PLAYER card ${card} chip A1234567890 ua ${ua} https://private.invalid/session`,errors:[{field:'userData[0].medalCount'}],stack:`SERVER_PRIVATE_STACK ${card}`}));
      res.end(encoding==='gzip'?zlib.gzipSync(raw):zlib.deflateSync(raw));
    });
    const error=await writerFailure(writeDiagnostic(url));
    assert.equal(error.diagnostic.stage,status===500?'http':'protocol');assert.equal(error.diagnostic.status,status);assert.equal(error.diagnostic.category,'missing_field');assert.equal(error.diagnostic.returnCode,0);assert.equal(error.diagnostic.traceId,traceId);
    assert.ok(error.diagnostic.fields.includes('userOption'));assert.ok(error.diagnostic.fields.includes('userData.medalCount'));
    for(const secret of [card,'PRIVATE_PLAYER','A1234567890',ua,'https://private.invalid/session','SERVER_PRIVATE_STACK'])assert.ok(!error.message.includes(secret)&&!JSON.stringify(error).includes(secret));
    assert.ok(!error.message.includes('合并成绩'));
  }
});

test('raw HTML, invalid JSON, unknown response encoding and malformed compressed responses never escape the writer',async t=>{
  for(const options of [{status:500,body:`<html>PRIVATE_PLAYER ${card} secret-stack userOption</html>`,expected:'server_error'}, {status:200,body:'invalid-json',expected:'invalid_response'}, {status:500,encoding:'br',body:'unreadable-private-response',expected:'invalid_response'}, {status:500,encoding:'gzip',body:'not-gzip',expected:'invalid_response'}]){
    const url=await writerServer(t,(_req,res)=>{res.statusCode=options.status;if(options.encoding)res.setHeader('Content-Encoding',options.encoding);res.end(options.body);});
    const error=await writerFailure(writeDiagnostic(url));assert.equal(error.diagnostic.category,options.expected);assert.equal(error.diagnostic.status,options.status);assert.equal(error.diagnostic.fields,undefined);
    assert.ok(!error.message.includes(card)&&!JSON.stringify(error).includes('PRIVATE_PLAYER'));
  }
});

test('wire-size and decompressed-size caps apply to HTTP failures as well as successful-status responses',async t=>{
  for(const options of [{status:500,wire:Buffer.alloc(65537,97)}, {status:200,wire:Buffer.alloc(65537,97)}, {status:500,wire:zlib.gzipSync(Buffer.alloc(100000,97)),encoding:'gzip'}, {status:200,wire:zlib.deflateSync(Buffer.alloc(100000,97)),encoding:'deflate'}]){
    const url=await writerServer(t,(_req,res)=>{res.statusCode=options.status;if(options.encoding)res.setHeader('Content-Encoding',options.encoding);res.end(options.wire);});
    const error=await writerFailure(writeDiagnostic(url));assert.equal(error.diagnostic.category,'response_too_large');assert.equal(error.diagnostic.status,options.status);
  }
});

test('truncated HTTP error responses classify interruption without waiting for the timeout',async t=>{
  const url=await writerServer(t,(_req,res)=>{res.writeHead(500,{'Content-Length':'100'});res.flushHeaders();res.write('{"message":');setTimeout(()=>res.destroy(),10);});
  const error=await writerFailure(writeDiagnostic(url));assert.equal(error.diagnostic.category,'response_interrupted');assert.equal(error.diagnostic.status,500);
});

test('abort and the fixed upload deadline close pending responses and expose no low-level transport exception',async t=>{
  const url=await writerServer(t,()=>{}),controller=new AbortController();
  const aborted=writeDiagnostic(url,controller.signal);controller.abort();
  const cancelled=await writerFailure(aborted);assert.equal(cancelled.diagnostic.category,'cancelled');assert.equal(cancelled.diagnostic.stage,'transport');
  const original=global.setTimeout;let pending;
  try{global.setTimeout=(callback,delay,...args)=>original(callback,delay===15000?20:delay,...args);pending=writeDiagnostic(url);}finally{global.setTimeout=original;}
  const timeout=await writerFailure(pending);assert.equal(timeout.diagnostic.category,'timeout');assert.equal(timeout.diagnostic.stage,'transport');
  assert.ok(!timeout.message.includes(url));
});

test('response identifiers cannot expose an echoed game UA hash or known profile value disguised as a trace ID',async t=>{
  const hash=syntheticProtocol.userAgent('UpsertUserAllApi',42).split('#')[0],url=await writerServer(t,(_req,res)=>{res.statusCode=500;res.setHeader('X-Trace-ID',hash);res.end(JSON.stringify({requestId:hash,returnCode:42,message:'server failure'}));});
  const error=await writerFailure(writeDiagnostic(url));assert.equal(error.diagnostic.traceId,undefined);assert.equal(error.diagnostic.returnCode,undefined);assert.ok(!JSON.stringify(error).includes(hash));
});

test('best-score Upsert rejects string success codes',async t=>{
  for(const returnCode of ['1','100']){
    const url=await writerServer(t,(_req,res)=>res.end(JSON.stringify({returnCode})));
    await writerFailure(writeDiagnostic(url));
  }
});
