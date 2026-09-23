import releaseConfig from '../release-config.json' with { type: 'json' };

export const CHANNELS = [
  { id: 'stable', label: '正式分支', description: '从 GitHub 最新正式 Release 检查更新，本地优先。' },
  { id: 'own', label: '自有分支', description: '从自托管站点的 mobile/manifest.json 检查更新，本地优先。' },
  { id: 'preview', label: '测试分支', description: '从滚动 Pre-release 检查更新，本地优先。' },
  { id: 'development', label: '开发分支', description: '直接联网打开调试网页，不加载本地前端；离线时可返回设置。' },
];
export const CHANNEL_KEY = 'lingua.channel';
export const OWN_KEY = 'lingua.own-url';
export const DEV_KEY = 'lingua.development-url';
export const PREVIOUS_CHANNEL_KEY = 'lingua.previous-channel';
export const DEFAULT_SOURCE = { channel: 'stable', ownUrl: '', developmentUrl: '' };

export function normalizeTarget(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); }
  catch { throw Error('请输入有效的 HTTPS 站点地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw Error('自有分支需要 HTTPS 站点地址，不含账号、查询参数或锚点');
  }
  if (url.pathname.endsWith('/index.html')) url.pathname = url.pathname.slice(0, -10);
  else if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

export function developmentUrl(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); }
  catch { throw Error('请输入有效的 HTTP 或 HTTPS 调试地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw Error('请输入 HTTP 或 HTTPS 调试地址');
  }
  return url.href;
}

export function normalizeSource(source = {}) {
  const channel = CHANNELS.some((item) => item.id === source.channel) ? source.channel : 'stable';
  const result = { channel, ownUrl: String(source.ownUrl || '').trim(), developmentUrl: String(source.developmentUrl || '').trim() };
  if (channel === 'own') result.ownUrl = normalizeTarget(result.ownUrl);
  if (channel === 'development') result.developmentUrl = developmentUrl(result.developmentUrl);
  return result;
}

export function sourceKey(source) {
  return JSON.stringify([source.channel, source.channel === 'own' ? source.ownUrl
    : source.channel === 'development' ? source.developmentUrl : releaseConfig.repository]);
}

export function releaseEndpoint(channel) {
  const base = `https://api.github.com/repos/${releaseConfig.repository}/releases`;
  return channel === 'preview' ? `${base}/tags/${encodeURIComponent(releaseConfig.previewTag)}` : `${base}/latest`;
}

function releaseAsset(release, name) {
  const asset = release.assets?.find((item) => item.name === name);
  if (!asset) throw Error(`该版本尚未提供 ${name}，请稍后检查`);
  const url = new URL(asset.browser_download_url);
  const prefix = `/${releaseConfig.repository}/releases/download/`;
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password
      || !url.pathname.startsWith(prefix) || decodeURIComponent(url.pathname.split('/').at(-1)) !== name) {
    throw Error('Release 资源地址无效');
  }
  // Rolling releases replace manifest.json; bypass stale redirect/CDN entries.
  if (name === 'manifest.json') url.searchParams.set('asset', String(asset.id));
  return url.href;
}

/** getJson is native HTTP in the app, injected in tests. No credentials are sent to GitHub. */
export async function fetchSourceManifest(source, getJson) {
  if (source.channel === 'development') throw Error('开发分支直接加载远端网页，不使用离线更新');
  if (source.channel === 'own') {
    const manifestUrl = new URL('mobile/manifest.json', normalizeTarget(source.ownUrl)).href;
    return { data: await getJson(manifestUrl), manifestUrl };
  }
  const release = await getJson(releaseEndpoint(source.channel));
  if (release.draft || (source.channel === 'stable' && release.prerelease)
      || (source.channel === 'preview' && (!release.prerelease || release.tag_name !== releaseConfig.previewTag))) {
    throw Error('没有可用的对应分支版本');
  }
  const manifestUrl = releaseAsset(release, 'manifest.json');
  const data = await getJson(manifestUrl);
  // This also binds the manifest and ZIP to the same release response during rolling publication.
  return { data, manifestUrl, bundleUrl: releaseAsset(release, data.bundle) };
}
