/**
 * 极简 markdown -> DOM.
 *
 * 只支持讲解会用到的子集 (标题/列表/引用/代码/粗斜体/链接), 但**全部用
 * `createElement` + `textContent` 拼**, 不碰 `innerHTML` —— 模型输出属于不可信
 * 文本, 直接塞 HTML 就是一个 XSS 入口。
 *
 * 流式渲染的做法是每来一段就整段重解析: 讲解文本通常只有几 KB, 重建这点 DOM
 * 远比维护增量状态划算, 而且天然不会出现半截语法渲染错乱。
 */

import { el } from './util.js';

const SAFE_SCHEME = /^(https?:|mailto:)/i;

function safeUrl(raw) {
  const url = String(raw || '').trim();
  return SAFE_SCHEME.test(url) ? url : '#';
}

/** 行内标记: **粗** __粗__ *斜* `码` [文本](链接) */
function inline(text, parent) {
  const re = /\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+)\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    if (m[1] || m[2]) parent.append(el('strong', null, m[1] || m[2]));
    else if (m[3]) parent.append(el('em', null, m[3]));
    else if (m[4]) parent.append(el('code', 'md-code', m[4]));
    else if (m[5]) {
      const a = el('a', 'md-a', m[5]);
      a.href = safeUrl(m[6]);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      parent.append(a);
    }
    last = re.lastIndex;
  }
  if (last < text.length) parent.append(text.slice(last));
}

/** 段落内的软换行保留成 <br>. */
function para(lines, cls) {
  const p = el('p', cls);
  lines.forEach((line, i) => {
    if (i) p.append(el('br'));
    inline(line, p);
  });
  return p;
}

export function renderMarkdown(src) {
  const frag = document.createDocumentFragment();
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    // 代码块
    const fence = trimmed.match(/^```(\w*)$/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) body.push(lines[i++]);
      i++;                                          // 吃掉收尾围栏 (没有也无所谓)
      const pre = el('pre', 'md-pre');
      pre.append(el('code', null, body.join('\n')));
      frag.append(pre);
      continue;
    }

    // 标题
    const head = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (head) {
      const level = Math.min(4, head[1].length);
      const node = el('h' + (level + 1), 'md-h' + level);
      inline(head[2].trim(), node);
      frag.append(node);
      i++;
      continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      frag.append(el('hr', 'md-hr'));
      i++;
      continue;
    }

    // 引用
    if (trimmed.startsWith('>')) {
      const body = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        body.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      const quote = el('blockquote', 'md-quote');
      quote.append(para(body));
      frag.append(quote);
      continue;
    }

    // 列表 (连续同类行合成一个 ul/ol)
    const bullet = trimmed.match(/^([-*+]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]);
      const list = el(ordered ? 'ol' : 'ul', 'md-list');
      while (i < lines.length) {
        const t = lines[i].trim();
        const m = t.match(/^([-*+]|\d+[.)])\s+(.*)$/);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        const item = el('li');
        inline(m[2], item);
        i++;
        // 缩进的续行并入同一个 li
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) &&
               !/^\s*([-*+]|\d+[.)])\s/.test(lines[i])) {
          item.append(' ');
          inline(lines[i].trim(), item);
          i++;
        }
        list.append(item);
      }
      frag.append(list);
      continue;
    }

    // 普通段落: 一直吃到空行或下一个块级标记
    const body = [];
    while (i < lines.length) {
      const t = lines[i].trim();
      if (!t || /^(#{1,4}\s|```|>|([-*+]|\d+[.)])\s|(-{3,}|\*{3,}|_{3,})$)/.test(t)) break;
      body.push(t);
      i++;
    }
    frag.append(para(body));
  }
  return frag;
}

/** 把 markdown 渲染进容器 (替换原内容). */
export function mdInto(node, src) {
  node.textContent = '';
  node.append(renderMarkdown(src));
  return node;
}
