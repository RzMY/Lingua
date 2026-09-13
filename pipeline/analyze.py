"""编排: 字幕 -> 切句 -> 逐语言分析 -> 时间对齐 -> Track JSON.

**纯函数**: 不读盘、不写盘、不联网、不缓存任何用户数据 —— 分析 API 直接把返回值当
响应体发出去 (见 :mod:`pipeline.api`)。翻译不在这里, 全部由浏览器按需调用。

产物就是前后端之间唯一的契约。``schemaVersion 2`` 起 ``track.json`` 是**自描述**的:
``lang`` 块里写清这门语言有哪几个文字层、各叫什么、词间有没有空白, 所以前端不认识
任何具体语言也能正确渲染, 加语言不用改渲染代码。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from . import GENERATOR, SCHEMA_VERSION, inputs, langs
from .align import (
    assign_word_times,
    build_char_timeline,
    enforce_monotonic,
    split_ranges,
)
from .langs.base import LangSpec, Part, Word
from .pos import legend_for

#: 一次分析的句子上限 —— 防止一份畸形字幕把服务吃满
MAX_SENTENCES = 60000


@dataclass(slots=True)
class AnalyzeOptions:
    language: str = ""              # 空 = 用字幕里自带的 language 字段
    track_id: str = "track"
    title: str = ""
    split_sentences: bool = True
    max_sentence_seconds: float = 11.0
    estimate_word_timing: bool = False
    merge_words: bool = True
    duration: float | None = None   # 前端读 <audio> 元数据后带上来
    audio_src: str = ""
    dicdir: str | None = None


@dataclass(slots=True)
class Sentence:
    index: int
    text: str
    start: float
    end: float
    words: list[Word]
    word_timing: bool


def _noop(*_args, **_kwargs) -> None:
    pass


# ------------------------------------------------------------------ 句子构建


def _sentences_from_segment(seg: inputs.RawSegment, analyzer, spec: LangSpec,
                            opts: AnalyzeOptions, next_index: int) -> list[Sentence]:
    timeline = build_char_timeline(seg.text, seg.chunks, seg.start, seg.end)
    ranges = split_ranges(
        seg.text,
        timeline,
        by_punct=opts.split_sentences,
        max_seconds=opts.max_sentence_seconds if opts.split_sentences else 0.0,
        sent_end=spec.sent_end,
        trailing=spec.trailing,
        require_space=spec.space_delimited,
    )
    word_timing = seg.has_word_timing or opts.estimate_word_timing

    out: list[Sentence] = []
    for a, b in ranges:
        raw = seg.text[a:b]
        text = raw.strip()
        if not text:
            continue
        # strip() 可能削掉前导空白, 把字符区间对齐回真实文本位置
        offset = a + raw.index(text) if text in raw else a
        sub = timeline.slice(offset, offset + len(text))
        words = analyzer.analyze(text)
        if word_timing:
            assign_word_times(words, sub)
        start, end = sub.span(0, len(text))
        out.append(Sentence(
            index=next_index + len(out),
            text=text,
            start=start,
            end=end,
            words=words,
            word_timing=word_timing,
        ))
    return out


def _sanitize(sentences: list[Sentence]) -> None:
    """全局单调化: 句子之间、句内单词之间都不允许时间倒退或重叠."""
    spans = enforce_monotonic([(s.start, s.end) for s in sentences])
    for sentence, (start, end) in zip(sentences, spans):
        sentence.start, sentence.end = start, end
        if not sentence.word_timing or not sentence.words:
            continue
        inner = enforce_monotonic([(w.start, w.end) for w in sentence.words])
        for word, (ws, we) in zip(sentence.words, inner):
            word.start = min(max(ws, start), end)
            word.end = min(max(we, word.start), end)
        # 让单词覆盖范围与句子边界严格一致, 前端才能只靠一个扁平数组做二分查找
        sentence.words[0].start = start
        sentence.words[-1].end = end


# ------------------------------------------------------------------ 序列化


def _r(value: float) -> float:
    return round(value, 3)


def _part_json(p: Part) -> dict:
    out: dict = {"text": p.text, "pos": p.pos}
    if p.read:
        out["read"] = p.read
    if p.roman:
        out["roman"] = p.roman
    if p.lemma:
        out["lemma"] = p.lemma
    if p.pos_detail:
        out["posDetail"] = p.pos_detail
    if p.conj:
        out["conj"] = p.conj
    return out


def _word_json(w: Word, word_timing: bool) -> dict:
    out: dict = {"text": w.text, "pos": w.pos}
    if word_timing and w.start >= 0:
        out["start"] = _r(w.start)
        out["end"] = _r(w.end)
    if w.read:
        out["read"] = w.read
    if w.roman:
        out["roman"] = w.roman
    if w.lemma:
        out["lemma"] = w.lemma
        if w.lemma_roman:
            out["lemmaRoman"] = w.lemma_roman
    if w.pos_detail:
        out["posDetail"] = w.pos_detail
    if w.conj:
        out["conj"] = w.conj
    if len(w.parts) > 1:
        out["parts"] = [_part_json(p) for p in w.parts]
    return out


def _track_json(sentences: list[Sentence], spec: LangSpec, opts: AnalyzeOptions,
                duration: float | None) -> dict:
    total_words = sum(len(s.words) for s in sentences)
    tags = {w.pos for s in sentences for w in s.words}
    return {
        "schemaVersion": SCHEMA_VERSION,
        "id": opts.track_id or "track",
        "title": opts.title or opts.track_id or "未命名",
        "generator": GENERATOR,
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "lang": spec.json(),
        "hasWordTiming": any(s.word_timing for s in sentences),
        "audio": {"src": opts.audio_src, "duration": _r(duration) if duration else None},
        "posLegend": legend_for(tags),
        "stats": {"sentences": len(sentences), "words": total_words},
        "sentences": [
            {
                "i": s.index,
                "start": _r(s.start),
                "end": _r(s.end),
                "text": s.text,
                "wordTiming": s.word_timing,
                "words": [_word_json(w, s.word_timing) for w in s.words],
            }
            for s in sentences
        ],
    }


# ------------------------------------------------------------------ 主流程


def analyze(data: bytes | str, name: str = "", opts: AnalyzeOptions | None = None,
            log=_noop) -> dict:
    """字幕字节流 -> Track JSON (dict).

    ``opts.language`` 为空时用字幕自带的 ``language`` 字段; 两者都没有就报错, 因为
    「猜语言」猜错的代价 (整篇注音/词性全错) 远大于让调用方明说一次。
    """
    opts = opts or AnalyzeOptions()

    log(f"[1/4] 解析字幕 {name or '(内存)'}")
    segments, detected = inputs.parse_any(data, name)
    word_level = sum(1 for s in segments if s.has_word_timing)
    log(f"  {len(segments)} 段字幕, 其中 {word_level} 段带词级时间戳")

    spec = langs.need(opts.language or detected or langs.DEFAULT_LANG)
    analyzer = langs.analyzer(spec, merge=opts.merge_words, dicdir=opts.dicdir)
    log(f"[2/4] {spec.name} 分析 ({spec.engine}: {analyzer.detail})")

    sentences: list[Sentence] = []
    for seg in segments:
        sentences += _sentences_from_segment(seg, analyzer, spec, opts, len(sentences))
        if len(sentences) > MAX_SENTENCES:
            raise ValueError(f"句子数超过 {MAX_SENTENCES}, 请先把字幕拆小")
    log("[3/4] 时间对齐与切句")
    _sanitize(sentences)
    total_words = sum(len(s.words) for s in sentences)
    log(f"  {len(sentences)} 句 / {total_words} 词")

    duration = opts.duration
    if not duration and sentences:
        duration = sentences[-1].end
    payload = _track_json(sentences, spec, opts, duration)
    log(f"[4/4] 完成: 逐词高亮 {'开' if payload['hasWordTiming'] else '关'}"
        + (f" / 时长 {duration:.2f}s" if duration else ""))
    if not word_level and not opts.estimate_word_timing:
        log("  ! 字幕没有词级时间戳, 只做整句高亮 (可开「估算词级时间戳」)")
    return payload
