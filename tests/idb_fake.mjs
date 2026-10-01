/** Minimal in-memory IndexedDB for store.js lifecycle tests; not a general implementation.
 *
 * Scheduling follows WebKit's SQLite backend: a transaction waits for every earlier
 * unfinished transaction that overlaps it with a write, and read-write transactions never
 * run concurrently. `holdRequest` keeps success events undelivered, like a page frozen in
 * the back/forward cache; `holdCommit` stalls a commit after its last request.
 */

const domError = (name, message = name) => new DOMException(message, name);

class Request {
  constructor(transaction) {
    this.transaction = transaction;
    this.result = undefined;
    this.error = null;
    this.readyState = 'pending';
    this.onsuccess = null;
    this.onerror = null;
  }
}

class ObjectStore {
  constructor(transaction, name) { this.transaction = transaction; this.name = name; }
  get indexNames() { return { contains: () => false }; }
  get(key) {
    const request = this.transaction.issue(() => structuredClone(this.transaction.read(this.name).get(key)));
    request.key = key;
    return request;
  }
  getAll() { return this.transaction.issue(() => [...this.transaction.read(this.name).values()].map((v) => structuredClone(v))); }
  count() { return this.transaction.issue(() => this.transaction.read(this.name).size); }
  put(value, key) {
    this.transaction.requireWrite();
    const copy = structuredClone(value);
    return this.transaction.issue(() => { this.transaction.write(this.name).set(key, copy); return key; });
  }
  add(value, key) {
    this.transaction.requireWrite();
    const copy = structuredClone(value);
    return this.transaction.issue(() => {
      const rows = this.transaction.write(this.name);
      if (rows.has(key)) throw domError('ConstraintError');
      rows.set(key, copy);
      return key;
    });
  }
  delete(key) {
    this.transaction.requireWrite();
    return this.transaction.issue(() => { this.transaction.write(this.name).delete(key); });
  }
  clear() {
    this.transaction.requireWrite();
    return this.transaction.issue(() => { this.transaction.write(this.name).clear(); });
  }
  openCursor() {
    const tx = this.transaction, name = this.name;
    let entries = null, index = 0, request;
    request = tx.issue(() => {
      entries ||= [...tx.read(name).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (index >= entries.length) return null;
      const [key, value] = entries[index];
      return { key, primaryKey: key, value: structuredClone(value), continue: () => { index++; tx.reissue(request); } };
    });
    return request;
  }
}
class Transaction {
  constructor(db, names, mode) {
    this.db = db; this.fake = db.fake; this.names = names; this.mode = mode;
    this.state = 'waiting';      // waiting -> active -> committing -> finished | aborted
    this.queue = []; this.pending = 0; this.shadow = new Map();
    this.held = [];
    this.error = null; this.oncomplete = null; this.onabort = null;
    this.fake.transactions.push(this);
    this.fake.created++;
    queueMicrotask(() => this.fake.schedule());
  }
  objectStore(name) {
    if (!this.names.includes(name)) throw domError('NotFoundError');
    return new ObjectStore(this, name);
  }
  requireWrite() { if (this.mode === 'readonly') throw domError('ReadOnlyError'); }
  read(name) { return this.shadow.get(name) || this.fake.data.get(name); }
  write(name) {
    if (!this.shadow.has(name)) this.shadow.set(name, new Map(this.fake.data.get(name)));
    return this.shadow.get(name);
  }
  issue(compute) {
    if (!['waiting', 'active'].includes(this.state)) throw domError('TransactionInactiveError');
    const request = new Request(this);
    request.compute = compute;
    this.pending++;
    this.queue.push(request);
    this.pump();
    return request;
  }
  reissue(request) {
    request.readyState = 'pending';
    this.pending++;
    this.queue.push(request);
    this.pump();
  }
  pump() {
    if (this.state !== 'active') return;
    while (this.queue.length) {
      const request = this.queue.shift();
      setImmediate(() => this.run(request));
    }
  }
  run(request) {
    if (this.state !== 'active') return;
    try { request.result = request.compute(); }
    catch (error) { request.error = error; }
    if (this.fake.holdRequest?.(this, request)) { this.held.push(request); return; }
    this.deliver(request);
  }
  deliver(request) {
    if (this.state !== 'active') return;
    request.readyState = 'done';
    this.pending--;
    if (request.error) {
      this.error = request.error;
      try { request.onerror?.({ target: request }); } catch { /* reported by the abort */ }
      this.abortWith(request.error);
      return;
    }
    try { request.onsuccess?.({ target: request }); }
    catch (error) { this.abortWith(error); return; }
    this.maybeCommit();
  }
  maybeCommit() {
    queueMicrotask(() => {
      if (this.state !== 'active' || this.pending) return;
      this.state = 'committing';
      if (this.fake.holdCommit?.(this)) { this.fake.stalledCommits.push(this); return; }
      this.commit();
    });
  }
  commit() {
    for (const [name, rows] of this.shadow) this.fake.data.set(name, rows);
    this.state = 'finished';
    this.fake.committed++;
    setImmediate(() => { this.oncomplete?.({ target: this }); this.fake.schedule(); });
  }
  abort() {
    if (!['waiting', 'active'].includes(this.state)) throw domError('InvalidStateError');
    this.abortWith(null);
  }
  abortWith(error) {
    this.state = 'aborted';
    this.error = error;
    this.shadow.clear();
    this.queue = []; this.held = [];
    this.fake.aborted++;
    setImmediate(() => { this.onabort?.({ target: this }); this.fake.schedule(); });
  }
  /** Deliver success events that a frozen page never received. */
  release() {
    const held = this.held.splice(0);
    for (const request of held) setImmediate(() => this.deliver(request));
  }
  get done() { return this.state === 'finished' || this.state === 'aborted'; }
}

class Database {
  constructor(fake, version) {
    this.fake = fake; this.version = version; this.closed = false;
    this.onversionchange = null; this.onclose = null;
  }
  get objectStoreNames() { return { contains: (name) => this.fake.data.has(name) }; }
  createObjectStore(name) {
    this.fake.data.set(name, new Map());
    return { createIndex() {} };
  }
  transaction(names, mode = 'readonly') {
    if (this.closed) throw domError('InvalidStateError', 'The database connection is closing.');
    const list = Array.isArray(names) ? names : [names];
    for (const name of list) if (!this.fake.data.has(name)) throw domError('NotFoundError');
    return new Transaction(this, list, mode);
  }
  close() { this.closed = true; }
}

export function createFakeIndexedDB() {
  const fake = {
    data: new Map(), version: 0, transactions: [], connections: [],
    created: 0, committed: 0, aborted: 0, opens: 0, stalledCommits: [],
    holdRequest: null, holdCommit: null, openError: null, deferOpen: false, deferredOpens: [],
    schedule() {
      const waiting = fake.transactions.filter((t) => t.state === 'waiting');
      for (const tx of waiting) {
        const earlier = fake.transactions.slice(0, fake.transactions.indexOf(tx)).filter((t) => !t.done);
        const blocked = earlier.some((t) => {
          const overlap = t.names.some((n) => tx.names.includes(n));
          if (tx.mode === 'readwrite' && t.mode === 'readwrite') return true;   // no concurrent writers
          return overlap && (tx.mode === 'readwrite' || t.mode === 'readwrite');
        });
        if (blocked) continue;
        tx.state = 'active';
        if (!tx.queue.length && !tx.pending) tx.maybeCommit();
        tx.pump();
      }
      fake.transactions = fake.transactions.filter((t) => !t.done);
    },
    /** A raw connection, as another document of the same origin would hold. */
    connect() {
      const db = new Database(fake, fake.version);
      fake.connections.push(db);
      return db;
    },
    /** The browser drops every connection (storage process restart, data deleted). */
    dropConnections() {
      for (const db of fake.connections) {
        if (db.closed) continue;
        db.closed = true;
        setImmediate(() => db.onclose?.());
      }
    },
    open(name, version) {
      const request = new Request(null);
      const run = () => {
        fake.opens++;
        if (fake.openError) {
          request.error = fake.openError;
          request.onerror?.({ target: request });
          return;
        }
        const db = fake.connect();
        request.result = db;
        if (fake.version < version) {
          request.transaction = null;
          request.onupgradeneeded?.({ target: request });
          fake.version = version;
          db.version = version;
        }
        request.onsuccess?.({ target: request });
      };
      setImmediate(() => { if (fake.deferOpen) fake.deferredOpens.push(run); else run(); });
      return request;
    },
  };
  return fake;
}
