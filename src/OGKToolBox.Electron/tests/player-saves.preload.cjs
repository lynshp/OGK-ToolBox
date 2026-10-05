require('./character-selection.preload.cjs');
const names = ['BASIC', 'ADVANCED', 'EXPERT', 'MASTER', 'LUNATIC'];
const music = ['00101', 202, 303, 404, 505, 606].map((id, index) => ({
  id, title: ['First Light', 'Starlight Colors', 'After the Rain', 'Unplayed Song', 'Basic Record', 'Zero Score'][index], rating: {isNew: index===1,isBonus:false,charts:names.map((_,difficulty)=>({difficulty,constant:(index===5?6:index===4?7:9+index)+difficulty,platinumMax:2000}))}, artist: 'Fixture Artist', genre: '原创', origin: { packageId: 'A001' }, jacket:{bundlePath:`fixture-cover-${index}`},
  charts: names.map((difficultyName, difficulty) => ({ difficulty, difficultyName, levelConstant: (index===5 ? 6 : index===4 ? 7 : 9+index)+difficulty, filePath: `fixture-${id}-${difficulty}.ogkr`, exists: false }))
}));
window.ogk.thumbnail=async()=> 'data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#7b8faa"/><path d="M0 48 28 18 48 40 64 20V64H0" fill="#d0dbea"/></svg>').toString('base64');
const originalSection = window.ogk.librarySection;
window.ogk.librarySection = async (root, kind, requestId) => kind === 'music' ? structuredClone(music) : originalSection(root, kind, requestId);
const capture = { enabled: false, installed: false, status: '', sessions: 0, canRefresh: false };
const saves = [];
const profiles = { cards: [{ id: 'card-a', accessCode: '12345678901234567890' }], server: { id: 'server-a', label: 'server-a.invalid' }, defaultCardId: 'card-a', configurationError: '', machines: [{ id: 'machine-1', name: '机台 1', values: {dns:{},netenv:{},keychip:{}},server: {id:'server-a',label:'server-a.invalid'},keychipHint:'A123 · ••••••••'}],players:[{id:'player-card-a',name:'玩家 1',machineId:'machine-1',cardId:'card-a'}],selectedPlayerId:'player-card-a',activeMachineId:'machine-1' };
window.ogk.machineProfiles = async () => ({machines:structuredClone(profiles.machines),cards:structuredClone(profiles.cards),activeMachineId:'machine-1',virtualCard:{path:'fixture-card.txt',cardId:'card-a',accessCode:'12345678901234567890'},configurationError:''});
window.ogk.savePlayerProfile = async (_root, request) => { const id=request.id||'player-'+request.cardId;const row={...request,id};const index=profiles.players.findIndex(player=>player.id===id);if(index<0)profiles.players.push(row);else profiles.players[index]=row;return id; };
window.ogk.selectPlayerProfile = async (_root, id) => { const player=profiles.players.find(player=>player.id===id);if(!player)throw new Error('player unavailable');profiles.selectedPlayerId=id;profiles.defaultCardId=player.cardId;profiles.server=profiles.machines.find(machine=>machine.id===player.machineId).server; };
let directId = 0;
window.ogk.addPlayerCard = async (_root, code) => {
  const existing = profiles.cards.find(card => card.accessCode === code); if (existing) return existing.id;
  const card = { id: `card-${profiles.cards.length + 1}`, accessCode: code }; profiles.cards.push(card); return card.id;
};
window.ogk.reorderPlayerCards = async (_root, ids) => { profiles.cards = ids.map(id => profiles.cards.find(card => card.id === id)); };
window.ogk.bindPlayerSave = async (_root, id, cardId, serverId) => { saves.find(save => save.id === id).scope = { cardId, serverId }; };
let fail = false;
let readError = false;
let connectionMode = 'ok', cancelPending, completePending;
window.ogk.playerDefaultAccessCode = async () => '12345678901234567890';
window.ogk.fetchConfiguredPlayerSave = async (_root, cardId, serverId) => {
  window.__playerSaveTest.lastAccessCode = profiles.cards.find(card => card.id === cardId).accessCode;
  const scope = { cardId, serverId };
  if (connectionMode === 'error') throw new Error('读卡服务器未接受查询，请检查 Keychip 和卡号。');
  if (connectionMode === 'wait') await new Promise((resolve, reject) => { completePending = () => { cancelPending = undefined; resolve(); }; cancelPending = () => { cancelPending = undefined; completePending = undefined; reject(new Error('已取消获取，原存档保留。')); }; });
  const previous = saves.find(save => save.scope?.cardId === cardId && save.scope.serverId === serverId);
  if (connectionMode === 'same' && previous) return { ...previous, unchanged: true };
  const save = { id: `fixture-direct-${++directId}`, scope, source: 'direct', playerName: '直接获取测试', updatedAt: '2026-09-30T09:00:00Z', scores: [{ musicId: 101, difficulty: 3, techScore: 1005000, battleScore: 0, platinumScore: 500, playCount: 7, fullCombo: true, fullBell: true, allBreak: false }], collections: [], warnings: [] };
  saves.unshift(save); return save;
};
window.ogk.playerSaves = async () => { if (readError) throw new Error('fixture read failure'); return { saves: structuredClone(saves), capture: { ...capture }, profiles: structuredClone(profiles) }; };
window.ogk.importPlayerSave = async (_root, _serverId, playerId) => {
  if (fail) throw new Error('文件不是有效的 JSON，原有存档未改动。');
  const player=profiles.players.find(player=>player.id===playerId),serverId=profiles.machines.find(machine=>machine.id===player?.machineId)?.server?.id;
  if(!player||!serverId)throw new Error('import player unavailable');
  window.__playerSaveTest.importTarget=playerId;
  const save = { id: 'fixture-json', serverId, scope: { serverId, cardId: player.cardId }, source: 'json', playerName: '测试玩家', newPlayerRating: 16543, updatedAt: '2026-10-01T12:00:00Z', scores: [
      { musicId:101,difficulty:2,techScore:841927,fullCombo:false,fullBell:false,allBreak:false },
      { musicId:101,difficulty:3,techScore:1000000,platinumScoreStar:6,platinumScore:1980,fullCombo:true,fullBell:false,allBreak:false },
      { musicId:202,difficulty:2,techScore:950000,platinumScore:1960,fullCombo:true,fullBell:false,allBreak:false },
      { musicId:303,difficulty:3,techScore:1007000,platinumScoreStar:4,platinumScore:1950,fullCombo:false,fullBell:true,allBreak:true },
      { musicId:505,difficulty:0,techScore:700000,platinumScore:1800,fullCombo:false,fullBell:true,allBreak:false },
      { musicId:606,difficulty:2,techScore:0,platinumScore:0,fullCombo:false,fullBell:false,allBreak:false }
    ], recentPlaysRecorded:true, recentPlays:Array.from({length:12},(_,i)=>({musicId:[101,202,303,404,505,606][i%6],difficulty:i===0 ? 2 : i%2 ? i%5 : undefined,techScore:i===0 ? 821000 : i===1 ? 0 : undefined,playedAt:new Date(Date.UTC(2026,8,30,12,30-i)).toISOString()})), collections: [{ name: 'userCardList', count: 5 }, { name: 'userCharacterList', count: 17 }, { name: 'userItemList', count: 123 }, { name: 'userTrophyList', count: 0 }, { name: 'userDeckList', count: 3 }, { name: 'userMusicList', count: 55 }, { name: 'MusicDetails', count: 56 }], warnings: ['仅展示文件中提供的数据；未验证服务器存档是否完整。'] };
  save.inventory = { version: 1, cardCount: 5, itemsRecorded: true, items: [
    { itemKind: 13, itemId: 1, name: '强化道具（小）', stock: 12 },
    { itemKind: 13, itemId: 2, name: '强化道具（大）', stock: 3 },
    { itemKind: 12, itemId: 1, stock: 2 },
    { itemKind: 12, itemId: 2, stock: 5 },
    { itemKind: 14, itemId: 1, name: '亲密度礼物（小）', stock: 0 },
    { itemKind: 11, itemId: 2, name: '五连抽卡券' },
    { itemKind: 99, itemId: 999, stock: 3, isValid: false },
    ...Array.from({ length: 52 }, (_, i) => ({ itemKind: 3, itemId: i + 1, name: `测试称号 ${i + 1}`, stock: 1 }))
  ] };
  saves.unshift(save); return save;
};
let captureMode = '', releaseCapture;
const captureCalls = [];
window.ogk.setPlayerCapture = async (_root, enabled) => {
  captureCalls.push({ root: _root, enabled });
  if (captureMode === 'error') throw new Error('请先退出游戏，再安装采集模块。');
  if (captureMode === 'wait') await new Promise(resolve => { releaseCapture = resolve; });
  capture.enabled = enabled; capture.installed = true; capture.updateAvailable = false; return { ...capture };
};
window.ogk.refreshPlayerSave = async (_root, id, cardId, serverId) => {
  const original = saves.find(save => save.id === id && save.scope?.cardId === cardId && save.scope?.serverId === serverId);
  window.__playerSaveTest.lastSession = original?.sessionId;
  if (!original) throw new Error('fixture unavailable');
  const save = { ...original, id: 'fixture-refreshed', source: 'direct' }; saves.unshift(save); return save;
};
window.ogk.cancelPlayerRefresh = () => cancelPending?.();
window.ogk.exportPlayerSave = async () => true;
window.ogk.deletePlayerSaves = async (_root, ids, scope) => {
  window.__playerSaveTest.deleteCalls++;
  if (window.__playerSaveTest.deleteFailure) throw new Error('fixture deletion failure');
  for (const id of ids) { const index = saves.findIndex(save => save.id === id); if (index >= 0) saves.splice(index, 1); }
};
window.__playerSaveTest = {
  captureCalls: () => structuredClone(captureCalls), capture: () => ({ ...capture }),
  captureMode: value => { captureMode = value; }, completeCapture: () => { captureMode = ''; releaseCapture?.(); releaseCapture = undefined; },
  deleteCalls: 0, deleteFailure: false,
  complete: () => completePending?.(),
  profiles: () => structuredClone(profiles),
  server: id => { profiles.server = { id, label: `${id}.invalid` }; profiles.machines[0].server=profiles.server; },
  addOtherImport: () => saves.unshift({ id:'other-import',serverId:'server-b',source:'json',playerName:'另一服务器导入',updatedAt:'2026-10-01T10:00:00Z',scores:[],collections:[],warnings:[] }),
  addOtherServer: () => saves.unshift({ id: 'other-server', scope: { cardId: 'card-2', serverId: 'server-b' }, source: 'direct', playerName: '另一服务器玩家', updatedAt: '2026-10-01T09:00:00Z', scores: [{musicId:101,difficulty:3,techScore:999999}],collections:[],warnings:[] }),
  removeSelected: id => saves.splice(saves.findIndex(save=>save.id===id),1),
  readError: value => { readError = value; },
  updateSelectedScore: () => { saves.find(save => save.id === 'fixture-json').scores.find(score => score.musicId === 101 && score.difficulty === 3).techScore = 1000010; },
  fail: () => { fail = true; }, status: value => { capture.status = value; }, mode: value => { connectionMode = value; },
  addCapture: () => { saves.unshift({ id: 'fixture-game', scope: { cardId: 'card-2', serverId: 'server-a' }, source: 'game', sessionId: 'a'.repeat(32), latestCapture: { id: `game-${'a'.repeat(32)}`, at: '2026-10-04T08:00:00Z' }, playerName: '采集测试玩家', updatedAt: '2026-10-04T08:00:00Z', scores: [{ musicId: 202, difficulty: 2, techScore: 1004000, fullCombo: true, fullBell: true, allBreak: false }], collections: [], warnings: [] }); capture.canRefresh = true; capture.sessions = 1; }
};

if (process.env.OGK_RATING_UI_TEST === '1') {
  const rows=Array.from({length:125},(_,i)=>({musicId:1000+i,difficulty:i%5,techScore:1000000+i*60,platinumScore:1980,platinumScoreStar:i%7,fullCombo:true,allBreak:i%3===0,fullBell:i%2===0}));
  music.splice(0,music.length,...rows.map((score,i)=>({id:score.musicId,title:['Starlight Colors','星咲あかりの物語 · RE:START','After the Rain','長い曲名の表示テスト / Endless Possibilities'][i%4],artist:'Fixture',genre:'原创',origin:{packageId:'A001'},jacket:{bundlePath:'fixture-rating-'+i},rating:{isNew:i<15,isBonus:false,charts:[{difficulty:score.difficulty,constant:Math.fround(13+i%20/10),platinumMax:2000}]},charts:[{difficulty:score.difficulty,levelConstant:13+i%20/10,filePath:'fixture-'+i,exists:false}]})));
  saves.push({id:'rating-full',scope:{serverId:'server-a',cardId:'card-a'},source:'json',playerName:'Rating 测试玩家',newPlayerRating:16875,updatedAt:'2026-10-01T12:00:00Z',scores:rows,recentPlaysRecorded:true,recentPlays:rows.slice(0,10).map((score,i)=>({musicId:score.musicId,playedAt:new Date(Date.UTC(2026,9,1,12,i)).toISOString()})),collections:[],warnings:[],inventory:{version:1,cardCount:312,itemsRecorded:true,items:[{itemKind:3,itemId:1,stock:1},{itemKind:12,itemId:1,stock:30},{itemKind:13,itemId:1,stock:125},{itemKind:14,itemId:1,stock:80}]}});
  window.__playerSaveTest.ratingMissing=()=>{saves[0].scores.push({musicId:9999,difficulty:3,techScore:1000000});delete saves[0].newPlayerRating;};
}
