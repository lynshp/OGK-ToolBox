require('./player-saves.preload.cjs');
const originalEditorLibrarySection=window.ogk.librarySection;
window.ogk.librarySection=async(...args)=>{
  const result=await originalEditorLibrarySection(...args);if(args[1]!=='music')return result;
  for(const song of result){
    if(Number(song.id)===101){song.rating.charts.find(chart=>chart.difficulty===3).constant=12.899999618530273;song.charts.find(chart=>chart.difficulty===3).levelConstant=12.899999618530273;}
    if(Number(song.id)===202){song.rating.charts.find(chart=>chart.difficulty===3).constant=14.25;song.charts.find(chart=>chart.difficulty===3).levelConstant=14.25;}
    if(Number(song.id)===404){song.rating.charts=song.rating.charts.filter(chart=>chart.difficulty!==4);song.charts=song.charts.filter(chart=>chart.difficulty!==4);}
  }return result;
};
const profiles = window.__playerSaveTest.profiles();
profiles.cards.push({id:'card-b',accessCode:'23456789012345678901'});
profiles.players.push({id:'editor-player-b',name:'玩家 2',machineId:'machine-1',cardId:'card-b'});
const scope={cardId:'card-a',serverId:'server-a'};
const target={id:'editor-target',source:'json',scope,serverId:'server-a',localPlayerId:'player-card-a',updatedAt:'2026-10-03T03:00:00Z',playerName:'匿名编辑玩家',scores:[{musicId:101,difficulty:3,techScore:900000,platinumScore:1000,battleScore:10000,playCount:2,fullCombo:false,fullBell:false,allBreak:false}],inventory:{version:1,cardCount:3,itemsRecorded:true,items:[{itemKind:13,itemId:8,name:'强化道具（小）',stock:5}]},collections:[],warnings:[]};
const rows=[target];
const resources=[
  {key:'data:point',name:'金币',category:'基础资源',value:100,max:999999999,editable:true,limitKind:'game'},
  {key:'data:jewelCount',name:'通用珠',category:'基础资源',value:2,max:99999,editable:true,limitKind:'game'},
  {key:'data:medalCount',name:'勋章',category:'基础资源',value:3,max:999999,editable:true,limitKind:'game'},
  {key:'data:shizukuCount',name:'雫',category:'基础资源',value:4,max:999999,editable:true,limitKind:'game'},
  {key:'item:13:8',name:'强化道具（小）',category:'强化道具',value:5,max:9999,editable:true,limitKind:'game'},
  {key:'item:11:1',name:'抽卡券',category:'抽卡券',value:6,max:99,editable:true,limitKind:'game'},
  {key:'item:12:1',name:'开花券',category:'开花券',value:7,max:9999,editable:true,limitKind:'game'},
  {key:'item:14:1',name:'亲密度道具（小）',category:'亲密度道具',value:8,max:9999,editable:true,limitKind:'game'},
  {key:'item:9:1',name:'【SSR】匿名キャラクター ×1',category:'礼物 · 待领取奖励',value:3,max:2147483647,editable:true,limitKind:'field'},
  {key:'item:4:1',name:'SSR 限界突破券',category:'突破道具 · 作品/稀有度券',value:2,max:9999,editable:true,limitKind:'game'},
  {key:'item:20:1',name:'已解锁乐曲',category:'解锁道具',value:1,max:1,editable:true,binary:true,removable:false},
  {key:'item:20:2',name:'待解锁乐曲',category:'解锁道具',value:0,max:1,editable:true,binary:true,removable:true},
  {key:'chapter:2',name:'章节 2',category:'章节珠',value:0,max:99999,editable:true,limitKind:'game'},
  {key:'story:3',name:'剧情 3',category:'章节珠',value:0,max:99999,editable:true,limitKind:'game'},
  {key:'item:99:1',name:'未知资源',category:'未知',value:1,max:1,editable:false,reason:'游戏未定义'},
];
const probe=window.__saveEditorTest={getCalls:0,saveCalls:0,uploadCalls:0,lastPatch:null,lastRequest:null,rows,profiles,policy:{scoreUpload:'direct',frontendService:'munet',serverHost:'play.mumur.net'},exportCalls:0,portalService:null};
const copy=value=>structuredClone(value);
window.ogk.playerUploadPolicy=async()=>copy(probe.policy);
window.ogk.exportPlayerSave=async()=>{probe.exportCalls++;return true;};
window.ogk.openHddPortal=async service=>{probe.portalService=service;};
// A hidden direct writer would fail the regression instead of reaching a server.
window.ogk.uploadPlayerBest=async()=>{probe.uploadCalls++;throw Error('Unexpected direct upload from editor');};
window.ogk.playerSaves=async()=>({saves:copy(rows),profiles:copy(profiles),capture:{enabled:false,installed:false,status:'',sessions:0,canRefresh:false}});
window.ogk.selectPlayerProfile=async(_root,id)=>{const player=profiles.players.find(row=>row.id===id);if(!player)throw Error('玩家已移除');profiles.selectedPlayerId=id;profiles.defaultCardId=player.cardId;profiles.server=profiles.machines.find(machine=>machine.id===player.machineId).server;};
window.ogk.getPlayerSaveEditor=async(_root,id,playerId)=>{
  probe.getCalls++;
  return {saveId:id,playerId,techScoreMax:1010000,resources:copy(resources),scoreConstraints:[101,202,303,404,505,606].flatMap(musicId=>[0,1,2,3,4].filter(difficulty=>musicId!==404||difficulty!==4).map(difficulty=>({musicId,difficulty,platinumMax:musicId===303?null:2000,battleMax:2147483647,editable:musicId!==606,reason:musicId===606?'本地谱面无法读取':undefined})))};
};
window.ogk.savePlayerSaveEditor=async(root,id,playerId,patch)=>{
  probe.saveCalls++;probe.lastPatch=copy(patch);probe.lastRequest={root,id,playerId};
  if(profiles.selectedPlayerId!==playerId)throw Error('当前玩家已变化');
  const base=rows.find(save=>save.id===id);if(!base)throw Error('存档已移除');
  const result=copy(base);result.id='editor-local-'+probe.saveCalls;result.updatedAt=new Date().toISOString();result.sequence=probe.saveCalls;
  const resourceEdits=new Map((base.edit?.resources??[]).map(row=>[row.key,row])),scoreEdits=new Map((base.edit?.scores??[]).map(row=>[row.musicId+':'+row.difficulty,row]));
  for(const row of patch.resources)resourceEdits.set(row.key,copy(row));for(const row of patch.scores)scoreEdits.set(row.musicId+':'+row.difficulty,copy(row));
  result.edit={version:1,parentId:id,playerId,createdAt:result.updatedAt,resources:[...resourceEdits.values()],scores:[...scoreEdits.values()]};
  delete result.newPlayerRating;
  for(const row of patch.resources){const resource=resources.find(resource=>resource.key===row.key);if(resource){resource.value=row.value;if(resource.binary&&row.value===1)resource.removable=false;}}
  for(const changed of patch.scores){const position=result.scores.findIndex(score=>score.musicId===changed.musicId&&score.difficulty===changed.difficulty);const score={...(position>=0?result.scores[position]:{playCount:1}),...changed,fullCombo:changed.fullCombo||changed.allBreak};if(position>=0)result.scores[position]=score;else result.scores.push(score);}
  rows.unshift(result);probe.lastSavedId=result.id;return copy(result);
};
window.ogk.cancelPlayerRefresh=()=>{};

const originalGetEditor=window.ogk.getPlayerSaveEditor;
probe.modEnabled=true;probe.queueCalls=0;probe.queueMode='ok';probe.pendingEdit=undefined;
window.ogk.getPlayerSaveEditor=async(...args)=>({...await originalGetEditor(...args),pendingEdit:copy(probe.pendingEdit),gameEditEnabled:probe.modEnabled});
window.ogk.playerSaveEditStatus=async()=>copy(probe.pendingEdit);
window.ogk.queuePlayerSaveEdit=async(root,id,playerId,patch)=>{
 probe.queueCalls++;probe.queueRequest={root,id,playerId,patch:copy(patch)};
 if(probe.queueMode==='wait')await new Promise(resolve=>probe.completeQueue=resolve);
 if(probe.queueMode==='error')throw Error('待应用改动保存失败，请重试。');
 if(profiles.selectedPlayerId!==playerId)throw Error('当前玩家已变化');
 probe.pendingEdit={id:'queued-'+probe.queueCalls,status:'pending',...copy(patch)};return copy(probe.pendingEdit);
};
window.ogk.cancelPlayerSaveEdit=async()=>{probe.pendingEdit=undefined;};
