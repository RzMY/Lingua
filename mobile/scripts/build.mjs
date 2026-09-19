import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { NATIVE_REVISION } from '../src/update.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = resolve(root, 'mobile/www');
const release = resolve(root, 'web/mobile');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function files(dir) {
  const result = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (['data', 'mobile'].includes(item.name) || item.name === 'audio-check.html'
        || item.name === 'audio-probe.wav') continue;
    const path = resolve(dir, item.name);
    if (item.isDirectory()) result.push(...await files(path));
    else if (item.isFile()) result.push(path);
  }
  return result.sort();
}
// The only removed directory is this script's fixed, generated workspace output.
if (relative(root, out) !== 'mobile\\www' && relative(root, out) !== 'mobile/www') throw Error('Invalid output');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const path of await files(resolve(root, 'web'))) {
  const dest = resolve(out, relative(resolve(root, 'web'), path));
  await mkdir(resolve(dest, '..'), { recursive: true });
  const source = await readFile(path);
  await writeFile(dest, /\.(?:html|css|js|mjs|json|svg|txt|md)$/.test(path)
    ? source.toString('utf8').replaceAll('\r\n', '\n') : source);
}
await build({ entryPoints: [resolve(root, 'mobile/src/runtime.js')], outfile: resolve(out, 'native.js'),
  absWorkingDir: root, bundle: true, format: 'esm', target: ['safari15.4', 'chrome109'] });
for (const page of ['index.html', 'player.html']) {
  const path = resolve(out, page);
  const html = await readFile(path, 'utf8');
  // Gate entry-point evaluation, including its imports, until native preferences are available.
  await writeFile(path, html.replace(/<script type="module" src="(js\/(?:home|main)\.js)"><\/script>/,
    '<script type="module">import { ready } from "./native.js"; await ready; await import("./$1");</script>'));
}
const archive = {};
for (const path of await files(out)) archive[relative(out, path).replaceAll('\\', '/')] = new Uint8Array(await readFile(path));
const version = hash(Buffer.concat(Object.entries(archive).map(([name, bytes]) => Buffer.concat([Buffer.from(name + '\0'), Buffer.from(bytes)]))));
const meta = { schema: 1, appId: 'app.linguatrack.mobile', nativeRevision: NATIVE_REVISION, version };
const metaBytes = Buffer.from(JSON.stringify(meta));
archive['native-bundle.json'] = metaBytes;
await writeFile(resolve(out, 'native-bundle.json'), metaBytes);
if (process.argv.includes('--release')) {
  const zip = zipSync(archive, { level: 6, mtime: new Date(2020, 0, 1, 0, 0, 0) });
  await mkdir(release, { recursive: true });
  const filename = `bundle-${version}.zip`;
  await writeFile(resolve(release, filename), zip);
  // Publish the manifest last. Existing versioned archives stay valid for in-flight downloads.
  await writeFile(resolve(release, 'manifest.json'), JSON.stringify({ ...meta,
    bundle: filename, checksum: hash(zip), size: zip.length }, null, 2) + '\n');
  const browserFiles = {};
  for (const path of await files(resolve(root, 'web'))) {
    const name = relative(resolve(root, 'web'), path).replaceAll('\\', '/');
    const bytes = await readFile(path);
    browserFiles[name] = /\.(?:html|css|js|mjs|json|svg|txt|md)$/.test(path)
      ? Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n')) : bytes;
  }
  await writeFile(resolve(release, 'Lingua-web.zip'), zipSync(browserFiles, { level: 6, mtime: new Date(2020, 0, 1) }));
  console.log(`Release: web/mobile/manifest.json (${zip.length} bytes)`);
}
console.log(`Bundled frontend: ${version.slice(0, 12)}`);
