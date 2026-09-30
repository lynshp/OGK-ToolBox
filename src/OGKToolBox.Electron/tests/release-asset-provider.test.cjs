const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/load-controller-module.cjs');
const { proxyReleaseAsset, createReleaseAssetProvider } = load('electron/release-asset-provider.ts');
const raw = 'https://github.com/lynshp/OGKToolBox-releases/releases/download/v1.1.8/OGK-ToolBox-Setup-1.1.8.exe';
test('only a pinned public release asset from the configured repository is converted', () => {
  assert.equal(proxyReleaseAsset(raw, 'lynshp', 'OGKToolBox-releases'), 'https://gh-proxy.org/' + raw);
  for (const url of [raw.replace('https:', 'http:'), raw + '?token=secret', raw.replace('lynshp', 'someone'),
    raw.replace('github.com', 'github.com.evil.test'), 'https://github.com/lynshp/OGKToolBox-releases/releases.atom',
    'https://api.github.com/repos/lynshp/OGKToolBox-releases/releases/latest']) {
    assert.throws(() => proxyReleaseAsset(url, 'lynshp', 'OGKToolBox-releases'));
  }
});
test('the real GitHub provider preserves the checksum/size and rewrites only the asset URL', () => {
  let proxy = false;
  const Provider = createReleaseAssetProvider(() => {}, () => proxy ? 'https://gh-proxy.org' : undefined);
  const provider = new Provider({ provider: 'custom', owner: 'lynshp', repo: 'OGKToolBox-releases' },
    { channel: null }, { platform: 'win32', executor: {}, isUseMultipleRangeRequest: false });
  const info = { version: '1.1.8', tag: 'v1.1.8', files: [{ url: 'OGK-ToolBox-Setup-1.1.8.exe', sha512: 'trusted-sha512', size: 1234 }] };
  const original = provider.resolveFiles(info)[0]; assert.equal(original.url.href, raw);
  proxy = true;
  const accelerated = provider.resolveFiles(info)[0];
  assert.equal(accelerated.url.href, 'https://gh-proxy.org/' + raw);
  assert.equal(accelerated.info.sha512, original.info.sha512); assert.equal(accelerated.info.size, original.info.size);
  assert.equal(info.files[0].url, 'OGK-ToolBox-Setup-1.1.8.exe');
});
