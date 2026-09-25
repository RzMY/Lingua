/** Both native windows control the same media clock as the page. */
import { toast } from './util.js';
import { errorMessage } from './errors.js';

export function mediaControl(media, engine, action) {
  if (!media.src) return;
  if (action === 'play') {
    try { Promise.resolve(media.play()).catch((error) => toast(errorMessage(error, '播放失败，请重试'))); }
    catch (error) { toast(errorMessage(error, '播放失败，请重试')); }
  } else if (action === 'pause') media.pause();
  else if (action === 'seekbackward' || action === 'seekforward') {
    if (engine.track) engine.seek(media.currentTime + (action === 'seekbackward' ? -5 : 5));
  }
}

/** Send state changes, never frame/timeupdate traffic, to Android's RemoteActions. */
export function activityPipControls(bridge, media, engine, session) {
  let enabled = false, sequence = 0, pending = null, sending = false, last = '';
  const snapshot = () => ({ session, sequence: ++sequence,
    nativeAudioSession: media.nativeSession || '',
    playing: !!media.src && !media.paused && !media.ended,
    seekable: !!media.src && Number.isFinite(media.duration) && media.duration > 0 });
  async function send() {
    if (sending || !pending) return;
    const value = pending; pending = null; sending = true;
    try { await bridge.updatePip(value); }
    catch { last = ''; }
    finally { sending = false; if (pending) void send(); }
  }
  function sync() {
    if (!enabled) return;
    const value = snapshot(), key = `${value.playing}|${value.seekable}`;
    if (key === last) return;
    last = key; pending = value; void send();
  }
  const events = ['play', 'pause', 'ended', 'emptied', 'loadedmetadata', 'durationchange'];
  for (const event of events) media.addEventListener(event, sync);
  return {
    snapshot,
    activate(on) { enabled = on; last = ''; if (on) sync(); else pending = null; },
    control(detail) { if (enabled && detail.session === session) mediaControl(media, engine, detail.action); },
    dispose() { enabled = false; pending = null; for (const event of events) media.removeEventListener(event, sync); },
  };
}
