/** 收藏页按需装载, 复用首页配色、分段控件和底部弹层。 */
import { listFavorites, filterFavorites, editFavorite, removeFavorite, saveFavorite, favoriteSourceURL } from './favorites.js';
import { get, isDegraded } from './store.js';
import { el, icon, toast, debounce } from './util.js';
import { sourceName } from './langs.js';
import { button, buttonBar, segRow } from './rows.js';
import { openSheet, closeSheet } from './sheet.js';
import { errorMessage } from './errors.js';
import { openFavoriteDetail } from './favorites-detail.js';

const kindLabel = (f) => f.kind === 'word' ? '单词' : '句子';
const dateLabel = (f) => new Date(f.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });

export function createFavoritesPage(root) {
  let items = [], filtered = [], limit = 40, serial = 0, selfTest = false, removed = null;
  const filters = { query: '', kind: '', lang: '', status: '', sort: 'new' };
  const wrap = el('div', 'favorites');
  const controls = el('div', 'fav-controls');
  const toolbar = el('div', 'fav-toolbar');
  const review = button('自测', { onPick: () => {
    selfTest = !selfTest; review.setAttribute('aria-pressed', String(selfTest));
    for (const card of list.children) card.setSelfTest?.(selfTest);
  } });
  review.setAttribute('aria-pressed', 'false');
  review.classList.add('fav-review');
  review.title = '隐藏释义，试着回想后再查看';

  const finder = el('div', 'finder');
  const input = el('input');
  input.type = 'search'; input.placeholder = '搜索收藏';
  input.setAttribute('aria-label', '搜索收藏');
  const clear = button('', { glyph: 'i-x', onPick: () => { input.value = ''; filters.query = ''; limit = 40; render(); input.focus(); } });
  clear.classList.add('fav-search-clear');
  clear.setAttribute('aria-label', '清空'); clear.title = '清空搜索';
  clear.hidden = true;
  input.addEventListener('input', debounce(() => {
    filters.query = input.value; limit = 40; render();
  }, 120));
  finder.append(icon('i-search', 'ic ic-sm'), input, clear);

  const options = el('div', 'fav-filters');
  const filterRows = [];
  function filterGroup(label, key, entries) {
    const field = el('div');
    let row, previous = '';
    const control = {
      refresh: () => row.refresh(),
      setEntries(next) {
        const signature = JSON.stringify(next);
        if (signature === previous) return;
        previous = signature;
        row = segRow(label, '', () => filters[key], (value) => {
          filters[key] = value; limit = 40; render();
        }, next);
        row.classList.add('fav-filter-row'); field.replaceChildren(row);
      },
    };
    control.setEntries(entries);
    filterRows.push(control); options.append(field); return control;
  }
  filterGroup('收藏类型', 'kind', [['', '全部'], ['word', '单词'], ['sentence', '句子']]);
  const languages = filterGroup('语言', 'lang', [['', '全部']]);
  filterGroup('学习状态', 'status', [['', '全部状态'], ['pending', '待复习'], ['mastered', '已掌握']]);
  filterGroup('排序', 'sort', [['new', '最近收藏'], ['old', '最早收藏'], ['text', '原文顺序']]);
  function resetFilters() {
    Object.assign(filters, { query: '', kind: '', lang: '', status: '', sort: 'new' });
    input.value = '';
    limit = 40; render();
  }
  const filterPanel = el('div', 'fav-filter-panel');
  filterPanel.append(options, buttonBar(button('重置筛选', { onPick: resetFilters }),
    button('完成', { main: true, onPick: closeSheet })));
  const filterButton = button('', { glyph: 'i-filter', onPick: () => {
    openSheet('筛选收藏', filterPanel, { onClose: () => filterButton.setAttribute('aria-expanded', 'false') });
    filterButton.setAttribute('aria-expanded', 'true');
  } });
  filterButton.classList.add('fav-filter-button');
  filterButton.setAttribute('aria-label', '筛选收藏');
  filterButton.setAttribute('aria-haspopup', 'dialog');
  filterButton.setAttribute('aria-expanded', 'false');
  filterButton.title = '类型、语言、学习状态与排序';
  toolbar.append(finder, review, filterButton);
  const warning = el('p', 'warn'); warning.hidden = true;
  const undoBar = el('div', 'fav-undo'); undoBar.hidden = true;
  undoBar.setAttribute('role', 'status');
  const undoText = el('span');
  const undo = button('撤销', { onPick: async () => {
    if (!removed) return;
    undo.disabled = true;
    try { await saveFavorite(removed); removed = null; undoBar.hidden = true; await refresh(); }
    catch (error) { toast(errorMessage(error, '恢复失败，请重试')); }
    finally { undo.disabled = false; }
  } });
  undoBar.append(undoText, undo);
  const activeFilters = el('div', 'fav-active-filters');
  activeFilters.setAttribute('role', 'group'); activeFilters.setAttribute('aria-label', '已应用的筛选');
  const list = el('div', 'fav-list');
  const more = button('加载更多', { onPick: () => { limit += 40; render(); } });
  more.classList.add('fav-more');
  controls.append(toolbar, activeFilters);
  wrap.append(warning, controls, undoBar, list, more);
  root.replaceChildren(wrap);

  async function source(f) {
    try {
      if (!await get('tracks', f.track, { strict: true })) {
        toast('源媒体已删除，收藏原文和笔记仍保留'); return;
      }
      location.href = favoriteSourceURL(f);
    } catch (error) { toast(errorMessage(error, '无法打开原文')); }
  }

  function detail(f) {
    openFavoriteDetail(f, { onSave: refresh });
  }

  function card(f) {
    const box = el('article', 'fav-card');
    box.classList.toggle('fav-card-sentence', f.kind === 'sentence');
    box.addEventListener('click', (event) => {
      if (!event.target.closest('button, a, input, textarea, select, .fav-actions')) detail(f);
    });
    const meta = el('div', 'fav-meta');
    const date = el('time', null, dateLabel(f)); date.dateTime = new Date(f.createdAt).toISOString();
    meta.append(el('span', 'fav-badge', kindLabel(f)), el('span', null, sourceName(f.lang)), date);
    const title = el('button', 'fav-title', f.text); title.type = 'button'; title.lang = f.lang;
    title.setAttribute('aria-label', `查看收藏详情：${f.text}`);
    title.addEventListener('click', () => detail(f));
    box.append(meta, title);
    if (f.reading || f.roman) box.append(el('p', 'fav-reading', [...new Set([f.reading, f.roman].filter(Boolean))].join(' · ')));
    const answer = el('div', 'fav-answer');
    if (f.gloss) answer.append(el('p', 'fav-gloss', f.gloss));
    if (f.kind === 'word') { const context = el('p', 'fav-context', f.context); context.lang = f.lang; answer.append(context); }
    if (f.translation) answer.append(el('p', 'fav-translation', f.translation));
    if (f.note) answer.append(el('p', 'fav-note', '笔记 · ' + f.note));
    if (!f.gloss && !f.translation && !f.note) answer.append(el('p', 'fav-meta', '点击卡片添加学习笔记'));
    const content = el('div', 'fav-content');
    const reveal = button('查看释义', { glyph: 'i-eye', onPick: () => {
      box.setSelfTest(false); title.focus({ preventScroll: true });
    } });
    reveal.classList.add('fav-reveal');
    box.setSelfTest = (concealed) => {
      content.classList.toggle('is-concealed', concealed);
      answer.inert = concealed; answer.setAttribute('aria-hidden', String(concealed));
      reveal.inert = !concealed; reveal.setAttribute('aria-hidden', String(!concealed));
    };
    box.setSelfTest(selfTest);
    content.append(answer, reveal); box.append(content);
    const status = button('掌握', { onPick: async () => {
      status.disabled = true;
      status.setAttribute('aria-busy', 'true');
      try {
        Object.assign(f, await editFavorite(f.id, { mastered: !f.mastered }));
        paintMastery();
        if (filters.status) await refresh();
      } catch (error) { toast(errorMessage(error, '学习状态保存失败')); }
      finally { status.disabled = false; status.setAttribute('aria-busy', 'false'); }
    } });
    status.classList.add('fav-mastery');
    const mark = el('span', 'fav-mastery-mark'); mark.setAttribute('aria-hidden', 'true');
    mark.append(icon('i-check', 'ic ic-sm')); status.prepend(mark);
    function paintMastery() {
      status.setAttribute('aria-pressed', String(f.mastered));
      status.setAttribute('aria-label', f.mastered ? '已掌握' : '标为掌握');
      status.title = f.mastered ? '移回待复习' : '标为已掌握';
    }
    paintMastery();
    const remove = button('', { glyph: 'i-trash', onPick: async () => {
      remove.disabled = true;
      try {
        await removeFavorite(f.id); removed = f; undoText.textContent = '已移除这条收藏'; undoBar.hidden = false; await refresh();
      } catch (error) { toast(errorMessage(error, '移除失败，请重试')); remove.disabled = false; }
    } });
    remove.setAttribute('aria-label', `移除收藏：${f.text}`); remove.title = '移除收藏';
    remove.classList.add('fav-remove');
    const back = button('回到原文', { glyph: 'i-play', onPick: () => source(f) });
    back.classList.add('fav-back');
    const actions = buttonBar(back, status, remove);
    actions.classList.add('fav-actions');
    box.append(actions);
    return box;
  }

  function render() {
    filtered = filterFavorites(items, filters);
    filterRows.forEach((row) => row.refresh());
    clear.hidden = !input.value;
    const hasFilters = Boolean(filters.kind || filters.lang || filters.status || filters.sort !== 'new');
    filterButton.classList.toggle('is-active', hasFilters);
    filterButton.setAttribute('aria-label', hasFilters ? '筛选收藏（已应用）' : '筛选收藏');
    const chips = [];
    for (const [key, label] of [['kind', filters.kind === 'word' ? '单词' : '句子'], ['lang', sourceName(filters.lang)], ['status', filters.status === 'mastered' ? '已掌握' : '待复习'],
      ['sort', filters.sort === 'old' ? '最早收藏' : '原文顺序']]) {
      if (!filters[key] || (key === 'sort' && filters.sort === 'new')) continue;
      const chip = button(label, { glyph: 'i-x', onPick: () => {
        filters[key] = key === 'sort' ? 'new' : ''; limit = 40; render(); filterButton.focus();
      } });
      chip.classList.add('fav-filter-chip');
      chip.setAttribute('aria-label', `取消筛选：${label}`);
      chips.push(chip);
    }
    activeFilters.replaceChildren(...chips); activeFilters.hidden = !chips.length;
    review.disabled = !items.length;
    list.replaceChildren(...filtered.slice(0, limit).map(card));
    more.hidden = filtered.length <= limit;
    if (!filtered.length) {
      const blank = el('div', 'fav-blank');
      blank.append(icon('i-bookmark'), el('b', null, items.length ? '没有匹配的收藏' : '收藏你的第一个词句'));
      if (items.length) blank.append(button('重置筛选', { onPick: resetFilters }));
      list.append(blank);
    }
  }

  async function refresh() {
    const attempt = ++serial;
    try {
      const next = await listFavorites();
      if (attempt !== serial) return;
      items = next;
      const codes = [...new Set(items.map((f) => f.lang))].sort();
      languages.setEntries([['', '全部'], ...codes.map((code) => [code, sourceName(code)])]);
      if (!codes.includes(filters.lang)) filters.lang = '';
      warning.hidden = !isDegraded();
      warning.textContent = '本地存储不可用，当前收藏仅临时保存，刷新后会丢失。';
      render();
    } catch (error) {
      if (attempt !== serial) return;
      warning.hidden = false; warning.textContent = errorMessage(error, '收藏加载失败');
      warning.append(button('重试', { onPick: refresh }));
    }
  }
  window.addEventListener('focus', () => { if (!root.closest('[hidden]')) void refresh(); });
  window.addEventListener('pageshow', () => { if (!root.closest('[hidden]')) void refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !root.closest('[hidden]')) void refresh(); });
  void refresh();
  return { refresh };
}
