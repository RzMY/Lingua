/** Refresh small runtime glue; large, hash-pinned WASM/data are explicitly downloaded by users. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const out = new URL('../../web/js/vendor/piper/', import.meta.url);
await mkdir(out, { recursive: true });
for (const [input, output] of [
  ['@diffusionstudio/piper-wasm/build/piper_phonemize.js', 'piper_phonemize.js'],
  ['onnxruntime-web/dist/ort.wasm.min.js', 'ort.wasm.min.js'],
]) {
  const source = await readFile(new URL(`../../node_modules/${input}`, import.meta.url), 'utf8');
  await writeFile(new URL(output, out), source.replaceAll('\r\n', '\n').replace(/\/\/# sourceMappingURL=.*$/gm, ''));
}
