const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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
  m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, file);
  return m.exports;
}
const { playerUploadPolicyForServer, getPlayerUploadPolicy, requirePlayerScoreUpload } = load('player-upload-policy');
const { playerProfiles } = load('player-profiles');

test('only the configured canonical MuNET game hostname enables direct score upload', () => {
  for (const server of ['play.mumur.net', 'https://play.mumur.net/', 'http://PLAY.MUMUR.NET', ' play.mumur.net. ', 'https://play.mumur.net:443/']) {
    assert.deepEqual(playerUploadPolicyForServer(server), { scoreUpload: 'direct', frontendService: 'munet', serverHost: 'play.mumur.net' });
    assert.equal(requirePlayerScoreUpload(server).scoreUpload, 'direct');
  }
});
test('other known game hosts use their existing whitelisted Net frontend', () => {
  for (const [server, service] of [['nageki-net.com', 'nageki'], ['https://NAGEKI-NET.COM/', 'nageki'], ['ea.naominet.live', 'rinnet'], ['http://aqua.naominet.live/', 'rinnet']]) {
    const policy = playerUploadPolicyForServer(server);
    assert.equal(policy.scoreUpload, 'frontend'); assert.equal(policy.frontendService, service);
    assert.throws(() => requirePlayerScoreUpload(server), /成绩仅保存本地.*Net 前端/);
  }
});
test('domain substrings, frontend/Aime hosts and custom servers never enable direct score upload', () => {
  for (const server of ['play.mumur.net.attacker.invalid', 'sub.play.mumur.net', 'munet.invalid', 'mumur.net', 'portal.mumur.net', 'aime.mumur.net', '127.0.0.1:3000', '[::1]:3000', 'custom.invalid']) {
    const policy = playerUploadPolicyForServer(server);
    assert.equal(policy.scoreUpload, 'frontend'); assert.equal(policy.frontendService, null);
    assert.throws(() => requirePlayerScoreUpload(server), /成绩仅保存本地/);
  }
});
test('malformed URLs and normalized URL escape tricks stay local without disclosing configured values', () => {
  for (const server of ['', 'ftp://play.mumur.net', '//play.mumur.net', 'https://play.mumur.net@attacker.invalid', 'https://user:secret@play.mumur.net', 'https://play.mumur.net/game', 'play.mumur.net?x=1', 'https://play.mumur.net#x', 'http://play.mumur.net%2e', 'http://play.mumur.net\\', 'play.mu\nmur.net', 'https://play.mumur.net:bad/']) {
    assert.deepEqual(playerUploadPolicyForServer(server), { scoreUpload: 'frontend', frontendService: null, serverHost: '' });
  }
  assert.deepEqual(playerUploadPolicyForServer(null), { scoreUpload: 'frontend', frontendService: null, serverHost: '' });
});
test('main-process policy binds to the saved player configuration and rejects stale/forged scope', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ogk-upload-policy-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^ogk-upload-policy-/); await fsp.rm(root, { recursive: true, force: true }); });
  await fsp.mkdir(path.join(root, 'DEVICE')); await fsp.writeFile(path.join(root, 'DEVICE', 'aime.txt'), '12345678901234567890');
  await fsp.writeFile(path.join(root, 'segatools.ini'), '[dns]\ndefault=nageki-net.com\n[keychip]\nid=A123-45678901234\n');
  const original = await playerProfiles(root), cardId = original.defaultCardId;
  assert.deepEqual(await getPlayerUploadPolicy(root, cardId, original.server.id), { scoreUpload: 'frontend', frontendService: 'nageki', serverHost: 'nageki-net.com' });
  await assert.rejects(getPlayerUploadPolicy(root, 'unknown', original.server.id), /有效卡号|当前玩家已变化/);
  await assert.rejects(getPlayerUploadPolicy(root, cardId, 'munet'), /服务器配置已变化/);
  await fsp.writeFile(path.join(root, 'segatools.ini'), '[dns]\ndefault=play.mumur.net\n[keychip]\nid=A123-45678901234\n');
  await assert.rejects(getPlayerUploadPolicy(root, cardId, original.server.id), /服务器配置已变化/);
  const next = await playerProfiles(root);
  assert.equal((await getPlayerUploadPolicy(root, cardId, next.server.id)).scoreUpload, 'direct');
});
