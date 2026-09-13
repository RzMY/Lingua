"""spaCy 驱动的分析器 —— 英语 / 西班牙语 / 法语 / 德语 / 韩语.

一门语言接进来只要三件事: UPOS 折叠成紧凑词性标签 (:mod:`pipeline.pos`)、
``token.idx`` 给出字符区间 (时间对齐全靠它)、以及决定两个文字层放什么:

* 拉丁语言 —— 上层放 **IPA 音标** (:mod:`.phon`), 下层放**原形**
  (``went`` → ``go``), 这是学习者真正需要的两样东西;
* 韩语 —— 上层放**标准发音**的谚文 (``읽어요`` → ``일거요``; 谚文本身是音素文字,
  写读音比写音标有用), 下层放**罗马字** (见 :mod:`.hangul`),
  并用 ``lemma_`` 里 ``+`` 分隔的语素还原出 ``parts``。

注音后端是**可选依赖**, 缺了就没有上层, 分析照常完成 (见 :mod:`.phon`)。
模型按名字缓存: 加载一个 ``*_core_*_sm`` 要一秒上下, 逐句新建就没法用了。
"""

from __future__ import annotations

import importlib.util

from ..pos import classify_upos, classify_xpos
from . import phon
from .base import LangSpec, Part, Word, head_of
from .hangul import romanize

#: 写进 ``conj`` 的形态特征 (只挑对学习者有意义的几个, 免得糊一屏)
_MORPH_KEYS = ("VerbForm", "Tense", "Mood", "Person", "Number", "Case", "Degree",
               "Gender", "Voice", "Definite")
_MORPH_MAX = 4

_APOS = "'’ʼ"
_HYPHEN = "-‐‑‒–"
_MAX_PARTS = 4

_MODELS: dict[str, object] = {}


def _has_module(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def model_ready(model: str) -> tuple[bool, str]:
    """只查包在不在, 不真加载 —— ``/api/health`` 必须秒回."""
    if not _has_module("spacy"):
        return False, "未安装 spacy"
    if model in _MODELS:
        return True, ""
    if not _has_module(model):
        return False, f"缺少模型 {model} (python -m spacy download {model})"
    return True, ""


def load_model(model: str):
    """加载并缓存一个 spaCy 模型; 顺手摘掉用不上的重组件."""
    nlp = _MODELS.get(model)
    if nlp is not None:
        return nlp
    try:
        import spacy
    except ImportError as exc:  # pragma: no cover - 环境问题
        raise RuntimeError("缺少 spaCy, 请先 `pip install spacy`") from exc
    try:
        nlp = spacy.load(model)
    except OSError as exc:
        raise RuntimeError(
            f"缺少 spaCy 模型 {model}, 请先 `python -m spacy download {model}`"
        ) from exc
    for pipe in ("ner", "entity_ruler", "entity_linker", "textcat"):
        if pipe in nlp.pipe_names:
            nlp.remove_pipe(pipe)
    _MODELS[model] = nlp
    return nlp


def _morph_brief(morph) -> str:
    bits: list[str] = []
    for key in _MORPH_KEYS:
        values = morph.get(key)
        if not values:
            continue
        bits.append(f"{key}={values[0]}")
        if len(bits) >= _MORPH_MAX:
            break
    return " ".join(bits)


def _ko_parts(lemma: str, xpos: str, read) -> list[Part]:
    """韩语 ``lemma_`` 形如 ``여우+가``, ``tag_`` 形如 ``NNG+JKS`` —— 逐段配对."""
    morphs = [m for m in lemma.split("+") if m]
    if len(morphs) < 2:
        return []
    tags = [x for x in (xpos or "").split("+") if x]
    out: list[Part] = []
    for k, morph in enumerate(morphs):
        piece = tags[k] if k < len(tags) else ""
        out.append(Part(
            text=morph,
            pos=classify_xpos(piece) if piece else "other",
            read=read(morph),
            roman=romanize(morph),
            pos_detail=piece,
        ))
    return out


class SpacyAnalyzer:
    """一门 spaCy 语言的分析器. 线程不安全 —— 调用方请自己串行化."""

    def __init__(self, spec: LangSpec, *, merge: bool = True) -> None:
        self.spec = spec
        self.merge = merge
        self.hangul = spec.script == "hangul"
        self._nlp = load_model(spec.model)
        #  注音后端拿不到就退化成「没有上层」: 一个辅助层不该让整篇分析失败
        self._reader = phon.provider(spec.code) if "read" in spec.layer_map else None
        self._read = self._reader or (lambda _text: "")

    @property
    def detail(self) -> str:
        if self._reader is None:
            return self.spec.model
        return f"{self.spec.model} + {self._reader.name}"

    def analyze(self, text: str) -> list[Word]:
        if not text.strip():
            return []
        units = [self._word(t) for t in self._nlp(text) if t.text.strip()]
        return _merge_units(units, enabled=self.merge, hangul=self.hangul,
                            read=self._read)

    def _word(self, token) -> Word:
        surface = token.text
        tag = classify_upos(token.pos_, token.tag_)
        word = Word(
            text=surface,
            char_start=token.idx,
            char_end=token.idx + len(surface),
            pos=tag,
            pos_detail=token.tag_ or token.pos_ or "",
            conj=_morph_brief(token.morph),
        )
        lemma = (token.lemma_ or "").strip()
        if tag == "punct":
            return word
        word.read = self._read(surface)
        if self.hangul:
            word.roman = romanize(surface)
            base = lemma.replace("+", "")
            if base and base != surface:
                word.lemma = lemma
                word.lemma_roman = romanize(base)
            word.parts = _ko_parts(lemma, token.tag_ or "", self._read)
            return word
        if lemma and lemma.lower() != surface.lower():
            word.lemma = lemma
            word.roman = lemma          # 拉丁语言的下层文字 = 原形
        return word


# ------------------------------------------------------------ 缩合词 / 复合词合并

#  spaCy 会把 ``don't`` 切成 ``do``+``n't``, ``l'homme`` 切成 ``l'``+``homme``,
#  ``well-known`` 切成三段。分析上没错, 读起来太碎 —— 只要中间**没有空白**, 且接缝
#  处是撇号或连字符, 就并成一个展示单元, 并保留 parts 供「讲解」面板展开。
#  这是正字法规则而不是启发式: 这两类接缝在书写上本来就属于同一个词。


def _joinable(prev: Word, nxt: Word) -> bool:
    if prev.char_end != nxt.char_start:      # 中间有空白 -> 是两个词
        return False
    if not prev.text or not nxt.text:
        return False
    if nxt.text[0] in _APOS or prev.text[-1] in _APOS:
        return True
    if nxt.text[0] in _HYPHEN or prev.text[-1] in _HYPHEN:
        return True
    #  撇号不一定在接缝上: 英语的 ``didn't`` 被切成 ``did`` + ``n't``。这类附着成分
    #  都很短, 限个长度就不会误吞 ``O'Brien`` 这种本来就完整的词。
    return len(nxt.text) <= 4 and any(ch in _APOS for ch in nxt.text)


def _part_read(part: Word) -> str:
    """成分自己的注音 —— 带撇号的附着成分要清掉.

    ``n't`` / ``l'`` 单独拿出来不成词, g2p 只能去逐字母拼读 (``n't`` → ``ˈɛntˈaɪ``),
    写进 ``parts`` 就是纯噪音。``well-known`` 的 ``well`` / ``known`` 拼写完整,
    各自的音标是对的, 留着 —— 「讲解」面板正好能逐段对照。
    """
    return "" if any(ch in _APOS for ch in part.text) else part.read


def _finish(group: list[Word], hangul: bool, read) -> Word:
    if len(group) == 1:
        return group[0]
    head = head_of(group)                    # type: ignore[arg-type]
    text = "".join(p.text for p in group)
    word = Word(
        text=text,
        char_start=group[0].char_start,
        char_end=group[-1].char_end,
        pos=head.pos,
        lemma=head.lemma,
        lemma_roman=head.lemma_roman,
        pos_detail=head.pos_detail,
        conj=head.conj,
    )
    #  两个上层/下层都按整串重算, 不拼接各成分的:
    #  * 注音 —— 音标拼起来不成话 (``isn't`` 不是 ``ɪz`` + ``nt``), 而且韩语的音变
    #    本来就要跨语素才算得对;
    #  * 罗马字 —— 同理; 拉丁语言的下层是原形, 拼接没有意义, 所以只取中心语的。
    word.read = read(text)
    word.roman = romanize(text) if hangul else head.roman
    word.parts = [Part(text=p.text, pos=p.pos, read=_part_read(p), roman=p.roman,
                       lemma=p.lemma, pos_detail=p.pos_detail, conj=p.conj)
                  for p in group]
    return word


def _merge_units(words: list[Word], *, enabled: bool, hangul: bool, read) -> list[Word]:
    if not words:
        return []
    groups: list[list[Word]] = []
    for word in words:
        if (enabled and groups and len(groups[-1]) < _MAX_PARTS
                and _joinable(groups[-1][-1], word)):
            groups[-1].append(word)
            continue
        groups.append([word])
    return [_finish(g, hangul, read) for g in groups]
