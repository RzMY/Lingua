/** Temporary disk-backed media, with bounded Blob parts where OPFS is unavailable. */
import { randomId } from './util.js';

export async function mediaWriter(name, type, signal) {
  let directory, handle, stream, tempName;
  const parts = [];
  try {
    if (navigator.storage?.getDirectory) {
      directory = await navigator.storage.getDirectory();
      tempName = 'lingua-media-' + randomId();
      handle = await directory.getFileHandle(tempName, { create: true });
      stream = await handle.createWritable();
    }
  } catch {
    if (directory && tempName) await directory.removeEntry(tempName).catch(() => {});
    directory = handle = stream = null;
  }
  const release = async () => {
    if (directory) { await directory.removeEntry(tempName).catch(() => {}); directory = null; }
  };
  return {
    async write(blob) {
      for (let p = 0; p < blob.size; p += 1024 * 1024) {
        signal?.throwIfAborted();
        // Flatten slice graphs before storage; never hand IndexedDB references to the video.
        const bytes = await blob.slice(p, p + 1024 * 1024).arrayBuffer();
        signal?.throwIfAborted();
        if (stream) await stream.write(bytes);
        else parts.push(new Blob([bytes]));
      }
    },
    async finish() {
      signal?.throwIfAborted();
      if (stream) { await stream.close(); stream = null; }
      const file = new File(handle ? [await handle.getFile()] : parts, name, { type });
      parts.length = 0;
      return { file, release };
    },
    async abort() {
      if (stream) await stream.abort().catch(() => {});
      parts.length = 0; await release();
    },
  };
}

export async function materializeMedia(file, { signal, onStage = () => {} } = {}) {
  const writer = await mediaWriter(file.name, file.type, signal);
  try {
    for (let p = 0; p < file.size; p += 1024 * 1024) {
      onStage(`正在整理音频文件… ${Math.round(p / file.size * 100)}%`);
      await writer.write(file.slice(p, p + 1024 * 1024));
    }
    const result = await writer.finish();
    if (signal?.aborted) { await result.release(); signal.throwIfAborted(); }
    return result;
  } catch (err) { await writer.abort(); throw err; }
}
