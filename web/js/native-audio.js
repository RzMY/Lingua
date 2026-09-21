/** HTMLMediaElement-shaped clock/control adapter for the iOS AVPlayer bridge. */
import { clamp, randomId } from './util.js';

const CHUNK = 384 * 1024;
const base64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1]);
  reader.onerror = () => reject(reader.error || Error('无法读取音频'));
  reader.readAsDataURL(blob);
});

export class NativeAudio extends EventTarget {
  constructor(bridge) {
    super();
    this.bridge = bridge; this.nativeAudio = true;
    this.src = ''; this.readyState = 0; this.duration = NaN; this.error = null;
    this.paused = true; this.ended = false; this.seeking = false;
    this._position = 0; this._rate = 1; this._waiting = false; this._anchor = performance.now();
    this._revision = 0; this._serial = 0; this._generation = 0; this._queue = Promise.resolve();
    this._blob = null; this._record = null; this._detached = false; this._loop = { start: null, end: null, all: false };
    window.addEventListener('native-audio-state', ({ detail }) => this._accept(detail));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void this.refresh(); });
    window.addEventListener('pagehide', () => { this._detached = true; void this.release(); });
    window.addEventListener('pageshow', () => {
      if (!this._detached || !this._blob) return;
      this._detached = false;
      const position = this._position, rate = this._rate, loop = this._loop;
      void this.attach(this._blob, this._record).then(() => {
        this.playbackRate = rate; this.currentTime = position; this.setLoop(loop);
      }).catch((error) => this._fail(error));
    });
  }
  get nativeSession() { return this.src; }
  get currentTime() {
    const advance = !this.paused && !this._waiting && !this.seeking ? (performance.now() - this._anchor) / 1000 * this._rate : 0;
    return clamp(this._position + advance, 0, Number.isFinite(this.duration) ? this.duration : Infinity);
  }
  set currentTime(value) {
    if (!Number.isFinite(value)) return;
    this._position = clamp(value, 0, Number.isFinite(this.duration) ? this.duration : Infinity);
    this._anchor = performance.now(); this.seeking = true; this.ended = false;
    this._emit('seeking');
    void this._command('seek', { position: this._position }).catch((error) => this._fail(error));
  }
  get playbackRate() { return this._rate; }
  set playbackRate(value) {
    if (!Number.isFinite(value) || value <= 0 || value > 4 || value === this._rate) return;
    this._position = this.currentTime; this._anchor = performance.now(); this._rate = value;
    this._emit('ratechange');
    if (this.readyState) void this._command('rate', { rate: value }).catch((error) => this._fail(error));
  }
  _emit(type) { this.dispatchEvent(new Event(type)); }
  _fail(error) {
    if (error?.name === 'AbortError') return;
    this.error = error; this.paused = true; this._emit('pause'); this._emit('error');
  }
  _accept(state) {
    if (!state || state.session !== this.src || state.revision < this._revision || state.serial <= this._serial) return;
    this._serial = state.serial;
    const before = { paused: this.paused, ended: this.ended, seeking: this.seeking, waiting: this._waiting, rate: this._rate };
    this._position = state.position; this.duration = state.duration; this._rate = state.rate;
    this._anchor = performance.now(); this.paused = state.paused; this.ended = state.ended;
    this.seeking = state.seeking; this._waiting = state.waiting; this.readyState = state.ready ? 4 : 0;
    if (state.event === 'error') { this._fail(Error('原生音频解码失败')); return; }
    if (before.rate !== this._rate) this._emit('ratechange');
    if (before.paused !== this.paused) this._emit(this.paused ? 'pause' : 'play');
    if (before.waiting !== this._waiting) this._emit(this._waiting ? 'waiting' : 'playing');
    if (before.seeking && !this.seeking) this._emit('seeked');
    if (!before.ended && this.ended) this._emit('ended');
    this._emit('timeupdate');
  }
  _command(action, fields = {}) {
    if (!this.src || !this.readyState) return Promise.reject(Error('音频尚未准备好'));
    const session = this.src, revision = ++this._revision;
    const task = this._queue.catch(() => {}).then(async () => {
      if (session !== this.src) throw new DOMException('Audio changed', 'AbortError');
      let state;
      try { state = await this.bridge.command({ session, revision, action, ...fields }); }
      catch (error) {
        if (session !== this.src) throw new DOMException('Audio changed', 'AbortError');
        throw error;
      }
      this._accept(state); return state;
    });
    this._queue = task; return task;
  }
  async attach(blob, record = {}) {
    const generation = ++this._generation;
    const old = this.src; this.src = ''; this.readyState = 0;
    if (old) await this.bridge.release({ session: old });
    if (generation !== this._generation) return;
    this._blob = blob; this._record = record;
    this.src = randomId(); this._revision = 0; this._serial = 0;
    this._queue = Promise.resolve(); this.readyState = 0; this.paused = true; this.ended = false; this.error = null;
    this._position = 0; this._rate = 1; this._waiting = false; this.seeking = false;
    this.duration = NaN; this._loop = { start: null, end: null, all: false };
    const session = this.src;
    const current = () => { if (generation !== this._generation) throw new DOMException('Audio changed', 'AbortError'); };
    this._emit('loadstart');
    try {
      await this.bridge.begin({ session, size: blob.size, title: record.title || 'Lingua',
        extension: (record.audio?.name || 'audio.m4a').split('.').pop() });
      for (let offset = 0; offset < blob.size; offset += CHUNK) {
        current();
        const data = await base64(blob.slice(offset, offset + CHUNK)); current();
        await this.bridge.append({ session, offset, data });
      }
      current(); const state = await this.bridge.prepare({ session }); current();
      this._accept(state); this._emit('loadedmetadata'); this._emit('canplay');
    } catch (error) {
      await this.bridge.release({ session }).catch(() => {});
      if (generation === this._generation) { this.src = ''; this.readyState = 0; this.error = error; }
      throw error;
    }
  }
  async play() {
    const session = this.src;
    try { await this._command('play'); }
    catch (error) {
      if (session === this.src && error?.name !== 'AbortError' && !this.paused) { this.paused = true; this._emit('pause'); }
      throw error;
    }
  }
  pause() {
    this._position = this.currentTime; this._anchor = performance.now();
    if (!this.paused) { this.paused = true; this._emit('pause'); }
    if (this.readyState) void this._command('pause').catch((error) => this._fail(error));
  }
  setMetadata({ title }) {
    if (this.readyState) void this._command('metadata', { title }).catch(() => {});
  }
  setLoop({ start, end, all }) {
    this._loop = { start, end, all };
    if (this.readyState) void this._command('loop', { start, end, all }).catch((error) => this._fail(error));
  }
  async refresh() {
    if (!this.src || !this.readyState) return;
    try { this._accept(await this.bridge.state({ session: this.src })); } catch { /* Page may already be leaving. */ }
  }
  async release() {
    this._position = this.currentTime; ++this._generation;
    const session = this.src; this.src = ''; this.readyState = 0; this.paused = true;
    if (session) await this.bridge.release({ session }).catch(() => {});
  }
}
