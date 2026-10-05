const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const file = path.join(__dirname, '../src/player-library.ts'), loaded = new Module(file, module);
loaded._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, file);
const { musicScore, sortPlayerMusic, formatChartConstant } = loaded.exports;
const songs = [1,2,3,4,5,6].map(id=>({id,charts:[{difficulty:2,levelConstant:id===6?'':10+id},{difficulty:3,levelConstant:20-id}]}));
const scores = new Map([
  ['1:2',{musicId:1,difficulty:2,techScore:841927}],['1:3',{musicId:1,difficulty:3,techScore:1000000}],
  ['2:2',{musicId:2,difficulty:2,techScore:950000}],['3:3',{musicId:3,difficulty:3,techScore:1007000}],
  ['5:0',{musicId:5,difficulty:0,techScore:700000}],['6:2',{musicId:6,difficulty:2,techScore:0}]
]);
test('score sort groups preferred difficulty first, keeps zero score, leaves unplayed last',()=>{
  assert.deepEqual(sortPlayerMusic(songs,'score',2,scores).map(m=>m.id),[2,1,6,3,5,4]);
  assert.deepEqual(sortPlayerMusic(songs,'score',3,scores).map(m=>m.id),[3,1,2,6,5,4]);
  assert.equal(musicScore(scores,'00001',2).techScore,841927);
  assert.equal(musicScore(scores,3,2).difficulty,3);
  assert.equal(musicScore(scores,4,2),undefined);
  assert.deepEqual(sortPlayerMusic(songs,'score',2,new Map()).map(m=>m.id),[1,2,3,4,5,6]);
});
test('constant sort uses only selected difficulty and keeps missing values at the end',()=>{
  assert.deepEqual(sortPlayerMusic(songs,'constant',2,scores).map(m=>m.id),[5,4,3,2,1,6]);
  assert.deepEqual(sortPlayerMusic(songs,'constant',3,scores).map(m=>m.id),[1,2,3,4,5,6]);
  assert.deepEqual(sortPlayerMusic(songs,'default',2,scores).map(m=>m.id),[1,2,3,4,5,6]);
});

test('chart constant labels hide float32 tails but retain decimal hundredths and the original calculation value', () => {
  const constant = Math.fround(12.9);
  assert.notEqual(constant, 12.9);
  assert.equal(formatChartConstant(constant), '12.9');
  assert.equal(formatChartConstant(Math.fround(12.75)), '12.75');
  assert.equal(formatChartConstant(12), '12.0');
  assert.equal(formatChartConstant(undefined), '—');
  assert.equal(formatChartConstant(NaN), '—');
  assert.equal(formatChartConstant(Infinity), '—');
  assert.equal(constant, Math.fround(12.9));
});
