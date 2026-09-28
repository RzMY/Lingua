import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
export const frontendVersion = pkg.version;

// Check in this small module so serving web/ directly never requires a build.
await writeFile(new URL('web/js/version.js', root),
  '// Generated from package.json by mobile/scripts/version.mjs.\n'
  + `export const FRONTEND_VERSION = ${JSON.stringify(frontendVersion)};\n`);
