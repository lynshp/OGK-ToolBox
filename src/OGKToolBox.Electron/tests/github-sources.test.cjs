const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/load-controller-module.cjs');
const asset = 'https://github.com/lynshp/OptionPackage/releases/download/option/pack.zip';
function fixture(options = {}) {
  const calls = []; let saved;
  const { GithubSources } = load('electron/github-sources.ts', {
    electron: { app: { getPath: () => '/fixture' }, session: { fromPartition: name => ({
      setProxy: async config => { assert.equal(config.mode, 'direct'); },
      fetch: async (url, init) => { calls.push({ route: name, url, init }); return options.direct ? options.direct(url, init) : new Response('{}'); }
    }) } },
    'node:fs/promises': { readFile: async () => saved || options.saved || '{}', writeFile: async (_, value) => { saved = value; } },
    './fastgithub-manager': { fastGithubManager: { fetch: async (url, init, required) => {
      calls.push({ route: 'fastgithub', url, required }); if (options.fastFail) throw Error('fast failed'); return new Response('{}');
    } } }
  }, { Headers, Response });
  return { sources: new GithubSources(), restart: () => new GithubSources(), calls, saved: () => saved };
}
test('saved settings govern metadata for both release API and raw package manifests', async () => {
  const f = fixture(); await f.sources.save('github', 'origin');
  await f.sources.fetch('https://api.github.com/repos/lynshp/OptionPackage/releases/tags/option');
  await f.sources.fetch('https://raw.githubusercontent.com/lynshp/OptionPackage/main/manifest.json');
  assert.ok(f.calls.every(call => call.route === 'ogk-github-direct'));
  assert.equal(JSON.parse(f.saved()).source, 'github');
});
test('auto metadata falls back to native; explicit FastGithub does not silently switch', async () => {
  const f = fixture({ fastFail: true }); await f.sources.fetch('https://api.github.com/repos/a/b');
  assert.equal(f.calls.length, 2);
  await f.sources.save('fastgithub', 'origin'); f.calls.length = 0;
  await assert.rejects(f.sources.fetch('https://api.github.com/repos/a/b'), /前往设置/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].required, true);
});
test('all Option/Mod assets use the selected tested GH-Proxy node without forwarding credentials', async () => {
  const f = fixture(); await f.sources.save('ghproxy');
  f.sources.selectAsset = async () => ({ node: 'https://cdn.gh-proxy.org', results: [{ node: 'https://cdn.gh-proxy.org', latencyMs: 1 }] });
  await f.sources.fetch(asset);
  assert.equal(f.calls[0].url, 'https://cdn.gh-proxy.org/' + asset);
  f.calls.length = 0;
  await assert.rejects(f.sources.fetch(asset, { headers: { Authorization: 'Bearer private' } }), /前往设置/);
  assert.equal(f.calls.length,0,'Authenticated traffic must never be sent to a third party');
});
test('failed node responses try another tested node only before a body is handed to the caller', async () => {
  const f = fixture({ direct: async url => new Response('bytes', { status: url.startsWith('https://v4.') ? 502 : 200 }) });
  await f.sources.save('ghproxy');
  f.sources.selectAsset = async () => ({ results: [{ node: 'https://v4.gh-proxy.org', latencyMs: 1 }, { node: 'https://cdn.gh-proxy.org', latencyMs: 2 }] });
  const response = await f.sources.fetch(asset); assert.equal(await response.text(), 'bytes'); assert.equal(f.calls.length, 2);
});

test('shared source settings survive creating a new manager', async () => {
  const f = fixture(); await f.sources.save('ghproxy');
  const restarted = f.restart(); await restarted.load();
  assert.equal(restarted.get().source, 'ghproxy');
  assert.equal(restarted.get().downloadSource, 'auto');
});
test('all proxy nodes failing falls back only in automatic asset mode', async () => {
  const f = fixture();
  f.sources.selectAsset = async () => ({ results: [{ node: 'https://gh-proxy.org', error: 'HTTP 502' }] });
  await f.sources.save('auto');f.sources.useChannel('ghproxy');
  await f.sources.fetch(asset);
  assert.equal(f.calls[0].url, asset);
  await f.sources.save('ghproxy'); f.calls.length = 0;
  await assert.rejects(f.sources.fetch(asset), /所有节点检测失败/);
  assert.equal(f.calls.length, 0);
});

test('GH-Proxy covers raw and API metadata as well as installer assets', async () => {
  const f=fixture();await f.sources.save('ghproxy');
  await f.sources.fetch('https://api.github.com/repos/a/b/releases/latest');
  await f.sources.fetch('https://raw.githubusercontent.com/a/b/main/manifest.json');
  assert.ok(f.calls.every(call=>call.url.startsWith('https://gh-proxy.org/https://')));
});
test('GH-Proxy version probe rejects HTML and requires an executable asset response', async () => {
  const f=fixture({direct:async(url,init)=>init.headers?.Range ? new Response(new Uint8Array([77,90])) : new Response(url.startsWith('https://v4.')?'<html>error</html>':'version: 1.2.3\nfiles:\n  - url: Setup.exe\n    sha512: test\n')});
  const result=await f.sources.probeMetadata('https://github.com/a/b/releases/latest/download/latest.yml');
  assert.ok(result.node);assert.equal(result.results.length,5);
  assert.ok(result.results.find(row=>row.node==='https://v4.gh-proxy.org').error);
});

test('legacy split preferences migrate to default auto; new manual preference persists', async () => {
  const f=fixture({saved:JSON.stringify({source:'fastgithub',downloadSource:'ghproxy'})});
  await f.sources.load();assert.equal(f.sources.get().source,'auto');
  await f.sources.save('ghproxy');const restarted=f.restart();await restarted.load();
  assert.equal(restarted.get().source,'ghproxy');
});

test('GH-Proxy returns its first validated node before stalled nodes finish', async () => {
  let release; const gate=new Promise(resolve=>release=resolve);const updates=[];
  const f=fixture({direct:async(url,init)=>{
    if(!url.startsWith('https://gh-proxy.org/'))await gate;
    return init.headers?.Range?new Response(new Uint8Array([77,90])):new Response('version: 1.2.3\nfiles:\n  - url: Setup.exe\n    sha512: test\n');
  }});
  let result;
  const task=f.sources.probeMetadata('https://github.com/a/b/releases/latest/download/latest.yml',rows=>updates.push(rows)).then(value=>result=value);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(result?.node,'https://gh-proxy.org');assert.equal(result.results.length,1);
  release();await task;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(updates.at(-1).length,5);
});
