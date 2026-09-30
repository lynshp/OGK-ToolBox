const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/load-controller-module.cjs');
const feed = { owner: 'lynshp', repo: 'OGKToolBox-releases', privateFeed: false };
function network(fetch, globals = {}) {
  return load('electron/update-network.ts', {
    electron: { session: { fromPartition: name => { assert.equal(name, 'ogk-update-probe-direct'); return { fetch, setProxy: async () => {} }; } } },
    './fastgithub-manager': {}
  }, globals);
}
test('probe reads the real channel metadata and bypasses HTTP caches', async () => {
  const n = network(async (url, init) => {
    assert.match(url, /releases\/latest\/download\/latest.yml$/); assert.equal(init.cache, 'no-store');
    return new Response('version: 1.1.8');
  });
  assert.ok(await n.probeUpdateChannel(feed) >= 0);
});
test('HTTP errors and invalid 200 HTML are not reported as reachable', async () => {
  await assert.rejects(network(async () => new Response('', { status: 404 })).probeUpdateChannel(feed), /HTTP 404/);
  await assert.rejects(network(async () => new Response('<html>login</html>')).probeUpdateChannel(feed), /内容无效/);
});
test('the deadline includes a stalled body, not just response headers', async () => {
  const n = network(async (_url, { signal }) => ({ ok: true, text: () => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  }) }), { setTimeout: fn => setTimeout(fn, 5) });
  await assert.rejects(n.probeUpdateChannel(feed), /连通检测超时/);
});
