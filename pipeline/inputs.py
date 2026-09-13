"""输入解析: ASR 词级 JSON / SRT / WebVTT.

统一产出 :class:`RawSegment` 序列, 后续阶段不再关心来源格式.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------- 数据结构


@dataclass(slots=True)
class Chunk:
    """ASR 输出的一个词级片段 (可能只是半个词, 甚至单个假名)."""

    text: str
    start: float
    end: float


@dataclass(slots=True)
class RawSegment:
    """输入里的一条字幕. ``chunks`` 为空表示只有句级时间戳."""

    index: int
    text: str
    start: float
    end: float
    chunks: list[Chunk] = field(default_factory=list)

    @property
    def has_word_timing(self) -> bool:
        return bool(self.chunks)


class InputError(RuntimeError):
    pass


# ---------------------------------------------------------------- 词级 JSON

_WORD_TEXT_KEYS = ("text", "word", "value")
_WORD_START_KEYS = ("start", "start_time", "startTime", "s", "from")
_WORD_END_KEYS = ("end", "end_time", "endTime", "e", "to")


def _pick(obj: dict, keys: tuple[str, ...], default=None):
    for k in keys:
        if k in obj and obj[k] is not None:
            return obj[k]
    return default


def _as_chunks(raw_words: list) -> list[Chunk]:
    chunks: list[Chunk] = []
    for w in raw_words:
        if not isinstance(w, dict):
            continue
        text = str(_pick(w, _WORD_TEXT_KEYS, "") or "")
        start, end = _pick(w, _WORD_START_KEYS), _pick(w, _WORD_END_KEYS)
        if not text or start is None or end is None:
            continue
        chunks.append(Chunk(text, float(start), float(end)))
    return chunks


def _segments_of(payload) -> list[dict]:
    """把各家 ASR 的顶层结构收敛成 segment 字典列表."""
    if isinstance(payload, list):
        return [s for s in payload if isinstance(s, dict)]
    if not isinstance(payload, dict):
        raise InputError("JSON 顶层既不是对象也不是数组")
    for key in ("segments", "sentences", "chunks", "result", "results"):
        value = payload.get(key)
        if isinstance(value, list) and value and isinstance(value[0], dict):
            return value
    # 只有平铺的 words: 合成一个大 segment, 后面靠标点/停顿再切句
    words = payload.get("words")
    if isinstance(words, list) and words:
        chunks = _as_chunks(words)
        if chunks:
            return [
                {
                    "text": "".join(c.text for c in chunks),
                    "start": chunks[0].start,
                    "end": chunks[-1].end,
                    "words": words,
                }
            ]
    raise InputError("JSON 里找不到 segments / words 字段")


def load_word_json(path: str | Path) -> tuple[list[RawSegment], str | None]:
    """读取 Whisper / faster-whisper / WhisperX 风格的词级时间戳 JSON.

    返回 ``(segments, language)``.
    """
    return parse_word_json(Path(path).read_text(encoding="utf-8-sig"), str(path))


def parse_word_json(text: str, label: str = "输入") -> tuple[list[RawSegment], str | None]:
    """同 :func:`load_word_json`, 但吃内存里的字符串 (分析 API 不落盘)."""
    try:
        payload = json.loads(text)
    except ValueError as exc:
        raise InputError(f"JSON 解析失败: {exc}") from exc
    language = payload.get("language") if isinstance(payload, dict) else None

    segments: list[RawSegment] = []
    for raw in _segments_of(payload):
        chunks = _as_chunks(_pick(raw, ("words", "word_timestamps", "tokens_ts"), []) or [])
        text_of = str(_pick(raw, ("text", "sentence", "transcript"), "") or "").strip()
        if not text_of and chunks:
            text_of = "".join(c.text for c in chunks)
        if not text_of:
            continue
        start = _pick(raw, _WORD_START_KEYS)
        end = _pick(raw, _WORD_END_KEYS)
        if start is None or end is None:
            if not chunks:
                continue
            start, end = chunks[0].start, chunks[-1].end
        segments.append(RawSegment(len(segments), text_of, float(start), float(end), chunks))

    if not segments:
        raise InputError(f"{label} 里没有解析出任何字幕段")
    return segments, language


# ---------------------------------------------------------------- SRT / VTT

_TS = r"(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})"
_CUE_RE = re.compile(rf"{_TS}\s*-->\s*{_TS}")
#: 卡拉OK 式内联时间标记: ``<00:00:12.345>`` 或 ``<12.345>``
_INLINE_TS_RE = re.compile(r"<(?:(\d{1,3}):)?(?:(\d{1,2}):)?(\d{1,2})[.,](\d{1,3})>")
_TAG_RE = re.compile(r"</?[a-zA-Z][^>]*>")
_CJK_RE = re.compile(r"[　-ヿ㐀-䶿一-鿿＀-￯]")


def _ts_to_seconds(h: str, m: str, s: str, ms: str) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000


def _inline_to_seconds(match: re.Match) -> float:
    a, b, c, ms = match.groups()
    parts = [p for p in (a, b, c) if p is not None]
    total = 0.0
    for p in parts:
        total = total * 60 + int(p)
    return total + int(ms.ljust(3, "0")) / 1000


def _join_lines(lines: list[str]) -> str:
    """日语字幕换行处不该插空格, 西文之间要插."""
    out = ""
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if out and not (_CJK_RE.search(out[-1]) or _CJK_RE.search(line[0])):
            out += " "
        out += line
    return out


def _parse_cue_body(body: str, start: float, end: float) -> tuple[str, list[Chunk]]:
    """拆出纯文本与 (可选的) 内联词级时间戳."""
    body = _join_lines(body.splitlines())
    if not _INLINE_TS_RE.search(body):
        return _TAG_RE.sub("", body).strip(), []

    chunks: list[Chunk] = []
    cursor = start
    pos = 0
    pieces: list[str] = []
    for m in _INLINE_TS_RE.finditer(body):
        piece = _TAG_RE.sub("", body[pos : m.start()])
        if piece.strip():
            chunks.append(Chunk(piece, cursor, _inline_to_seconds(m)))
            pieces.append(piece)
        cursor = _inline_to_seconds(m)
        pos = m.end()
    tail = _TAG_RE.sub("", body[pos:])
    if tail.strip():
        chunks.append(Chunk(tail, cursor, end))
        pieces.append(tail)
    return "".join(pieces).strip(), chunks


def load_subtitle(path: str | Path) -> list[RawSegment]:
    """解析 SRT / WebVTT. 若含卡拉OK 内联时间戳则同时产出词级 chunk."""
    return parse_subtitle(Path(path).read_text(encoding="utf-8-sig"), str(path))


def parse_subtitle(raw: str, label: str = "输入") -> list[RawSegment]:
    """同 :func:`load_subtitle`, 但吃内存里的字符串."""
    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    segments: list[RawSegment] = []
    for block in re.split(r"\n{2,}", text):
        block = block.strip("\n")
        if not block or block.upper().startswith("WEBVTT"):
            continue
        lines = block.split("\n")
        cue_idx = next((i for i, ln in enumerate(lines) if _CUE_RE.search(ln)), None)
        if cue_idx is None:
            continue
        m = _CUE_RE.search(lines[cue_idx])
        start = _ts_to_seconds(*m.group(1, 2, 3, 4))
        end = _ts_to_seconds(*m.group(5, 6, 7, 8))
        body = "\n".join(lines[cue_idx + 1 :])
        content, chunks = _parse_cue_body(body, start, end)
        if not content:
            continue
        segments.append(RawSegment(len(segments), content, start, end, chunks))

    if not segments:
        raise InputError(f"{label} 里没有解析出任何字幕段")
    return segments


SUFFIXES = (".json", ".srt", ".vtt", ".webvtt")


def load_any(path: str | Path) -> tuple[list[RawSegment], str | None]:
    """按扩展名自动选择解析器."""
    suffix = Path(path).suffix.lower()
    if suffix == ".json":
        return load_word_json(path)
    if suffix in (".srt", ".vtt", ".webvtt"):
        return load_subtitle(path), None
    raise InputError(f"不支持的字幕格式: {suffix}")


def parse_any(data: bytes | str, name: str = "") -> tuple[list[RawSegment], str | None]:
    """内存版 :func:`load_any` —— 分析 API 用它, 全程不落盘.

    扩展名认不出来时按内容猜: 以 ``{`` / ``[`` 开头当 JSON, 否则当字幕。
    """
    text = data.decode("utf-8-sig", "replace") if isinstance(data, bytes) else data
    if not text.strip():
        raise InputError("字幕内容为空")
    suffix = Path(name or "").suffix.lower()
    if suffix not in SUFFIXES:
        suffix = ".json" if text.lstrip()[:1] in "[{" else ".srt"
    label = name or "输入"
    if suffix == ".json":
        return parse_word_json(text, label)
    return parse_subtitle(text, label), None


