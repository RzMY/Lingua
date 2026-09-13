"""语言插件的公共契约.

管道被切成两半:

* **与语言无关** —— 输入解析 (:mod:`pipeline.inputs`)、逐字时间轴与切句
  (:mod:`pipeline.align`)、序列化 (:mod:`pipeline.analyze`);
* **与语言有关** —— 一个 ``Analyzer``: 吃一段纯文本, 吐一串 :class:`Word`。

要加一门新语言, 只需在 :mod:`pipeline.langs.registry` 里登记一条 :class:`LangSpec`,
再提供 (或复用) 一个 Analyzer。前端不认识任何具体语言: 它从 ``track.json`` 自描述的
``lang`` 块里读出「这门语言有哪几个显示层、各叫什么」, 所以新增语言不用改渲染代码。
"""

from __future__ import annotations

from dataclasses import dataclass, field

#: 单词卡片上的两个可选文字层 —— 上层 (注音) 与下层 (转写 / 原形)
LAYER_KEYS = ("read", "roman")
#: 每门语言都有的功能开关 (翻译 / 词性上色 / 点词释义)
BASE_FEATURES = ("tr", "pos", "card")

DEFAULT_SENT_END = "。．.！!？?…‥"
DEFAULT_TRAILING = "」』）)】〕》”’\"'、,"


@dataclass(slots=True)
class Part:
    """展示单元内部的一个语素.

    只给「讲解」面板看内部构造, 不参与时间轴, 所以不带 char 区间也不带时间。
    """

    text: str
    pos: str = "other"
    read: str = ""
    roman: str = ""
    lemma: str = ""
    pos_detail: str = ""
    conj: str = ""


@dataclass(slots=True)
class Word:
    """前端渲染的一个展示单元 —— 与语言无关的统一产物.

    ``char_start`` / ``char_end`` 是它在**所属句子文本**里的字符区间, 时间戳完全靠
    它从逐字时间轴上取 (见 :func:`pipeline.align.assign_word_times`)。
    """

    text: str
    char_start: int = 0
    char_end: int = 0
    pos: str = "other"
    read: str = ""          # 注音层: 日语平假名; 多数语言为空
    roman: str = ""          # 转写层: 日语罗马音 / 韩语 RR / 拉丁语言的原形
    lemma: str = ""
    lemma_roman: str = ""
    pos_detail: str = ""
    conj: str = ""
    start: float = -1.0
    end: float = -1.0
    parts: list[Part] = field(default_factory=list)

    @property
    def is_punct(self) -> bool:
        return self.pos == "punct"


@dataclass(frozen=True)
class LangSpec:
    """一门源语言的全部元数据; 前端的语言设置页直接照它生成开关."""

    code: str
    name: str                  # 中文名 (设置页显示)
    name_en: str
    native: str                # 自称
    script: str                # kanji-kana | latin | hangul
    engine: str                # mecab | spacy
    model: str = ""            # spaCy 模型名 (engine=spacy 时必填)
    #: 该语言启用的文字层, 顺序即 (read, roman); 值是给用户看的标签
    layers: tuple[tuple[str, str], ...] = ()
    aliases: tuple[str, ...] = ()
    sent_end: str = DEFAULT_SENT_END
    trailing: str = DEFAULT_TRAILING
    #: 词与词之间有空白 (拉丁 / 韩语) —— 决定切句是否要求句末标点后跟空白
    space_delimited: bool = False
    note: str = ""

    @property
    def layer_map(self) -> dict[str, str]:
        return dict(self.layers)

    @property
    def features(self) -> tuple[str, ...]:
        """这门语言支持的开关键; 前端按它决定显示哪几行设置."""
        return tuple(k for k, _ in self.layers) + BASE_FEATURES

    def json(self, ready: bool | None = None, detail: str = "") -> dict:
        """给 ``/api/health`` 与 ``track.json`` 用的自描述块."""
        out = {
            "code": self.code,
            "name": self.name,
            "nameEn": self.name_en,
            "native": self.native,
            "script": self.script,
            "engine": self.engine,
            "spaceDelimited": self.space_delimited,
            "layers": {k: v for k, v in self.layers},
            "layerOrder": [k for k, _ in self.layers],
            "features": list(self.features),
        }
        if self.note:
            out["note"] = self.note
        if ready is not None:
            out["ready"] = bool(ready)
            out["detail"] = detail
        return out


def head_of(parts) -> Part:
    """合并单元的「中心语」: 取词性最「实」的那个成分, 并列时取靠前的.

    ``l'homme`` 的中心是 ``homme`` 而不是冠词 ``l'``; ``well-known`` 的中心是
    ``known`` 而不是副词 ``well``; 而 ``didn't`` 的中心是 ``did`` 而不是否定小词。
    一张词性权重表就能同时说对这三种情况, 比按语言写规则稳。
    """
    if not parts:
        return Part("")
    best = parts[0]
    best_rank = _RANK.get(best.pos, 1)
    for p in parts[1:]:
        rank = _RANK.get(p.pos, 1)
        if rank > best_rank:
            best, best_rank = p, rank
    return best


#: 词性的「实词程度」—— 只用于挑合并单元的中心语
_RANK = {
    "noun": 6, "propn": 6, "verb": 6,
    "adj": 5, "adjn": 5, "num": 5,
    "pron": 4, "aux": 4,
    "adv": 3, "interj": 3,
    "conj": 2, "det": 2, "prep": 2, "adnom": 2,
    "particle": 1, "prefix": 1, "suffix": 1, "fill": 1, "other": 1,
    "punct": 0,
}
