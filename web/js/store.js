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
 *
 * 所有事务都经 `transact` 登记。页面进入往返缓存 (bfcache) 时, WebKit 不会中止该文档
 * 里没结束的事务: success 事件停在冻结的任务队列里, 事务不提交也不释放锁, 同源其他
 * 页面的读写只能一直排队。所以 `pagehide(persisted)` 时中止进行中的事务并暂停新事务,
 * `pageshow` 后整体重跑; 事务长时间没有任何进展就中止并报错, 不让读写无限挂起。
 */

const DB_NAME = 'linguatrack';
const DB_VER = 4;
const STALL_MS = 15000;            // 事务这么久没有进展就放弃 (只在页面可见时计时)
const READ_FAIL = '本地数据读取失败，请重试';
const WRITE_FAIL = '本地数据保存失败，请重试';

/** 大模型缓存 (键 = `trackId|…`). */
export const CACHE_STORES = ['tr', 'word', 'chat', 'kv'];
/** 音频库 (键 = trackId): 元数据 / 音频 / 分析结果 / 字幕原件. */
export const LIB_STORES = ['tracks', 'audio', 'audioChunks', 'data', 'transcripts'];
export const STORES = [...CACHE_STORES, ...LIB_STORES];

const mem = new Map(STORES.map((s) => [s, new Map()]));
let degraded = false;
let conn = null, current = null;   // 打开中或已打开的连接 Promise / 已打开的连接
let opened = false;                // 本文档成功打开过: 之后的失败都按临时故障处理
const MEMORY = Symbol('memory');   // transact 的结果: 本次走内存降级
const REPLAY = Symbol('replay');   // 事务被页面冻结打断, 恢复后重跑

export const isDegraded = () => degraded;

function busy() {
  const error = new Error('本地存储暂时没有响应，请稍后重试');
  error.name = 'StoreBusyError';
  return error;
}
// ---------------------------------------------------------------- 页面生命周期

let frozen = false, epoch = 0;
let thawWaiters = [];
const live = new Map();            // 进行中的事务 -> 中止并转为重跑
const dogs = new Set();            // 正在计时的停滞检测

const thawed = () => new Promise((resolve) => { thawWaiters.push(resolve); });

if (typeof addEventListener === 'function') {
  addEventListener('pagehide', (event) => {
    // persisted=false 时文档随即销毁, 浏览器自己会中止事务。
    if (!event.persisted) return;
    frozen = true;
    epoch++;
    for (const interrupt of [...live.values()]) interrupt();
  });
  addEventListener('pageshow', () => {
    if (!frozen) return;
    frozen = false;
    const waiters = thawWaiters;
    thawWaiters = [];
    for (const resolve of waiters) resolve();
  });
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  // 后台时进程可能被挂起, 计时器回到前台立即触发; 只统计页面可见的时间。
  document.addEventListener('visibilitychange', () => {
    for (const dog of dogs) dog.sync();
  });
}

const isHidden = () => typeof document !== 'undefined' && !!document.hidden;

/** 停滞检测: `poke` 重新计时, 超过 ms 没有进展就调用 onStall. */
function watchdog(ms, onStall) {
  let timer = 0, stopped = !ms;
  const clear = () => { if (timer) { clearTimeout(timer); timer = 0; } };
  const arm = () => {
    clear();
    if (stopped || isHidden()) return;
    timer = setTimeout(() => {
      timer = 0;
      if (stopped) return;
      stopped = true;
      dogs.delete(dog);
      onStall();
    }, ms);
  };
  const dog = {
    poke: arm,
    sync: arm,
    stop() { stopped = true; clear(); dogs.delete(dog); },
  };
  if (!stopped) { dogs.add(dog); arm(); }
  return dog;
}

// ---------------------------------------------------------------- 连接

function forget(db) {
  if (db && current !== db) return;
  current = null;
  conn = null;
}

function retire(db) {
  forget(db);
  try { db?.close(); } catch { /* 连接已经关闭 */ }
}

/**
 * 打开或复用连接。只有本文档第一次打开就失败 (隐私模式 / file://) 才永久降级到内存;
 * 打开过之后的失败、超时和页面冻结期间的失败都只报给这一次调用, 下次重新打开。
 */
function connect() {
  if (conn) return conn;
  const startedAt = epoch;
  const attempt = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
    let request, abandoned = false;
    try { request = indexedDB.open(DB_NAME, DB_VER); }
    catch (error) { reject(error); return; }
    // 被其他页面的旧连接挡住 (blocked) 时继续等待, 超时才放弃, 不再当成存储不可用。
    const dog = watchdog(STALL_MS, () => { abandoned = true; reject(busy()); });
    request.onupgradeneeded = () => {
      const db = request.result;
      // 升级只新增 store: v2 音频库, v3 字幕原件, v4 音频二进制分块; 保留已有记录。
      for (const name of STORES) {
        if (db.objectStoreNames.contains(name)) continue;
        const os = db.createObjectStore(name);
        os.createIndex('track', 'track', { unique: false });
      }
    };
    request.onsuccess = () => {
      dog.stop();
      const db = request.result;
      if (abandoned) { db.close(); return; }
      db.onversionchange = () => retire(db);
      // 存储进程丢失连接时浏览器会关闭它; 下一次读写重新打开。
      db.onclose = () => forget(db);
      opened = true;
      if (conn === attempt) current = db;
      resolve(db);
    };
    request.onerror = () => { dog.stop(); reject(request.error || new Error('open failed')); };
  });
  conn = attempt;
  attempt.catch((error) => {
    if (conn === attempt) conn = null;
    if (!opened && startedAt === epoch && error?.name !== 'StoreBusyError') degraded = true;
  });
  return attempt;
}

// ---------------------------------------------------------------- 事务

/**
 * 在一个事务里运行 setup, 返回结果; 降级时返回 MEMORY, 由调用方改用内存 Map。
 *
 * setup(transaction, ctx) 同步发出请求, 返回 `() => 结果` (事务提交后读取), 或在请求
 * 回调里调用 `ctx.done(结果)` 提前给出读结果。`ctx.request` 登记成功回调并计入进展;
 * `ctx.fail` 中止事务并以该错误结束; `ctx.undo` 登记事务未提交时要撤销的副作用。
 * 被页面冻结打断的事务在 pageshow 后整体重跑, 所以 setup 必须可以重复执行。
 */
async function transact(stores, mode, setup, { timeoutMs = STALL_MS, fallback = READ_FAIL } = {}) {
  let retried = false;
  for (;;) {
    if (degraded) return MEMORY;
    if (frozen) { await thawed(); continue; }
    const startedAt = epoch;
    let db;
    try { db = await connect(); }
    catch (error) {
      if (degraded) return MEMORY;
      if (startedAt !== epoch) continue;            // 打开过程被页面冻结打断, 恢复后再试
      throw error;
    }
    if (frozen) continue;
    let outcome;
    try { outcome = await once(db, stores, mode, setup, timeoutMs, fallback); }
    catch (error) {
      // 连接被版本变更或存储进程重启断开: 换一个连接重试一次。
      if (!retried && (error?.name === 'InvalidStateError' || error?.name === 'UnknownError')) {
        retried = true;
        retire(db);
        continue;
      }
      throw error;
    }
    if (outcome !== REPLAY) return outcome;
  }
}

function once(db, stores, mode, setup, timeoutMs, fallback) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    const undo = [];
    let settled = false, failure, read = null;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      dog.stop();
      live.delete(transaction);
      settle(value);
    };
    const tryAbort = () => {
      try { transaction.abort(); return true; }
      catch { return false; }                      // 已在提交, 等它自己结束
    };
    // 撤销登记过的副作用; 撤销本身失败时返回那个错误。
    const rollback = () => {
      let error;
      for (const fn of undo.splice(0).reverse()) {
        try { fn(); } catch (err) { error ||= err; }
      }
      return error;
    };
    const dog = watchdog(timeoutMs, () => {
      if (settled || !tryAbort()) return;
      const error = rollback();
      retire(db);
      finish(reject, error || busy());
    });
    // pagehide: 立刻中止, 释放锁, 页面恢复后由 transact 重跑。
    live.set(transaction, () => {
      if (settled || !tryAbort()) return;
      const error = rollback();
      if (error) finish(reject, error);
      else finish(resolve, REPLAY);
    });
    transaction.oncomplete = () => {
      dog.stop();
      live.delete(transaction);
      if (settled || !read) return;
      try { finish(resolve, read()); }
      catch (error) { finish(reject, error); }
    };
    transaction.onabort = () => {
      const error = rollback();
      finish(reject, error || failure || transaction.error || new Error(fallback));
    };
    const ctx = {
      request(req, onSuccess) {
        req.onsuccess = (event) => {
          if (settled) return;
          dog.poke();
          if (!onSuccess) return;
          try { onSuccess(req.result, event); }
          catch (error) { ctx.fail(error); }
        };
        return req;
      },
      done(value) { finish(resolve, value); },
      fail(error) {
        if (settled) return;
        failure ||= error;
        if (!tryAbort()) finish(reject, failure);
      },
      undo(fn) { if (typeof fn === 'function') undo.push(fn); },
    };
    try {
      const out = setup(transaction, ctx);
      if (typeof out === 'function') read = out;
    } catch (error) { ctx.fail(error); }
  });
}
// ---------------------------------------------------------------- 读写

/** strict 读取失败时抛错; 非 strict 的缓存读取失败按未命中处理. */
export async function get(store, key, { strict = false } = {}) {
  let row;
  try {
    row = await transact(store, 'readonly', (t, ctx) => {
      ctx.request(t.objectStore(store).get(key), (value) => ctx.done(value));
    });
  } catch (error) {
    if (strict) throw error;
    return undefined;
  }
  if (row === MEMORY) return mem.get(store).get(key);
  return row == null ? undefined : row.v;
}

/** 一次拿多把 key; 命中的写进 out (Map), 返回 out. */
export async function getMany(store, keys, out = new Map(), { strict = false } = {}) {
  if (!keys.length) return out;
  let hits;
  try {
    hits = await transact(store, 'readonly', (t, ctx) => {
      const os = t.objectStore(store), found = new Map();
      for (const k of keys) {
        ctx.request(os.get(k), (row) => { if (row != null && row.v !== undefined) found.set(k, row.v); });
      }
      return () => found;
    });
  } catch (error) {
    if (strict) throw error;
    return out;
  }
  if (hits === MEMORY) {
    const bag = mem.get(store);
    for (const k of keys) if (bag.has(k)) out.set(k, bag.get(k));
    return out;
  }
  for (const [k, v] of hits) out.set(k, v);
  return out;
}

/** 取一个 store 里的全部值 (音频库列表用). */
export async function values(store, { strict = false } = {}) {
  let rows;
  try {
    rows = await transact(store, 'readonly', (t, ctx) => {
      const req = t.objectStore(store).getAll();
      ctx.request(req, () => ctx.done(req.result));
    });
  } catch (error) {
    if (strict) throw error;
    return [];
  }
  if (rows === MEMORY) return [...mem.get(store).values()];
  return (rows || []).map((row) => row && row.v).filter((v) => v !== undefined);
}

/** 缓存写入: 失败只是下次重算, 不打断调用方. 用户资产走 writeBatch / updateRecord. */
export async function put(store, key, value, track = '') {
  try {
    const out = await transact(store, 'readwrite', (t, ctx) => {
      ctx.request(t.objectStore(store).put({ v: value, track, at: Date.now() }, key));
      return () => true;
    }, { fallback: WRITE_FAIL });
    if (out === MEMORY) mem.get(store).set(key, value);
  } catch { /* 缓存写入失败不影响功能 */ }
}

export async function del(store, key) {
  try {
    const out = await transact(store, 'readwrite', (t, ctx) => {
      ctx.request(t.objectStore(store).delete(key));
      return () => true;
    }, { fallback: WRITE_FAIL });
    if (out === MEMORY) mem.get(store).delete(key);
  } catch { /* 尽力删除; 用户资产的删除走 wipeTrackAll */ }
}
/** Backup reads must fail explicitly and share one consistent transaction. */
export async function snapshot(names) {
  const out = await transact(names, 'readonly', (t, ctx) => {
    const rows = Object.fromEntries(names.map((name) => [name, []]));
    for (const name of names) {
      const request = t.objectStore(name).openCursor();
      ctx.request(request, (cursor) => {
        if (!cursor) return;
        const row = cursor.value;
        if (!row || !Object.hasOwn(row, 'v')) { ctx.fail(new Error('读取备份数据失败')); return; }
        rows[name].push({ key: cursor.key, value: row.v, track: row.track || '', at: row.at || 0 });
        cursor.continue();
      });
    }
    return () => rows;
  }, { fallback: '读取备份数据失败' });
  if (out !== MEMORY) return out;
  return Object.fromEntries(names.map((name) => [name,
    [...mem.get(name)].map(([key, value]) => ({
      key, value: structuredClone(value), track: String(key).split('|')[0], at: 0,
    })),
  ]));
}

/** beforeCommit is synchronous and may return a rollback for localStorage changes. */
export async function writeBatch(batches, { addOnly = false, persistent = false, beforeCommit, timeoutMs = STALL_MS } = {}) {
  const names = Object.keys(batches);
  if (!names.length) throw new Error('没有指定存储区');
  const out = await transact(names, 'readwrite', (t, ctx) => {
    for (const name of names) {
      const os = t.objectStore(name);
      for (const row of batches[name]) {
        const value = { v: row.value, track: row.track || '', at: row.at ?? Date.now() };
        ctx.request(addOnly ? os.add(value, row.key) : os.put(value, row.key));
      }
    }
    // Keep localStorage writes inside an active transaction, after every IDB write succeeds.
    ctx.request(t.objectStore(names[0]).get('__backup_commit__'), () => {
      if (beforeCommit) ctx.undo(beforeCommit());
    });
    return () => undefined;
  }, { timeoutMs, fallback: WRITE_FAIL });
  if (out !== MEMORY) return;
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
}

/** Read and change an existing record in ONE transaction; change must be synchronous.
 * Separate get/put transactions can lose a rename when a player writes its old title
 * back with a new position. IndexedDB serializes this transaction across documents.
 * Returning the same object from change skips the write.
 */
export async function updateRecord(store, key, change, { timeoutMs = STALL_MS } = {}) {
  const out = await transact(store, 'readwrite', (t, ctx) => {
    const os = t.objectStore(store);
    let next = null;
    ctx.request(os.get(key), (row) => {
      if (!row) return;
      next = change(row.v);
      if (next !== row.v) ctx.request(os.put({ ...row, v: next, at: Date.now() }, key));
    });
    return () => next;
  }, { timeoutMs, fallback: WRITE_FAIL });
  if (out !== MEMORY) return out;
  const bag = mem.get(store);
  if (!bag.has(key)) return null;
  const next = change(structuredClone(bag.get(key)));
  bag.set(key, structuredClone(next));
  return next;
}
/** 删掉某条音频的**大模型缓存** (不动音频本体); 返回删除条数. */
export const wipeTrack = (track) => removeTrackData(track, CACHE_STORES);

/** 删掉某条音频的全部数据 (音频 / 分析结果 / 元数据 / 缓存). */
export const wipeTrackAll = (track) => removeTrackData(track, STORES);

async function removeTrackData(track, stores) {
  if (!track) return 0;
  // One transaction avoids a partially deleted library and waits for durable completion.
  // Older stores can lack the track index or contain rows without its indexed field.
  const out = await transact(stores, 'readwrite', (t, ctx) => {
    let count = 0;
    for (const store of stores) {
      const os = t.objectStore(store);
      const deleted = new Set();
      const remove = (key) => {
        if (deleted.has(key)) return;
        deleted.add(key); os.delete(key); count++;
      };
      // Key-only reads avoid materializing large media Blobs just to delete them.
      ctx.request(os.getKey(track), (key) => { if (key !== undefined) remove(key); });
      const cursors = [os.openKeyCursor(IDBKeyRange.bound(track + '|', track + '|\uffff'))];
      if (os.indexNames.contains('track')) cursors.push(os.index('track').openKeyCursor(IDBKeyRange.only(track)));
      for (const request of cursors) {
        ctx.request(request, (cursor) => {
          if (!cursor) return;
          remove(cursor.primaryKey); cursor.continue();
        });
      }
    }
    return () => count;
  }, { fallback: '删除未完成，请重试' });
  if (out !== MEMORY) return out;
  let count = 0;
  for (const store of stores) {
    const bag = mem.get(store);
    for (const key of [...bag.keys()]) {
      if (key === track || String(key).startsWith(track + '|')) { bag.delete(key); count++; }
    }
  }
  return count;
}

/** 每个 store 的条数, 设置页里显示. */
export async function stats() {
  const out = await transact(STORES, 'readonly', (t, ctx) => {
    const counts = {};
    for (const store of STORES) {
      ctx.request(t.objectStore(store).count(), (n) => { counts[store] = n || 0; });
    }
    return () => counts;
  });
  if (out !== MEMORY) return out;
  return Object.fromEntries(STORES.map((store) => [store, mem.get(store).size]));
}

/** 只清大模型缓存; 音频库不动. */
export async function clearAll() {
  const out = await transact(CACHE_STORES, 'readwrite', (t, ctx) => {
    for (const store of CACHE_STORES) ctx.request(t.objectStore(store).clear());
    return () => undefined;
  }, { fallback: '缓存清空失败，请重试' });
  if (out === MEMORY) for (const store of CACHE_STORES) mem.get(store).clear();
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
