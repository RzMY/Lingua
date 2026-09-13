"""形态素 -> 展示单元 合并.

MeCab 的切分粒度对**语法分析**是对的, 对**阅读**却太碎:
``4|回|目``、``お|疲れ|様``、``思っ|て`` 都应该是一个视觉单元 (设计稿也是这样)。

这里做一遍保守的合并, 并保留 ``parts`` 以便「讲解」面板展示内部结构。规则:

* R1 接頭辞 + 内容词           -> ``お`` + ``疲れ``  = ``お疲れ``
* R2 名詞/数詞 + 名詞/接尾辞   -> ``4`` + ``回`` + ``目`` = ``4回目``
* R3 用言 + 助動詞链 (最多3个) -> ``思っ`` + ``て``  = ``思って``
* R4 R3 链尾 + 接続助詞 て/で  -> ``覆われ`` + ``て`` = ``覆われて``
* R5 长音符/小写假名/叠字符    -> ``り`` + ``ゃ`` + ``ー`` = ``りゃー``

标点永不参与合并; ``けど``/``から`` 之类的接続助詞也不合并 (它们是独立的语法标记)。
R5 是正字法规则而非启发式: 这些字符在日语里不能出现在词首, 只可能属于前一个词。
口语拖音的 ASR 文本 (``おかえりなさーい``) 会被 MeCab 切得很碎, 这一条能救回来。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .kana import furigana_for, kana_to_romaji, to_hiragana
from .tokenizer import Morpheme

_CONTENT = {"noun", "propn", "pron", "num", "verb", "adj", "adjn", "adv"}
_NOUNISH = {"noun", "propn", "num"}
#: 只有这些接続助詞参与合并 (构成复合动词形式), ``けど``/``から`` 等保持独立
_CONJ_PARTICLES = {"て", "で", "ちゃ", "じゃ", "ちゃっ"}
_MAX_AUX_CHAIN = 3
#: 不能出现在词首的字符: 长音符 / 小写假名 / 叠字符 —— 只可能属于前一个词
_GLUE_CHARS = frozenset("ーｰぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々ゝゞヽヾ")


@dataclass(slots=True)
class DisplayWord:
    """前端渲染的一个「单词」, 可能由多个形态素合并而来."""

    surface: str
    kana: str = ""  # 片假名读音 (合并后)
    pron: str = ""  # 发音形 (罗马音的来源)
    furigana: str = ""  # 需要展示的平假名注音
    romaji: str = ""
    pos: str = "other"
    start: float = -1.0
    end: float = -1.0
    parts: list[Morpheme] = field(default_factory=list)

    @property
    def head(self) -> Morpheme:
        return self.parts[0]

    @property
    def char_start(self) -> int:
        return self.parts[0].char_start

    @property
    def char_end(self) -> int:
        return self.parts[-1].char_end


def _is_nounish_tail(m: Morpheme) -> bool:
    """能接在名詞后面构成复合名詞的成分."""
    if m.pos in _NOUNISH:
        return True
    # 接尾辞只吃名詞性的 (``目``/``さん``/``たち``), 動詞性接尾辞 (``がる``) 不吃
    return m.pos == "suffix" and "動詞的" not in m.pos_detail and "形状詞的" not in m.pos_detail


def _is_glue(m: Morpheme) -> bool:
    """整个表层都是不能成词的字符 (``ゃ``/``ー``/``々``)."""
    return bool(m.surface) and all(ch in _GLUE_CHARS for ch in m.surface)


def _can_absorb(word: DisplayWord, nxt: Morpheme) -> bool:
    prev = word.parts[-1]
    if nxt.char_start != prev.char_end:  # 中间有空白, 不合并
        return False

    # R5 正字法: 长音符/小写假名/叠字符粘左 (它们常被切成独立形态素, 甚至标记为标点)
    if _is_glue(nxt):
        return not prev.is_punct

    if nxt.is_punct or prev.is_punct:
        return False

    # R1 接頭辞 + 内容词
    if prev.pos == "prefix":
        return nxt.pos in _CONTENT

    # R2 名詞类 + 名詞类/接尾辞
    if prev.pos in _NOUNISH and _is_nounish_tail(nxt):
        return True

    # R3 用言 (或已经带助動詞的用言) + 助動詞
    if nxt.pos == "aux":
        if len(word.parts) > _MAX_AUX_CHAIN:
            return False
        return prev.pos in {"verb", "adj", "adjn", "aux"}

    # R4 用言链 + 接続助詞 て/で
    if nxt.pos == "particle" and "接続助詞" in nxt.pos_detail and nxt.surface in _CONJ_PARTICLES:
        return len(word.parts) <= 2 and prev.pos in {"verb", "adj", "aux"}

    return False


def _finish(word: DisplayWord) -> DisplayWord:
    """由 parts 回填合并后的表层/读音/时间."""
    parts = word.parts
    word.surface = "".join(p.surface for p in parts)
    word.start = min((p.start for p in parts if p.start >= 0), default=-1.0)
    word.end = max((p.end for p in parts if p.end >= 0), default=-1.0)

    if len(parts) == 1:
        one = parts[0]
        word.kana, word.furigana, word.romaji, word.pos = one.kana, one.furigana, one.romaji, one.pos
        word.pron = one.pron
        return word

    word.kana = "".join(p.kana for p in parts)
    word.pron = "".join(p.pron for p in parts)
    # 从合并后的整串重算, 才能处理跨形态素的促音/撥音 (おもっ+て -> omotte)
    word.romaji = kana_to_romaji(word.pron) if word.pron else ""
    reading = to_hiragana(word.kana)
    word.furigana = furigana_for(word.surface, reading)

    # 词性取「中心语」: R1 的中心在后 (お疲れ -> 疲れ), 其余在前 (思って -> 思っ)
    word.pos = parts[1].pos if parts[0].pos == "prefix" else parts[0].pos
    return word


def merge_morphemes(morphemes: list[Morpheme], enabled: bool = True) -> list[DisplayWord]:
    """把形态素序列合并成展示单元."""
    words: list[DisplayWord] = []
    for m in morphemes:
        if enabled and words and _can_absorb(words[-1], m):
            words[-1].parts.append(m)
            continue
        words.append(DisplayWord(surface=m.surface, parts=[m]))
    return [_finish(w) for w in words]
