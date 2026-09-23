/**
 * IndexedDB —— 前端是唯一的数据持有者.
 *
 * 前后端分离后, 后端不存任何东西, 所以这里既要放**大模型缓存** (译文 / 单词卡片 /
 * 讲解对话), 也要放**音频库本体** (音频 Blob / 分析结果 / 曲目元数据)。两类分开:
 *
 * * `CACHE_STORES` —— 可以随时清掉, 清了只是重新烧 token;
 * * `LIB_STORES`   —— 用户的资产, 只有显式删除音频时才动。
 *
 * 两条硬要求照旧: 各环节都缓存, 避免重复运算与重复调用; 各音频之间数据隔离 ——
 * 缓存键一律以 `trackId|` 开头, 值里带 `track` 字段做索引, 删一条音频能把它的东西
 * 整片清掉, 不会误伤别的音频。
 *
 * IndexedDB 不可用 (隐私模式 / file:// 打开) 时退化成内存 Map: 功能不缺, 但刷新
 * 就丢 —— 包括音频, 所以首页会明确提示。
 */

const DB_NAME = 'linguatrack';
const DB_VER = 4;

/** 大模型缓存 (键 = `trackId|…`). */
export const CACHE_STORES = ['tr', 'word', 'chat', 'kv'];
/** 音频库 (键 = trackId): 元数据 / 音频 / 分析结果 / 字幕原件. */
export const LIB_STORES = ['tracks', 'audio', 'audioChunks', 'data', 'transcripts'];
export const STORES = [...CACHE_STORES, ...LIB_STORES];

let dbPromise = null;
const mem = new Map(STORES.map((s) => [s, new Map()]));
let degraded = false;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      // 升级只新增 store: v2 音频库, v3 字幕原件, v4 音频二进制分块; 保留已有记录。
      for (const name of STORES) {
        if (db.objectStoreNames.contains(name)) continue;
        const os = db.createObjectStore(name);
        os.createIndex('track', 'track', { unique: false });
      }
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error || new Error('open failed'));
    req.onblocked = () => reject(new Error('blocked'));
  }).catch((err) => {
    degraded = true;
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

/** 首次调用会真的开库; 失败就永久走内存, 不再反复重试. */
async function tx(store, mode, strict = false) {
  if (degraded) return null;
  try {
    const db = await open();
    return db.transaction(store, mode).objectStore(store);
  } catch (error) {
    if (strict && !degraded) throw error;
    return null;
  }
}

const wrap = (req, strict = false) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => strict ? reject(req.error || new Error('本地数据读取失败，请重试')) : resolve(undefined);
  });

export const isDegraded = () => degraded;

/** Backup reads must fail explicitly and share one consistent transaction. */
export async function snapshot(names) {
  let db;
  if (!degraded) {
    try { db = await open(); } catch { /* The in-memory library can still be exported. */ }
  }
  if (!db) return Object.fromEntries(names.map((name) => [name,
    [...mem.get(name)].map(([key, value]) => ({
      key, value: structuredClone(value), track: String(key).split('|')[0], at: 0,
    })),
  ]));
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(names, 'readonly');
    const out = Object.fromEntries(names.map((name) => [name, []]));
    transaction.onabort = () => reject(transaction.error || new Error('读取备份数据失败'));
    transaction.oncomplete = () => resolve(out);
    for (const name of names) {
      const request = transaction.objectStore(name).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const row = cursor.value;
        if (!row || !Object.hasOwn(row, 'v')) { transaction.abort(); return; }
        out[name].push({ key: cursor.key, value: row.v, track: row.track || '', at: row.at || 0 });
        cursor.continue();
      };
    }
  });
}

/** beforeCommit is synchronous and may return a rollback for localStorage changes. */
export async function writeBatch(batches, { addOnly = false, persistent = false, beforeCommit, timeoutMs = 0 } = {}) {
  const names = Object.keys(batches);
  if (!names.length) throw new Error('没有指定存储区');
  let db;
  if (!degraded) {
    try { db = await open(); } catch { /* Checked below for durable imports. */ }
  }
  if (!db) {
    if (persistent) throw new Error('本地存储不可用，无法导入数据。请使用普通浏览模式');
    const next = new Map();
    for (const name of names) {
      const bag = new Map(mem.get(name));
      for (const row of batches[name]) {
        if (addOnly && bag.has(row.key)) throw new Error('数据已存在，请重新导入');
        bag.set(row.key, structuredClone(row.value));
      }
      next.set(name, bag);
    }
    if (beforeCommit) beforeCommit();
    for (const [name, bag] of next) mem.set(name, bag);
    return;
  }
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(names, 'readwrite');
    let rollback, failure;
    const timer = timeoutMs ? setTimeout(() => {
      failure = new Error('保存超时，请检查浏览器存储空间后重试');
      try { transaction.abort(); } catch { /* A stalled connection can already be closed. */ }
      reject(failure);
    }, timeoutMs) : null;
    transaction.oncomplete = () => { clearTimeout(timer); resolve(); };
    transaction.onabort = () => {
      clearTimeout(timer);
      try { if (rollback) rollback(); } catch (err) { failure = err; }
      reject(failure || transaction.error || new Error('本地数据保存失败，请重试'));
    };
    try {
      for (const name of names) {
        const os = transaction.objectStore(name);
        for (const row of batches[name]) {
          const value = { v: row.value, track: row.track || '', at: row.at ?? Date.now() };
          if (addOnly) os.add(value, row.key);
          else os.put(value, row.key);
        }
      }
      // Keep localStorage writes inside an active transaction, after every IDB write succeeds.
      transaction.objectStore(names[0]).get('__backup_commit__').onsuccess = () => {
        try { if (beforeCommit) rollback = beforeCommit(); }
        catch (err) { failure = err; transaction.abort(); }
      };
    } catch (err) {
      failure = err;
      transaction.abort();
    }
  });
}

export async function get(store, key, { strict = false } = {}) {
  const os = await tx(store, 'readonly', strict);
  if (!os) return mem.get(store).get(key);
  const row = await wrap(os.get(key), strict);
  return row === undefined ? undefined : row.v;
}

/** 一次拿多把 key; 命中的写进 out (Map), 返回 out. */
export async function getMany(store, keys, out = new Map()) {
  if (!keys.length) return out;
  const os = await tx(store, 'readonly');
  if (!os) {
    const bag = mem.get(store);
    for (const k of keys) if (bag.has(k)) out.set(k, bag.get(k));
    return out;
  }
  await Promise.all(keys.map(async (k) => {
    const row = await wrap(os.get(k));
    if (row !== undefined) out.set(k, row.v);
  }));
  return out;
}

/** 取一个 store 里的全部值 (音频库列表用). */
export async function values(store, { strict = false } = {}) {
  const os = await tx(store, 'readonly', strict);
  if (!os) return [...mem.get(store).values()];
  const rows = await wrap(os.getAll(), strict);
  return (rows || []).map((row) => row && row.v).filter((v) => v !== undefined);
}

export async function put(store, key, value, track = '') {
  const os = await tx(store, 'readwrite');
  if (!os) {
    mem.get(store).set(key, value);
    return;
  }
  await wrap(os.put({ v: value, track, at: Date.now() }, key));
}

export async function del(store, key) {
  const os = await tx(store, 'readwrite');
  if (!os) {
    mem.get(store).delete(key);
    return;
  }
  await wrap(os.delete(key));
}

/** 删掉某条音频的**大模型缓存** (不动音频本体); 返回删除条数. */
export const wipeTrack = (track) => removeTrackData(track, CACHE_STORES);

/** 删掉某条音频的全部数据 (音频 / 分析结果 / 元数据 / 缓存). */
export const wipeTrackAll = (track) => removeTrackData(track, STORES);

async function removeTrackData(track, stores) {
  if (!track) return 0;
  let db;
  if (!degraded) {
    try { db = await open(); } catch { /* Existing memory-only sessions still support deletion. */ }
  }
  if (!db) {
    let count = 0;
    for (const store of stores) {
      const bag = mem.get(store);
      for (const key of [...bag.keys()]) {
        if (key === track || String(key).startsWith(track + '|')) { bag.delete(key); count++; }
      }
    }
    return count;
  }
  // One transaction avoids a partially deleted library and waits for durable completion.
  // Older stores can lack the track index or contain rows without its indexed field.
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(stores, 'readwrite');
    let count = 0, failure;
    transaction.oncomplete = () => resolve(count);
    transaction.onabort = () => reject(failure || transaction.error || new Error('删除未完成，请重试'));
    const guard = (action) => (event) => {
      try { action(event); }
      catch (error) { failure = error; transaction.abort(); }
    };
    guard(() => {
      for (const store of stores) {
        const os = transaction.objectStore(store);
        const deleted = new Set();
        const remove = (key) => {
          if (deleted.has(key)) return;
          deleted.add(key); os.delete(key); count++;
        };
        // Key-only reads avoid materializing large media Blobs just to delete them.
        os.getKey(track).onsuccess = guard((event) => {
          if (event.target.result !== undefined) remove(event.target.result);
        });
        const cursors = [os.openKeyCursor(IDBKeyRange.bound(track + '|', track + '|\uffff'))];
        if (os.indexNames.contains('track')) cursors.push(os.index('track').openKeyCursor(IDBKeyRange.only(track)));
        for (const request of cursors) request.onsuccess = guard(() => {
          const cursor = request.result;
          if (!cursor) return;
          remove(cursor.primaryKey); cursor.continue();
        });
      }
    })();
  });
}

/** 每个 store 的条数, 设置页里显示. */
export async function stats() {
  const out = {};
  for (const store of STORES) {
    const os = await tx(store, 'readonly', true);
    out[store] = os ? (await wrap(os.count(), true)) || 0 : mem.get(store).size;
  }
  return out;
}

/** 只清大模型缓存; 音频库不动. */
export async function clearAll() {
  let db;
  if (!degraded) {
    try { db = await open(); } catch { /* Memory-only sessions can still clear their caches. */ }
  }
  if (!db) {
    for (const store of CACHE_STORES) mem.get(store).clear();
    return;
  }
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(CACHE_STORES, 'readwrite');
    let failure;
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(failure || transaction.error || new Error('缓存清空失败，请重试'));
    try { for (const store of CACHE_STORES) transaction.objectStore(store).clear(); }
    catch (error) { failure = error; transaction.abort(); }
  });
}

/** 浏览器给这个源的存储配额与已用量 (拿不到就返回 0). */
export async function usage() {
  try {
    const est = await navigator.storage.estimate();
    return { used: est.usage || 0, quota: est.quota || 0 };
  } catch {
    return { used: 0, quota: 0 };
  }
}
