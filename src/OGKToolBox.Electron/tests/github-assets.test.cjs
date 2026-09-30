const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/load-controller-module.cjs');
const { proxyNodes, probeProxyNodes } = load('electron/github-assets.ts');
const asset = 'https://github.com/lynshp/OGKToolBox-releases/releases/download/v1.1.8/Setup.exe';
test('all five observed nodes are probed; failing nodes cannot win', async () => {
  const calls = [], signals = [];
  const result = await probeProxyNodes(asset, async (url, init) => {
    calls.push(url); signals.push(init.signal);
    assert.equal(init.headers.Range, 'bytes=0-1'); assert.equal(init.credentials, 'omit');
    if (!url.startsWith('https://cdn.gh-proxy.org/')) return new Response('<html>', { headers: { 'content-type': 'text/html' } });
    return new Response(new Uint8Array([0x4d,0x5a,0]), { status: 200 });
  }, undefined, true);
  assert.equal(calls.length, 5); assert.equal(result.node, 'https://cdn.gh-proxy.org');
  assert.equal(result.results.filter(row => row.error).length, 4);
  assert.ok(signals.every(signal => signal.aborted), 'Even ignored Range requests must stop after probing');
});
test('non-executable Option/Mod assets are accepted but invalid EXE content is rejected', async () => {
  const fetcher = async () => new Response(new Uint8Array([0x50,0x4b]));
  assert.ok((await probeProxyNodes(asset, fetcher)).node);
  assert.equal((await probeProxyNodes(asset, fetcher, undefined, true)).node, undefined);
});
test('user cancellation aborts all node probes', async () => {
  const controller = new AbortController();
  const result = probeProxyNodes(asset, async (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')));
  }), controller.signal);
  controller.abort(); await assert.rejects(result, /取消/);
});
