/** Shared import/repair detection. Container extensions also cover missing MIME types. */
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv|mkv|avi)$/i;
const AUDIO_EXT = /\.(wav|mp3|m4a|m4b|flac|ogg|opus|aac|aiff?|wma)$/i;

export const MEDIA_ACCEPT = 'audio/*,video/*,.wav,.mp3,.m4a,.m4b,.flac,.ogg,.opus,.aac,.aif,.aiff,.wma,.mp4,.m4v,.webm,.mov,.ogv,.mkv,.avi';

export function mediaKind(file) {
  if (/^video\//i.test(file?.type || '')) return 'video';
  if (/^audio\//i.test(file?.type || '')) return 'audio';
  return VIDEO_EXT.test(file?.name || '') ? 'video' : 'audio';
}

export function isMediaFile(file) {
  return /^(audio|video)\//i.test(file?.type || '')
    || VIDEO_EXT.test(file?.name || '') || AUDIO_EXT.test(file?.name || '');
}
