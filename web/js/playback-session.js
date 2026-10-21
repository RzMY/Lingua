/** Keep pronunciation media and speech on the same iOS playback category. */
export function preparePronunciationPlayback() {
  // `auto` lets WebKit change category after an <audio> is stopped/unloaded.
  // Keep playback for the document; restoring auto at each end would repeat
  // the category/volume transition before the next reference or standard tap.
  try {
    const session = globalThis.navigator?.audioSession;
    if (session && session.type !== 'playback') session.type = 'playback';
  } catch { /* Older WebKit and restricted documents keep their native fallback. */ }
}
