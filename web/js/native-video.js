/** AVPlayer owns sound/time; the permanently muted video renders foreground/PiP frames. */
import { NativeAudio } from './native-audio.js';
import { extractMp4Audio } from './mp4-audio.js';

const SEEK_INTERVAL = 1500;
const SOFT_DRIFT = 0.08;
const HARD_DRIFT = 1;

export class NativeVideo extends NativeAudio {
  constructor(bridge, video) {
    super(bridge);
    this.video = video; this._url = ''; this._volume = 1; this._muted = false;
    this._visualPlaying = false; this._visualRequest = null; this._visualSeek = null;
    this._visualRate = 1; this._needsAlign = true; this._settleUntil = 0;
    this._refreshing = false; this._resumeEpoch = 0;
    video.muted = true;
    for (const event of ['timeupdate', 'play', 'pause', 'seeking', 'seeked', 'ratechange', 'ended', 'waiting', 'playing']) {
      this.addEventListener(event, () => {
        if (event === 'seeking' || event === 'seeked') this._needsAlign = true;
        this._syncVideo();
      });
    }
    video.addEventListener('loadedmetadata', () => this._syncVideo());
    video.addEventListener('canplay', () => this._syncVideo());
    for (const event of ['enterpictureinpicture', 'leavepictureinpicture', 'webkitpresentationmodechanged']) {
      video.addEventListener(event, () => this._syncVideo());
    }
    // Only explicit controls in a system video PiP may change native playback.
    // Inline WebKit pause events (e.g. background suspension) never stop audio.
    video.addEventListener('pause', () => {
      if (this._inVideoPip() && this._visualPlaying && !video.ended && !video.seeking && !this.paused) this.pause();
    });
    video.addEventListener('play', () => {
      if (this._inVideoPip() && !this._visualPlaying && this.paused) void this.play().catch((error) => this._fail(error));
    });
    video.addEventListener('seeking', () => {
      const internal = this._visualSeek !== null && Math.abs(video.currentTime - this._visualSeek) < 0.2;
      if (this._inVideoPip() && !internal) this.currentTime = video.currentTime;
    });
    video.addEventListener('seeked', () => {
      this._visualSeek = null;
      // Give the decoder time to render after a seek before judging clock drift.
      this._settleUntil = performance.now() + SEEK_INTERVAL;
      this._syncVideo();
    });
    video.addEventListener('ratechange', () => {
      if (this._inVideoPip() && video.playbackRate !== this._visualRate) this.playbackRate = video.playbackRate;
    });
    video.addEventListener('volumechange', () => { if (!video.muted) video.muted = true; });
  }
  get volume() { return this._volume; }
  set volume(value) {
    this._volume = Math.max(0, Math.min(1, Number(value) || 0)); this._setVolume();
  }
  get muted() { return this._muted; }
  set muted(value) { this._muted = !!value; this._setVolume(); }
  get disablePictureInPicture() { return this.video.disablePictureInPicture; }
  set disablePictureInPicture(value) { this.video.disablePictureInPicture = value; }
  _setVolume() {
    if (this.readyState) void this._command('volume', { volume: this._volume, muted: this._muted }).catch((error) => this._fail(error));
    this._emit('volumechange');
  }
  _inVideoPip() {
    return document.pictureInPictureElement === this.video || this.video.webkitPresentationMode === 'picture-in-picture';
  }
  async _visibilityChanged() {
    const epoch = ++this._resumeEpoch;
    if (document.hidden) {
      if (!this._inVideoPip()) { this._visualSeek = null; this._visualRequest = null; }
      this._refreshing = false; this._syncVideo(); return;
    }
    // performance.now() and the WebKit decoder may have stopped while AVPlayer
    // continued. Never seek to an extrapolated pre-background snapshot.
    this._refreshing = true; this._needsAlign = true;
    this._syncVideo();
    await this.refresh();
    if (epoch !== this._resumeEpoch) return;
    this._refreshing = false; this._syncVideo();
  }
  _playVideo() {
    if (!this.video.paused || this._visualRequest) return;
    let pending;
    try { pending = this.video.play(); } catch { return; }
    this._visualRequest = pending;
    Promise.resolve(pending).catch(() => { /* Foreground/user activation may be needed for frames. */ })
      .finally(() => { if (this._visualRequest === pending) this._visualRequest = null; });
  }
  _syncVideo() {
    if (!this._url || !this.video.readyState) return;
    const showFrames = (!document.hidden || this._inVideoPip()) && !this._refreshing;
    this._visualPlaying = showFrames && !this.paused && !this.ended && !this._waiting && !this.seeking;
    if (showFrames) {
      const position = this.currentTime, drift = position - this.video.currentTime, now = performance.now();
      let rate = this.playbackRate;
      if (!this.seeking && !this.video.seeking && this._visualSeek === null) {
        // Explicit seeks/resume align once. During playback, small discrepancies
        // are corrected by rate, not repeated currentTime writes every 100 ms.
        if (this._needsAlign || (Math.abs(drift) > HARD_DRIFT && now >= this._settleUntil)) {
          this._needsAlign = false;
          if (Math.abs(drift) > 0.04) {
            this._visualSeek = position; this._settleUntil = now + SEEK_INTERVAL;
            this.video.currentTime = position;
          }
        } else if (this._visualPlaying && now >= this._settleUntil && Math.abs(drift) > SOFT_DRIFT) {
          rate *= 1 + Math.max(-0.05, Math.min(0.05, drift * 0.1));
        }
      }
      this._visualRate = rate;
      if (this.video.playbackRate !== rate) this.video.playbackRate = rate;
    } else if (!this._inVideoPip()) {
      this._needsAlign = true;
    }
    if (this._visualPlaying) this._playVideo();
    else if (!this.video.paused) this.video.pause();
  }
  async _playbackSource(blob, record, signal) {
    const original = await super._playbackSource(blob, record);
    if (!/^(mp4|m4v|mov)$/i.test(original.extension) && !/^video\/(mp4|quicktime)$/i.test(blob.type)) return original;
    try {
      // Keep the original video for WebKit. AVPlayer only needs the lossless
      // audio track, so video bytes never cross the base64 plugin bridge.
      const { file } = await extractMp4Audio(new File([blob], record.audio?.name || 'video.mp4', { type: blob.type }), { signal });
      if (file.size < blob.size) return { blob: file, extension: 'm4a' };
    } catch (error) {
      if (signal.aborted) throw error;
      // Fragmented MP4 / other codecs still use AVPlayer's original-file path.
    }
    return original;
  }
  async attach(blob, record = {}) {
    if (this._url) URL.revokeObjectURL(this._url);
    const url = this._url = URL.createObjectURL(blob);
    this._needsAlign = true; this._visualSeek = null; this._settleUntil = 0;
    this._visualRequest = null;
    this.video.muted = true; this.video.src = this._url;
    try {
      await super.attach(blob, record);
      if (this._url === url) { this._setVolume(); this._syncVideo(); }
    }
    catch (error) {
      if (this._url === url) this._clearVideo();
      throw error;
    }
  }
  async play() {
    // Call WebKit synchronously while the user's activation is still available.
    if (!document.hidden || this._inVideoPip()) { this._visualPlaying = true; this._playVideo(); }
    try { await super.play(); } finally { this._syncVideo(); }
  }
  _clearVideo() {
    ++this._resumeEpoch; this._refreshing = false; this._visualRequest = null; this._needsAlign = true;
    this._visualPlaying = false; this._visualSeek = null; this.video.pause(); this.video.removeAttribute('src'); this.video.load();
    if (this._url) URL.revokeObjectURL(this._url);
    this._url = '';
  }
  async release() { this._clearVideo(); await super.release(); }
}
