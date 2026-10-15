import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../../web/', import.meta.url));
const roots = new Set(['index.html', 'player.html', 'manifest.webmanifest', 'favicon.ico']);
const dirs = new Set(['js', 'css', 'icons', 'assets']);
export function developmentManifest(entries) {
  return { schema: 1, files: Object.entries(entries).filter(([path]) => path.split('/').at(-1) !== 'audio-probe.wav'
    && (roots.has(path) || dirs.has(path.split('/')[0]))).sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([path, data]) => ({ path, size: data.length, sha256: createHash('sha256').update(data).digest('hex') })) };
}
async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if ((dir === web && !roots.has(entry.name) && !dirs.has(entry.name)) || entry.name === 'audio-probe.wav') continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
export async function writeDevelopmentManifest() {
  const entries = {};
  for (const path of (await walk(web)).sort()) {
    const data = await readFile(path);
    entries[relative(web, path).replaceAll('\\', '/')] = data;
  }
  await writeFile(resolve(web, 'development-cache.json'), JSON.stringify(developmentManifest(entries)) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await writeDevelopmentManifest();
