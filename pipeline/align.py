"""时间戳对齐与切句 —— 与语言无关的那一半管道.

ASR 给的是「声学片段」(``こん`` / ``ば`` / ``ん`` / ``は``, 或者 ``Hel`` / ``lo``),
分析器给的是「词」(``こんばんは`` / ``Hello``), 两者边界不一致。由于 ASR 片段拼起来
正好等于原文, 我们先把时间摊到**每个字符**上, 再按词的字符区间取时间。

切句的规则由语言决定 (见 :class:`~pipeline.langs.base.LangSpec`):

* 日语这类没有词间空白的语言 —— 句末标点后直接断;
* 拉丁 / 韩语 —— 句末标点后必须跟空白或行尾才断, 并且要躲开缩写与小数
  (``Mr. Smith`` / ``3.14`` 不是两句)。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache

from .inputs import Chunk
from .langs.base import DEFAULT_SENT_END, DEFAULT_TRAILING

MIN_WORD_DUR = 0.02  # 秒: 避免零长度区间让二分查找无处落脚

#: 拉丁语言里以句点结尾、却不是句末的常见缩写 (小写比较, 已去掉内部的点)
_ABBREV = frozenset("""
mr mrs ms dr prof sr jr st vs etc eg ie approx dept
e.g i.e a.m p.m u.s u.k ph.d
sra srta ud uds dpto
mme mlle av bd
bzw usw evtl ca bspw dh ggf hr fr ggfs zzgl inkl
""".split())

#: 只有后面跟数字时才算缩写的那批 (编号/页码/章节).
#:
#: ``No.`` 是「número」但 ``no.`` 也可能就是一句完整的英语否定; ``S.`` 是德语的
#: 「Seite」但也可能是句末的单字母。要求后面跟数字能同时说对两边, 比按语言分表稳。
_NUM_ABBREV = frozenset("""
no nos nr num núm p pp pag pág fig figs vol ch abb s seite
""".split())


@dataclass(slots=True)
class CharTimeline:
    """逐字符时间轴. ``cs[i]`` / ``ce[i]`` 分别是第 i 个字符的起止时间."""

    cs: list[float]
    ce: list[float]
    exact: bool = True  # False 表示掺了均匀摊派出来的估算值

    def __len__(self) -> int:
        return len(self.cs)

    def span(self, a: int, b: int) -> tuple[float, float]:
        """字符区间 ``[a, b)`` 对应的时间区间."""
        if not self.cs:
            return (0.0, 0.0)
        a = max(0, min(a, len(self.cs) - 1))
        b = max(a + 1, min(b, len(self.cs)))
        return (min(self.cs[a:b]), max(self.ce[a:b]))

    def slice(self, a: int, b: int) -> CharTimeline:
        return CharTimeline(self.cs[a:b], self.ce[a:b], self.exact)


# ------------------------------------------------------------ 构建逐字时间轴


def _uniform(text: str, start: float, end: float) -> CharTimeline:
    n = max(1, len(text))
    step = (end - start) / n
    cs = [start + i * step for i in range(len(text))]
    ce = [start + (i + 1) * step for i in range(len(text))]
    return CharTimeline(cs, ce, exact=False)


def _normalize_chunks(chunks: list[Chunk]) -> list[Chunk]:
    """裁掉重叠/倒序, 保证时间单调 —— 前端的二分查找依赖这一点."""
    out: list[Chunk] = []
    prev_end = float("-inf")
    for c in chunks:
        start = max(c.start, prev_end)
        end = max(c.end, start + MIN_WORD_DUR)
        out.append(Chunk(c.text, start, end))
        prev_end = end
    return out


def build_char_timeline(
    text: str, chunks: list[Chunk], start: float, end: float
) -> CharTimeline:
    """把 ASR 片段的时间摊到每个字符上."""
    if not text:
        return CharTimeline([], [])
    if not chunks:
        return _uniform(text, start, end)

    chunks = _normalize_chunks(chunks)
    cs: list[float | None] = [None] * len(text)
    ce: list[float | None] = [None] * len(text)

    cursor = 0
    matched = 0
    for chunk in chunks:
        piece = chunk.text
        if not piece:
            continue
        pos = text.find(piece, cursor)
        if pos < 0:  # ASR 文本与字幕文本不完全一致: 退一步只找去掉空白的部分
            stripped = piece.strip()
            pos = text.find(stripped, cursor) if stripped else -1
            if pos < 0:
                continue
            piece = stripped
        n = len(piece)
        step = (chunk.end - chunk.start) / n
        for k in range(n):
            cs[pos + k] = chunk.start + k * step
            ce[pos + k] = chunk.start + (k + 1) * step
        cursor = pos + n
        matched += n

    if matched == 0:
        return _uniform(text, start, end)

    #  「精确」= 除了空白之外每个字符都被 ASR 片段覆盖到了。空白不算漏 —— 拉丁语言的
    #  词级时间戳天然不覆盖词间空格, 但那不影响任何一个词的时间。
    exact = all(cs[i] is not None or text[i].isspace() for i in range(len(text)))
    _fill_gaps(cs, ce, start, end)
    return CharTimeline(cs, ce, exact)  # type: ignore[arg-type]


def _fill_gaps(
    cs: list[float | None], ce: list[float | None], start: float, end: float
) -> None:
    """未被任何 ASR 片段覆盖的字符 (标点、空格、漏词) 按两侧邻居线性插值."""
    n = len(cs)
    prev = start
    i = 0
    while i < n:
        if cs[i] is not None:
            prev = ce[i]  # type: ignore[assignment]
            i += 1
            continue
        j = i
        while j < n and cs[j] is None:
            j += 1
        nxt = cs[j] if j < n else end
        span = max(0.0, (nxt or prev) - prev)  # type: ignore[operator]
        step = span / (j - i)
        for k in range(i, j):
            cs[k] = prev + (k - i) * step
            ce[k] = prev + (k - i + 1) * step
        prev = ce[j - 1]  # type: ignore[assignment]
        i = j


# ---------------------------------------------------------------- 句子切分


@lru_cache(maxsize=32)
def _splitter(sent_end: str, trailing: str, require_space: bool) -> re.Pattern[str]:
    body = rf"[{re.escape(sent_end)}]+[{re.escape(trailing)}]*"
    return re.compile(body + r"(?=\s|$)" if require_space else body)


def _digit_follows(text: str, at: int) -> bool:
    """``at`` 处句点之后 (跳过空白与括号) 是不是数字?"""
    j = at + 1
    while j < len(text) and (text[j].isspace() or text[j] in "([«\"'"):
        j += 1
    return j < len(text) and text[j].isdigit()


def _is_abbrev(text: str, at: int) -> bool:
    """``at`` 处的句点是缩写/小数的一部分而不是句末标点?"""
    if at == 0 or text[at] != ".":
        return False
    j = at
    while j > 0 and (text[j - 1].isalnum() or text[j - 1] in ".'’-"):
        j -= 1
    token = text[j:at]
    if not token:
        return False
    if token[-1].isdigit():                       # 3.14 / 第 1.2 节
        return True
    if len(token) == 1 and token.isupper():       # 首字母缩写 J. R. R.
        return True
    key = token.lower().strip(".")
    if key in _NUM_ABBREV:                        # No. 5 / p. 12 是编号, no. 不是
        return _digit_follows(text, at)
    return key in _ABBREV


def _punct_ranges(text: str, sent_end: str, trailing: str,
                  require_space: bool) -> list[tuple[int, int]]:
    cuts = [0]
    for m in _splitter(sent_end, trailing, require_space).finditer(text):
        at = m.end()
        if at <= 0 or at >= len(text):
            continue
        if require_space and _is_abbrev(text, m.start()):
            continue
        cuts.append(at)
    cuts.append(len(text))
    return [(cuts[i], cuts[i + 1]) for i in range(len(cuts) - 1) if cuts[i + 1] > cuts[i]]


def _split_by_gap(
    text: str,
    tl: CharTimeline,
    a: int,
    b: int,
    max_seconds: float,
    min_gap: float,
    depth: int = 0,
) -> list[tuple[int, int]]:
    """无标点的长句 (ASMR/播客常见) 按停顿再切, 免得一句横跨十几秒."""
    if depth > 6 or b - a < 8 or not tl.exact:
        return [(a, b)]
    if tl.ce[b - 1] - tl.cs[a] <= max_seconds:
        return [(a, b)]
    best, best_gap = -1, min_gap
    margin = max(3, (b - a) // 6)
    for i in range(a + margin, b - margin):
        gap = tl.cs[i] - tl.ce[i - 1]
        if gap >= best_gap:
            best, best_gap = i, gap
    if best < 0:
        return [(a, b)]
    left = _split_by_gap(text, tl, a, best, max_seconds, min_gap, depth + 1)
    right = _split_by_gap(text, tl, best, b, max_seconds, min_gap, depth + 1)
    return left + right


def split_ranges(
    text: str,
    tl: CharTimeline,
    *,
    by_punct: bool = True,
    max_seconds: float = 0.0,
    min_gap: float = 0.32,
    sent_end: str = DEFAULT_SENT_END,
    trailing: str = DEFAULT_TRAILING,
    require_space: bool = False,
) -> list[tuple[int, int]]:
    """把一条字幕切成若干句, 返回字符区间列表."""
    ranges = (_punct_ranges(text, sent_end, trailing, require_space)
              if by_punct else [(0, len(text))])
    if max_seconds > 0 and len(tl) == len(text):
        expanded: list[tuple[int, int]] = []
        for a, b in ranges:
            expanded += _split_by_gap(text, tl, a, b, max_seconds, min_gap)
        ranges = expanded
    return _merge_tiny(text, ranges, sent_end, trailing)


def _merge_tiny(text: str, ranges: list[tuple[int, int]], sent_end: str,
                trailing: str) -> list[tuple[int, int]]:
    """把「只剩标点」或过短的碎片并回前一句."""
    drop = sent_end + trailing + " 　\t"
    out: list[tuple[int, int]] = []
    for a, b in ranges:
        piece = text[a:b]
        too_small = len(piece.strip()) < 2 or not piece.strip(drop)
        if out and too_small:
            out[-1] = (out[-1][0], b)
        else:
            out.append((a, b))
    return out or [(0, len(text))]


# ------------------------------------------------------------ 词的时间回填


def assign_word_times(words, tl: CharTimeline) -> None:
    """按词的字符区间从逐字时间轴取时间, 并保证单调不重叠.

    只要对象有 ``char_start`` / ``char_end`` / ``start`` / ``end`` 就能用 ——
    形态素 (:class:`~pipeline.tokenizer.Morpheme`) 与展示单元
    (:class:`~pipeline.langs.base.Word`) 都满足。
    """
    if not words or not len(tl):
        return
    prev_end = float("-inf")
    for w in words:
        start, end = tl.span(w.char_start, w.char_end)
        start = max(start, prev_end)
        end = max(end, start + MIN_WORD_DUR)
        w.start, w.end = start, end
        prev_end = end


def enforce_monotonic(items: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """全局单调化: 前端用二分查找定位当前词, 起点必须非递减且区间不重叠."""
    out: list[tuple[float, float]] = []
    prev_end = float("-inf")
    for start, end in items:
        s = max(start, prev_end)
        e = max(end, s + MIN_WORD_DUR)
        out.append((s, e))
        prev_end = e
    return out
