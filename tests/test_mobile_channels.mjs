import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSource, developmentUrl, fetchSourceManifest, sourceKey, releaseEndpoint } from '../mobile/src/channels.js';
import { NATIVE_REVISION, validateManifest } from '../mobile/src/update.js';

const version = 'a'.repeat(64);
const manifest = { schema: 1, appId: 'app.linguatrack.mobile', nativeRevision: NATIVE_REVISION,
  version, checksum: 'b'.repeat(64), bundle: `bundle-${version}.zip`, size: 50 };
function release(preview = false) {
  const tag = preview ? 'pre-release' : 'v1.2.0';
  return { tag_name: tag, prerelease: preview, draft: false, assets: ['manifest.json', manifest.bundle].map((name, id) => ({
    id, name, browser_download_url: `https://github.com/RzMY/Lingua/releases/download/${tag}/${name}`,
  })) };
}
test('stable is the zero-configuration default; own and development have separate address rules', () => {
  assert.equal(normalizeSource().channel, 'stable');
  assert.equal(normalizeSource({ channel: 'bad' }).channel, 'stable');
  assert.throws(() => normalizeSource({ channel: 'own', ownUrl: 'http://host/' }));
  assert.equal(developmentUrl('http://192.168.1.2:5173/player.html?debug=1#foo'), 'http://192.168.1.2:5173/player.html?debug=1#foo');
  for (const url of ['javascript:alert(1)', 'file:///private', 'https://user:pw@host/']) assert.throws(() => developmentUrl(url));
  assert.notEqual(sourceKey({ channel: 'stable' }), sourceKey({ channel: 'preview' }));
});
for (const channel of ['stable', 'preview']) {
  test(`${channel} resolves matching GitHub release and binds manifest and ZIP to its assets`, async () => {
    const calls = [];
    const result = await fetchSourceManifest({ channel }, async (url) => {
      calls.push(url); return calls.length === 1 ? release(channel === 'preview') : manifest;
    });
    assert.equal(calls[0], releaseEndpoint(channel));
    assert.match(calls[1], /manifest.json\?asset=0$/);
    assert.equal(validateManifest(result.data, result.manifestUrl, result.bundleUrl).version, version);
    assert.match(result.bundleUrl, new RegExp(`/releases/download/${channel === 'preview' ? 'pre-release' : 'v1.2.0'}/`));
  });
}
test('self-hosted channel reads its mobile manifest and never queries GitHub', async () => {
  const result = await fetchSourceManifest({ channel: 'own', ownUrl: 'https://mine.example/lingua/' }, async (url) => {
    assert.equal(url, 'https://mine.example/lingua/mobile/manifest.json'); return manifest;
  });
  assert.match(validateManifest(result.data, result.manifestUrl).url, /mine.example\/lingua\/mobile\/bundle-/);
});
test('development channel cannot download or fall back through the update resolver', async () => {
  await assert.rejects(fetchSourceManifest({ channel: 'development' }, () => assert.fail('must not fetch')), /直接加载/);
});
test('missing/incomplete/cross-repository assets and mismatched release types are rejected', async () => {
  for (const bad of [{ ...release(), draft: true }, { ...release(), prerelease: true },
    { ...release(), assets: [] }, { ...release(), assets: [{ name: 'manifest.json', browser_download_url: 'https://evil.example/manifest.json' }] }]) {
    await assert.rejects(fetchSourceManifest({ channel: 'stable' }, async () => bad));
  }
  await assert.rejects(fetchSourceManifest({ channel: 'preview' }, async () => release(false)));
  assert.throws(() => validateManifest(manifest, 'https://github.com/RzMY/Lingua/releases/download/v1/manifest.json',
    `https://github.com/RzMY/Other/releases/download/v1/${manifest.bundle}`));
});
