const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const ts = require('typescript');
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name).exports;
  const file = path.resolve(__dirname, '..', name + '.ts'), m = new Module(file, module);
  m.filename = file; m.paths = module.paths; modules.set(name, m);
  m.require = id => id.startsWith('./') ? load(path.posix.join(path.posix.dirname(name), id)) : require(id);
  m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, file);
  return m.exports;
}
const { technicalRating, platinumRating, platinumStars, best110 } = load('src/player-rating');
const { playerRatingCatalog } = load('electron/player-rating-catalog');
const score = (techScore, extra = {}) => ({ musicId: 101, difficulty: 3, techScore, fullCombo: false, allBreak: false, fullBell: false, ...extra });
const song = (id, isNew = false, constant = 14, extra = {}) => ({ id, title: `Song ${id}`, rating: { isNew, isBonus: false, charts: [0,1,2,3,4].map(difficulty=>({difficulty,constant,platinumMax:2000})), ...extra } });
test('1.50 integer interpolation, score cap and mutually exclusive clear bonuses', () => {
  for (const [value, expected] of [[0,0],[500000,0],[500001,0],[650000,4000],[800000,8000],[900000,10000],[970000,14000],[990000,14850],[1000000,15450],[1007500,16050],[1010000,16300],[1010001,16300]]) assert.equal(technicalRating(score(value),14),expected, String(value));
  assert.equal(technicalRating(score(1000000,{fullCombo:true,fullBell:true}),14),15600);
  assert.equal(technicalRating(score(1010000,{fullCombo:true,allBreak:true,fullBell:true}),14),16700);
  assert.equal(technicalRating(score(1007500,{fullCombo:true,allBreak:true}),14),16350);
  assert.equal(technicalRating(score(800000,{fullCombo:true,allBreak:true,fullBell:true}),14),8000);
  assert.equal(technicalRating(score(1000000,{techScoreRank:9}),14),15250);
  assert.equal(technicalRating(score(500001),1),0);
  assert.equal(technicalRating(score(1000000),Math.fround(14.7)),16150);
});
test('platinum uses float32 constants, five stars for enum six, and a theoretical denominator', () => {
  assert.equal(platinumStars(score(1000000,{platinumScoreStar:6})),5);
  assert.equal(platinumStars(score(1000000,{platinumScoreStar:0})),0);
  assert.equal(platinumStars(score(1000000)),undefined);
  for (const [points, expected] of [[1879,0],[1880,1],[1900,2],[1920,3],[1940,4],[1960,5],[1980,5]]) assert.equal(platinumStars(score(1000000,{platinumScore:points}),2000),expected);
  assert.equal(platinumRating(score(500000),14,5),0);
  assert.equal(platinumRating(score(1000000),14,5),980);
  // 14.2 is slightly smaller in float32: five stars produce 1008, not 1008.2 rounded.
  assert.equal(platinumRating(score(1000000),14.2,5),1008);
  assert.equal(platinumRating(score(1000000),13.4,5),897);
});
test('BEST 110 uses fixed divisors, new-song truncation and per-chart candidates including lunatic', () => {
  const result = best110([score(1000000,{fullCombo:true,fullBell:true,platinumScoreStar:5}),score(950000,{musicId:202,fullCombo:true,platinumScoreStar:5,difficulty:4})],[song(101),song(202,true,12)]);
  assert.deepEqual(result.groups.map(g=>g.entries.length),[1,1,2]);
  assert.deepEqual(result.groups.map(g=>g.contribution1000),[312,219,34]);
  assert.equal(result.groups[1].entries[0].rate1000,2191);
  assert.equal(result.total,0.565);
  const all = Array.from({length:125},(_,i)=>score(1000000,{musicId:100+i,platinumScoreStar:5}));
  const library = all.map((s,i)=>song(s.musicId,i<15));
  assert.deepEqual(best110(all,library).groups.map(g=>g.entries.length),[50,10,50]);
});
test('eligibility, missing metadata and unknown platinum remain distinct from zero', () => {
  const inputs = [score(1000000,{musicId:1}),score(1000000,{musicId:2}),score(1000000,{musicId:3}),score(1000000,{musicId:4}),score(1000000,{musicId:5})];
  const library = [song(1),song(2,false,14,{isBonus:true}),song(3,false,0),song(4),song(5,false,14,{isNew:undefined})];
  const result = best110(inputs,library);
  assert.equal(result.total,undefined);
  assert.deepEqual(result.groups.map(g=>g.entries.length),[1,0,0]);
  assert.deepEqual(result.groups.map(g=>g.missing),[1,1,2]);
  assert.equal(best110([score(0)],[song(101)]).total,0);
  assert.equal(best110([score(1000000)],[]).complete,false);
});
test('ties use the game comparator: lower technical score then higher constant', () => {
  const s = [score(1000000,{musicId:10,techScoreRank:9}),score(990000,{musicId:20,techScoreRank:9})];
  assert.deepEqual(best110(s,[song(10,false,14),song(20,false,14.5)]).groups[0].entries.map(e=>Number(e.music.id)),[20,10]);
});
test('catalog follows compatible package precedence, version IDs and chart header, not package name', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(),'ogk-rating-test-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('ogk-rating-test-'));await fsp.rm(root,{recursive:true,force:true});});
  const base = path.join(root,'mu3_Data/StreamingAssets/GameData/A000'), option = path.join(root,'option/A001'), duplicate = path.join(root,'mu3_Data/StreamingAssets/GameData/A001'), incompatible = path.join(root,'option/A002');
  const write = async (file,text)=>{await fsp.mkdir(path.dirname(file),{recursive:true});await fsp.writeFile(file,text);};
  for (const [directory,minor] of [[base,50],[option,50],[duplicate,50],[incompatible,45]]) await write(path.join(directory,'DataConfig.xml'),`<DataConfig><version><major>1</major><minor>${minor}</minor></version></DataConfig>`);
  for (const [id,minor] of [[1050,50],[1045,45]]) await write(path.join(base,`version/version${id}/Version.xml`),`<VersionData><Name><id>${id}</id></Name><Major>1</Major><Minor>${minor}</Minor></VersionData>`);
  const xml = (id,version,bonus=false,file='chart.ogkr')=>`<MusicData><Name><id>${id}</id></Name><VersionID><id>${version}</id></VersionID><IsBonusTrack>${bonus}</IsBonusTrack><FumenData><FumenData><FumenConstIntegerPart>14</FumenConstIntegerPart><FumenConstFractionalPart>20</FumenConstFractionalPart><FumenFile><path>${file}</path></FumenFile></FumenData></FumenData></MusicData>`;
  await write(path.join(base,'music/music10/Music.xml'),xml(10,1050));
  await write(path.join(base,'music/music10/chart.ogkr'),'[HEADER]\nT_TOTAL\t1000\nT_BELL\t100\n[B_PALETTE]\n');
  await write(path.join(option,'music/music20/Music.xml'),xml(20,1045));
  await write(path.join(option,'music/music20/chart.ogkr'),'[HEADER]\nT_BELL\t100\n');
  await write(path.join(duplicate,'music/music20/Music.xml'),xml(20,1050,true));
  await write(path.join(incompatible,'music/music30/Music.xml'),xml(30,1050));
  await write(path.join(base,'music/music40/Music.xml'),xml(40,1050,false,'../../outside.ogkr'));
  await write(path.join(base,'outside.ogkr'),'[HEADER]\nT_TOTAL\t1000\n');
  const catalog = await playerRatingCatalog(root,[{numericId:10,packageId:'A000'},{numericId:20,packageId:'A001'},{numericId:30,packageId:'A002'},{numericId:40,packageId:'A000'}]);
  assert.equal(catalog.get(10).isNew,true); assert.equal(catalog.get(10).charts[0].constant,Math.fround(14.2)); assert.equal(catalog.get(10).charts[0].platinumMax,2000);
  assert.equal(catalog.get(20).isNew,false); assert.equal(catalog.get(20).isBonus,false); assert.equal(catalog.get(20).charts[0].platinumMax,undefined);
  assert.equal(catalog.has(30),false);assert.equal(catalog.get(40).charts[0].platinumMax,undefined);
  const controller = new AbortController();controller.abort();await assert.rejects(playerRatingCatalog(root,[],controller.signal),/abort/i);
});
