const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { randomFillSync } = require('node:crypto');
const Module = require('node:module');
const ts = require('typescript');
function load(name) {
  const file = path.resolve(__dirname, '..', name + '.ts'), m = new Module(file, module);
  m.filename = file; m.paths = module.paths;
  m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, file);
  return m.exports;
}
const { decodePlayerScoreImage, playerScoreImageFileName, savePlayerScoreImage } = load('electron/player-score-image');
const { scoreImageGrade } = load('src/player-score-image');
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const buffer = Buffer.alloc(data.length + 12);
  buffer.writeUInt32BE(data.length); buffer.write(type, 4); data.copy(buffer, 8);
  buffer.writeUInt32BE(crc32(buffer.subarray(4, -4)), buffer.length - 4);
  return buffer;
}
function png(width = 1, height = 1, pixels = Buffer.from([0, 255, 0, 0, 255])) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const request = buffer => ({ dataUrl: 'data:image/png;base64,' + buffer.toString('base64') });
test('score-image save accepts canvas PNG and rejects corrupt, oversized or disguised payloads before opening a dialog', async () => {
  const valid = png(); assert.deepEqual(decodePlayerScoreImage(request(valid)), valid);
  const stride = 1024 * 4 + 1, largeRaw = randomFillSync(Buffer.alloc(stride * 1536));
  for (let row = 0; row < largeRaw.length; row += stride) largeRaw[row] = 0;
  const large = png(1024, 1536, largeRaw); assert.ok(large.length > 5 * 1024 * 1024);
  assert.equal(decodePlayerScoreImage(request(large)).length, large.length);
  const corrupt = Buffer.from(valid); corrupt[corrupt.length - 5] ^= 1;
  const invalid = [null, {}, { dataUrl:'data:image/jpeg;base64,AAAA' }, { dataUrl:'data:image/png;base64,AAAA!' }, request(corrupt), request(valid.subarray(0, -12)), request(Buffer.concat([valid, Buffer.from([0])])), request(png(8193)), request(png(8000, 8000)), request(png(1, 1, Buffer.from([5, 255, 0, 0, 255]))), request(png(1, 1, Buffer.alloc(500)))];
  let dialogs = 0;
  for (const value of invalid) await assert.rejects(savePlayerScoreImage(value, async () => { dialogs++; return null; }), /成绩图/);
  assert.equal(dialogs, 0);
});
test('score-image save cancellation creates no file; successful save preserves PNG bytes and write failures propagate', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ogk-score-image-test-'));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('ogk-score-image-test-')); await fsp.rm(directory, { recursive: true, force: true }); });
  const value = request(png()), target = path.join(directory, 'poster.png');
  assert.equal(await savePlayerScoreImage(value, async fileName => { assert.equal(fileName, 'ongeki-best110.png'); return null; }), false);
  assert.deepEqual(await fsp.readdir(directory), []);
  assert.equal(await savePlayerScoreImage(value, async () => target), true);
  assert.deepEqual(await fsp.readFile(target), png());
  await assert.rejects(savePlayerScoreImage(value, async () => path.join(directory, 'poster.jpg')), /\.png/);
  await assert.rejects(savePlayerScoreImage(value, async () => path.join(directory, 'absent', 'poster.png')), /ENOENT/);
});
test('score-image default filenames remove traversal, unsafe characters and Windows device names', () => {
  assert.equal(playerScoreImageFileName('C:\\private\\best110.png'), 'best110.png');
  assert.equal(playerScoreImageFileName('../../best110.png'), 'best110.png');
  assert.equal(playerScoreImageFileName('CON.png'), 'ongeki-best110.png');
  assert.equal(playerScoreImageFileName('LPT1.player.png'), 'ongeki-best110.png');
  assert.equal(playerScoreImageFileName('best:110?.PNG'), 'best_110_.png');
  assert.equal(playerScoreImageFileName('..'), 'ongeki-best110.png');
});
test('score-image grades preserve stored rank; missing lower ranks stay explicit', () => {
  assert.equal(scoreImageGrade({techScore:1009000,techScoreRank:10}), 'SS');
  assert.equal(scoreImageGrade({techScore:1007500}), 'SSS+');
  assert.equal(scoreImageGrade({techScore:1000000}), 'SSS');
  assert.equal(scoreImageGrade({techScore:990000}), 'SS');
  assert.equal(scoreImageGrade({techScore:989999}), '—');
  assert.equal(scoreImageGrade({techScore:900000,techScoreRank:7}), '—');
});
