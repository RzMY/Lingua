/** 收藏详情: 已有讲解、笔记与独立片段播放。 */
import { editFavorite, enrichFavorite } from './favorites.js';
import { readFavoriteContent } from './favorite-learning.js';
import { get } from './store.js';
import { audioBlob } from './library.js';
import { el, icon, toast, copyText } from './util.js';
import { sourceName } from './langs.js';
import { button, buttonBar, textField } from './rows.js';
import { openSheet, closeSheet } from './sheet.js';
import { errorMessage } from './errors.js';
import { renderMarkdown } from './md.js';
import { createPronunciation, wordAudioRange, clipAudioRange } from './pronunciation.js';
import { readTrackCfg } from './trackcfg.js';

function section(title, content) {
  const box = el('section', 'fav-learning-section');
  box.append(el('h3', null, title), content);
  return box;
}

function learningContent(f) {
  const content = el('div');
  const info = f.learning || {};
  const bits = [f.pos, f.lemma ? `原形 ${f.lemma}${info.lemmaRoman ? ` (${info.lemmaRoman})` : ''}` : '',
    info.conj, info.parts, info.posDetail].filter(Boolean);
  if (bits.length) content.append(el('p', 'fav-meta', bits.join(' · ')));
  if (f.gloss) content.append(el('p', 'fav-gloss', f.gloss));
  if (f.kind === 'word') { const context = el('blockquote', 'fav-context', f.context); context.lang = f.lang; content.append(context); }
  if (f.translation) content.append(el('p', 'fav-translation', f.translation));
  if (f.explanation) content.append(section('词义讲解', el('p', 'fav-explanation', f.explanation)));
  if (info.forms?.length) {
    const forms = el('div', 'fav-forms');
    for (const form of info.forms) {
      const row = el('div', 'fav-form');
      const text = el('b', null, form.text); text.lang = f.lang;
      row.append(text); if (form.gloss) row.append(el('span', null, form.gloss));
      forms.append(row);
    }
    content.append(section('相关词组与形式', forms));
  }
  if (info.words?.length) {
    const words = el('div', 'fav-breakdown');
    for (const word of info.words) {
      const row = el('div', 'fav-breakdown-word');
      const original = el('div'); original.lang = f.lang;
      original.append(el('b', null, word.text));
      if (word.reading || word.roman) original.append(el('span', 'fav-reading', [...new Set([word.reading, word.roman].filter(Boolean))].join(' · ')));
      const meta = [word.pos, word.lemma && word.lemma !== word.text ? '原形 ' + word.lemma : '',
        word.lemmaRoman, word.conj, word.parts, word.posDetail].filter(Boolean);
      row.append(original, el('p', 'fav-meta', meta.join(' · '))); words.append(row);
    }
    content.append(section('句子拆解', words));
  }
  if (info.explanations?.length) {
    const notes = el('div', 'fav-model-notes');
    for (const explanation of info.explanations) {
      const entry = el('div', 'fav-model-note');
      if (explanation.question) entry.append(el('p', 'fav-model-question', explanation.question));
      entry.append(renderMarkdown(explanation.answer)); notes.append(entry);
    }
    content.append(section('大模型讲解', notes));
  }
  return content;
}

export function openFavoriteDetail(f, { onSave = () => {} } = {}) {
  let current = f, closed = false, blob = null, audioMessage = '原文音频准备中…';
  const body = el('div', 'pane fav-detail');
  const text = el('h2', 'fav-text', f.text); text.lang = f.lang;
  body.append(el('p', 'fav-meta', `${sourceName(f.lang)} · ${f.kind === 'word' ? '单词' : '句子'}`), text);
  const readingLine = el('div', 'fav-reading-line');
  const reading = el('span', 'fav-reading');
  const roman = el('p', 'fav-reading');
  function paintReading(value) {
    reading.textContent = value.reading; reading.hidden = !value.reading;
    roman.textContent = value.roman; roman.hidden = !value.roman || value.roman === value.reading;
  }
  paintReading(f);
  const sounds = el('div', 'fav-sounds');
  sounds.setAttribute('role', 'group'); sounds.setAttribute('aria-label', '收藏发音');
  const soundStatus = el('p', 'fav-audio-status'); soundStatus.setAttribute('role', 'status');
  const sourceTrack = { lang: f.lang, duration: 0 }, audioRange = { start: NaN, end: NaN };
  const choices = new Map();
  const preferences = readTrackCfg(f.track, f.lang).pronunciation;
  const session = createPronunciation({ track: sourceTrack, word: { text: f.text }, audioRange,
    getAudioBlob: () => blob, onState: ({ state, source, message }) => {
      for (const [key, control] of choices) {
        control.setAttribute('aria-pressed', String(source === key && ['playing', 'loading'].includes(state)));
        control.setAttribute('aria-busy', String(source === key && state === 'loading'));
        control.classList.toggle('is-playing', source === key && state === 'playing');
      }
      soundStatus.textContent = message || audioMessage;
      soundStatus.hidden = !soundStatus.textContent;
    } });
  for (const [source, label, accessibleLabel] of [['audio', '音频', '原文音频'], ['standard', '标准', '标准发音']]) {
    const control = el('button', 'fav-sound-source'); control.type = 'button';
    control.append(el('span', null, label), icon('i-speaker', 'ic ic-sm'));
    control.setAttribute('aria-label', accessibleLabel);
    control.addEventListener('click', () => {
      if (session.active === source) session.stop(); else void session.play(source, preferences);
    });
    control.setAttribute('aria-pressed', 'false');
    control.disabled = source === 'audio' || !!session.availability()[source];
    control.title = source === 'audio' ? audioMessage : session.availability().standard;
    choices.set(source, control); sounds.append(control);
  }
  soundStatus.textContent = audioMessage;
  const learning = el('div', 'fav-learning'); learning.append(learningContent(f));
  const note = textField('学习笔记', { value: f.note, placeholder: '写下联想、用法或自己的例句…', rows: 4 });
  note.input.maxLength = 4000;
  const save = button('保存笔记', { main: true, onPick: async () => {
    save.disabled = true;
    try {
      await editFavorite(f.id, { note: note.input.value });
      if (!closed) closeSheet();
      await onSave(); toast('笔记已保存');
    } catch (error) { toast(errorMessage(error, '笔记保存失败')); }
    finally { save.disabled = false; }
  } });
  readingLine.append(reading, sounds);
  body.append(readingLine, roman, soundStatus, learning, note, buttonBar(button('复制', { glyph: 'i-copy', onPick: async () => {
    toast(await copyText([current.text, current.reading, current.roman, learning.textContent, note.input.value].filter(Boolean).join('\n')) ? '已复制' : '复制失败');
  } }), save));
  function dispose() {
    closed = true; session.dispose(); blob = null;
    window.removeEventListener('pagehide', leave);
  }
  function leave() { if (!closed) closeSheet(); }
  window.addEventListener('pagehide', leave);
  openSheet('收藏详情', body, { cls: 'sheet-tall', onClose: dispose });

  void (async () => {
    try {
      const [content, record] = await Promise.all([readFavoriteContent(f), get('tracks', f.track, { strict: true })]);
      if (closed) return;
      current = content.favorite;
      paintReading(current);
      learning.replaceChildren(learningContent(current));
      if (JSON.stringify(current) !== JSON.stringify(f)) {
        void enrichFavorite(current).catch(() => { if (!closed) toast('讲解快照保存失败，请重试'); });
      }
      const { track, location } = content;
      sourceTrack.duration = track?.duration || record?.duration || 0;
      const wordRange = location?.w ? wordAudioRange(location.s, location.w, sourceTrack.duration) : null;
      const range = wordRange || clipAudioRange(location?.s || (!track ? f : null), sourceTrack.duration);
      if (!record || record.audio?.missing) audioMessage = '原文音频不可用，请补充源媒体文件';
      else if (!range) audioMessage = '原文已变化，暂时无法定位音频片段';
      else {
        const loaded = await audioBlob(f.track);
        if (closed) return;
        if (loaded instanceof Blob && loaded.size) {
          blob = loaded; Object.assign(audioRange, range); audioMessage = '';
          const audio = choices.get('audio'); audio.disabled = false;
          audio.setAttribute('aria-label', f.kind === 'word' && !wordRange ? '原句音频' : '原文音频');
        } else audioMessage = '原文音频不可用，请补充源媒体文件';
      }
    } catch (error) {
      if (closed) return;
      audioMessage = errorMessage(error, '学习内容加载失败，请重新打开详情');
    }
    if (!closed) {
      choices.get('audio').title = audioMessage || '播放' + choices.get('audio').getAttribute('aria-label');
      soundStatus.textContent = audioMessage; soundStatus.hidden = !audioMessage;
    }
  })();
}
