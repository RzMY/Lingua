/**
 * 曲目数据 + 供渲染循环使用的扁平索引.
 *
 * 数据来自 IndexedDB (分析后端返回的 track.json 原样存着), 音频来自同一条记录里的
 * Blob —— 所以构造函数只吃「已经拿到手的对象」, 不再自己发请求。
 *
 * 所有时间轴都压成 `Float32Array`, 于是每帧的定位就是一次数组二分/指针前进,
 * 完全不需要遍历对象或触发任何 GC。
 *
 * `track.json` 是自描述的: `lang` 块里写着这门语言叫什么、用什么文字、有哪些显示层
 * (`layers`) 和功能 (`features`)。渲染与设置面板一律读它, 所以前端没有一处硬编码
 * 某门语言 —— 后端加一门语言, 前端自动跟上。
 */

import { sourceSpec } from './langs.js';

const EMPTY_I32 = new Int32Array(0);

const MIN_WORD_DUR = 0.02;

export class Track {
  /**
   * @param {object} data     track.json
   * @param {string} audioUrl 音频的 blob URL (由 library.audioUrl 生成)
   */
  static fromData(data, audioUrl = '') {
    return new Track(data || {}, audioUrl);
  }

  constructor(data, audioUrl = '') {
    this.raw = data;
    this.id = data.id || '';
    this.title = data.title || data.id || '未命名';
    this.posLegend = data.posLegend || {};
    this.hasWordTiming = !!data.hasWordTiming;

    // 语言自述来自 track.json; 万一缺了 (手工拼的数据) 就退回前端内置的语言目录
    const spec = (data.lang && data.lang.code) ? data.lang : sourceSpec(data.language || 'ja');
    this.lang = spec.code;
    this.langName = spec.name || spec.code;
    this.script = spec.script || 'latin';
    this.space = spec.spaceDelimited !== false;
    /** @type {{read?: string, roman?: string}} 各显示层在这门语言里叫什么 */
    this.layers = (spec.layers && typeof spec.layers === 'object') ? spec.layers : {};
    this.layerOrder = (Array.isArray(spec.layerOrder) ? spec.layerOrder : Object.keys(this.layers))
      .filter((k) => k === 'read' || k === 'roman');
    this.features = Array.isArray(spec.features) && spec.features.length
      ? spec.features : ['tr', ...this.layerOrder, 'pos', 'card'];

    this.audioUrl = audioUrl;
    this.duration = (data.audio && data.audio.duration) || 0;

    const sentences = (this.sentences = data.sentences || []);
    const S = (this.S = sentences.length);
    this.sStart = new Float32Array(S);
    this.sEnd = new Float32Array(S);
    this.sFirst = S ? new Int32Array(S) : EMPTY_I32;
    this.sCount = S ? new Int32Array(S) : EMPTY_I32;

    // 先数一遍需要进入时间轴的单词 (有时间戳、且不是标点)
    let n = 0;
    for (let i = 0; i < S; i++) {
      const s = sentences[i];
      s.words = s.words || [];
      // 后端不再下发空译文字段, 这里补上, 免得各处判 undefined
      if (s.translation === undefined) s.translation = '';
      if (s.wordTiming) {
        for (const w of s.words) if (w.pos !== 'punct' && w.start != null) n++;
      }
    }
    this.N = n;
    this.wStart = new Float32Array(n);
    this.wEnd = new Float32Array(n);
    this.wSent = new Int32Array(n);
    this.wIdx = new Int32Array(n);

    let k = 0;
    for (let i = 0; i < S; i++) {
      const s = sentences[i];
      this.sStart[i] = s.start || 0;
      this.sEnd[i] = s.end || 0;
      this.sFirst[i] = k;
      if (s.wordTiming) {
        const words = s.words;
        for (let j = 0; j < words.length; j++) {
          const w = words[j];
          if (w.pos === 'punct' || w.start == null) continue;
          this.wStart[k] = w.start;
          this.wEnd[k] = Math.max(w.end, w.start + MIN_WORD_DUR);
          this.wSent[k] = i;
          this.wIdx[k] = j;
          k++;
        }
      }
      this.sCount[i] = k - this.sFirst[i];
    }
    if (!this.duration && S) this.duration = this.sEnd[S - 1];
  }

  /** 词性标签的本地化名称. */
  posLabel(tag) {
    const entry = this.posLegend[tag];
    return (entry && (entry.label || entry.labelEn)) || tag;
  }

  /** 某个显示层在这门语言里叫什么 (不支持就返回空串). */
  layerLabel(key) {
    return this.layers[key] || '';
  }

  /** 这条音频支持某个开关吗. */
  supports(key) {
    return this.features.includes(key);
  }
}
