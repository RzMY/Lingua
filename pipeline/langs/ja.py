"""日语分析器 —— MeCab + UniDic.

真正的活都在既有模块里: :mod:`pipeline.tokenizer` (分词/注音/词性)、
:mod:`pipeline.kana` (罗马音)、:mod:`pipeline.merge` (形态素 -> 展示单元的 R1–R5)。
这里只把结果翻译成与语言无关的 :class:`~pipeline.langs.base.Word`, 好让上层管道
对日语和 spaCy 语言用同一条代码路径。
"""

from __future__ import annotations

import importlib.util

from ..merge import DisplayWord, merge_morphemes
from ..tokenizer import Morpheme, resolve_dicdir
from .base import LangSpec, Part, Word


def dict_ready(dicdir: str | None = None) -> tuple[bool, str]:
    """``/api/health`` 用: 词典与 fugashi 是否就位 (不建 tagger)."""
    try:
        if importlib.util.find_spec("fugashi") is None:
            return False, "未安装 fugashi"
    except (ImportError, ValueError):
        return False, "未安装 fugashi"
    try:
        found = resolve_dicdir(dicdir)
    except FileNotFoundError as exc:
        return False, str(exc)
    return True, found or "MeCab 系统默认字典"


def _head(parts: list[Morpheme]) -> Morpheme:
    """与 :func:`pipeline.merge._finish` 同一套中心语规则 (接頭辞在前时取后一个)."""
    if len(parts) > 1 and parts[0].pos == "prefix":
        return parts[1]
    return parts[0]


def _to_part(m: Morpheme) -> Part:
    return Part(
        text=m.surface,
        pos=m.pos,
        read=m.furigana,
        roman=m.romaji,
        lemma=m.lemma if m.lemma and m.lemma != m.surface else "",
        pos_detail=m.pos_detail,
        conj=m.conj,
    )


def _to_word(unit: DisplayWord) -> Word:
    head = _head(unit.parts)
    word = Word(
        text=unit.surface,
        char_start=unit.char_start,
        char_end=unit.char_end,
        pos=unit.pos,
        read=unit.furigana,
        roman=unit.romaji,
        pos_detail=head.pos_detail,
        conj=head.conj,
    )
    if head.lemma and head.lemma != unit.surface:
        word.lemma = head.lemma
        word.lemma_roman = head.lemma_romaji
    if len(unit.parts) > 1:
        word.parts = [_to_part(m) for m in unit.parts]
    return word


class JapaneseAnalyzer:
    """线程不安全 (MeCab tagger 本身就不是), 调用方请自己串行化."""

    def __init__(self, spec: LangSpec, *, merge: bool = True,
                 dicdir: str | None = None) -> None:
        from ..tokenizer import JapaneseTokenizer

        self.spec = spec
        self.merge = merge
        self._tk = JapaneseTokenizer(dicdir)

    @property
    def detail(self) -> str:
        return self._tk.dicdir or "MeCab 系统默认字典"

    def analyze(self, text: str) -> list[Word]:
        if not text:
            return []
        units = merge_morphemes(self._tk.tokenize(text), self.merge)
        return [_to_word(u) for u in units]
