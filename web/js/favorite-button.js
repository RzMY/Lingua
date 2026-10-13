import { el, icon, toast } from './util.js';
import { favoriteDraft, getFavorite, saveFavorite, removeFavorite } from './favorites.js';
import { isDegraded } from './store.js';
import { errorMessage } from './errors.js';

/** 两种学习面板共用的收藏操作; 只在打开/数据变更时读取, 不进入播放循环。 */
export function favoriteButton(getOptions, { signal, className = 'favorite-toggle' } = {}) {
  const b = el('button', className);
  b.type = 'button';
  const label = el('span', null, '收藏');
  b.append(icon('i-bookmark', 'ic ic-sm'), label);
  b.setAttribute('aria-pressed', 'false');
  let busy = false, version = 0;
  const paint = (saved) => {
    label.textContent = saved ? '已收藏' : '收藏';
    b.setAttribute('aria-pressed', String(saved));
    b.title = saved ? '取消收藏' : '加入收藏夹';
  };
  const refresh = async () => {
    const serial = ++version;
    try {
      const saved = await getFavorite(favoriteDraft(getOptions()).id);
      if (!signal?.aborted && serial === version) paint(!!saved);
    } catch { /* 点击时重试读取并显示具体错误。 */ }
  };
  b.addEventListener('click', async () => {
    if (busy) return;
    busy = true; b.disabled = true; version++;
    try {
      const draft = favoriteDraft(getOptions());
      const old = await getFavorite(draft.id);
      if (old) await removeFavorite(draft.id);
      else await saveFavorite(favoriteDraft(getOptions()));
      paint(!old);
      toast(old ? '已取消收藏' : isDegraded() ? '已临时收藏；本地存储不可用，刷新后会丢失' : '已加入收藏夹');
    } catch (error) { toast(errorMessage(error, '收藏未保存，请重试')); }
    finally { busy = false; b.disabled = false; }
  }, { signal });
  window.addEventListener('favoriteschange', refresh, { signal });
  window.addEventListener('focus', refresh, { signal });
  void refresh();
  return b;
}
