"""支持的源语言清单 —— 加语言只动这一个文件.

一条 :class:`~pipeline.langs.base.LangSpec` 说清四件事: 怎么显示 (名字 / 文字层)、
用哪个引擎分析、句子怎么切 (句末标点、词间是否有空白)、以及有没有装好依赖。
分析器按 (语言, 词典) 缓存并惰性构建 —— 光是加载一个 spaCy 模型就要一秒上下。
"""

from __future__ import annotations

import threading

from .base import LangSpec

#: 拉丁语言共用的一套切句符号 (句末标点后必须跟空白才算断句, 见 pipeline.align)
_LATIN_END = ".!?…"
_LATIN_TRAIL = "\"')]}»”’"

_LANGS: tuple[LangSpec, ...] = (
    LangSpec(
        code="ja", name="日语", name_en="Japanese", native="日本語",
        script="kanji-kana", engine="mecab",
        layers=(("read", "假名"), ("roman", "罗马音")),
        aliases=("jpn", "jp", "japanese"),
        note="MeCab + UniDic",
    ),
    LangSpec(
        code="en", name="英语", name_en="English", native="English",
        script="latin", engine="spacy", model="en_core_web_sm",
        layers=(("read", "音标"), ("roman", "原形")),
        aliases=("eng", "english", "en-us", "en-gb"),
        sent_end=_LATIN_END, trailing=_LATIN_TRAIL, space_delimited=True,
    ),
    LangSpec(
        code="es", name="西班牙语", name_en="Spanish", native="Español",
        script="latin", engine="spacy", model="es_core_news_sm",
        layers=(("read", "音标"), ("roman", "原形")),
        aliases=("spa", "spanish", "es-es", "es-mx"),
        sent_end=_LATIN_END, trailing=_LATIN_TRAIL, space_delimited=True,
    ),
    LangSpec(
        code="fr", name="法语", name_en="French", native="Français",
        script="latin", engine="spacy", model="fr_core_news_sm",
        layers=(("read", "音标"), ("roman", "原形")),
        aliases=("fra", "fre", "french", "fr-fr"),
        sent_end=_LATIN_END, trailing=_LATIN_TRAIL, space_delimited=True,
    ),
    LangSpec(
        code="de", name="德语", name_en="German", native="Deutsch",
        script="latin", engine="spacy", model="de_core_news_sm",
        layers=(("read", "音标"), ("roman", "原形")),
        aliases=("deu", "ger", "german", "de-de"),
        sent_end=_LATIN_END, trailing=_LATIN_TRAIL, space_delimited=True,
    ),
    LangSpec(
        code="ko", name="韩语", name_en="Korean", native="한국어",
        script="hangul", engine="spacy", model="ko_core_news_sm",
        layers=(("read", "发音"), ("roman", "罗马字")),
        aliases=("kor", "korean", "ko-kr"),
        sent_end=_LATIN_END + "。！？", trailing="\"')]}”’", space_delimited=True,
    ),
)

REGISTRY: dict[str, LangSpec] = {spec.code: spec for spec in _LANGS}
_ALIASES: dict[str, str] = {}
for _spec in _LANGS:
    _ALIASES[_spec.code] = _spec.code
    _ALIASES[_spec.name_en.lower()] = _spec.code
    for _alias in _spec.aliases:
        _ALIASES[_alias.lower()] = _spec.code

DEFAULT_LANG = "ja"


def codes() -> list[str]:
    return [spec.code for spec in _LANGS]


def resolve(code: str | None) -> LangSpec | None:
    """``ja-JP`` / ``jpn`` / ``Japanese`` 都认; 认不出来返回 ``None``."""
    raw = str(code or "").strip().lower().replace("_", "-")
    if not raw:
        return None
    hit = _ALIASES.get(raw)
    if hit:
        return REGISTRY[hit]
    head = raw.split("-")[0]
    hit = _ALIASES.get(head)
    return REGISTRY[hit] if hit else None


def need(code: str | None) -> LangSpec:
    spec = resolve(code)
    if spec is None:
        raise ValueError(f"不支持的语言 {code!r}; 可用: {', '.join(codes())}")
    return spec


def readiness(spec: LangSpec, dicdir: str | None = None) -> tuple[bool, str]:
    """依赖是否就位 —— 不加载模型, 只查包/词典是否存在.

    ``ready`` 只看**分词引擎**: 注音后端 (:mod:`.phon`) 是可选依赖, 缺了只是少一个
    显示层, 这门语言照样能用, 所以只把情况写进 ``detail`` (``en_core_web_sm + g2p-en``
    / ``en_core_web_sm (注音: 缺 g2p-en)``), 不把整门语言判成缺依赖。
    """
    if spec.engine == "mecab":
        from .ja import dict_ready

        return dict_ready(dicdir)
    from .spacy_ import model_ready

    ok, detail = model_ready(spec.model)
    detail = detail or spec.model
    if not ok or "read" not in spec.layer_map:
        return ok, detail
    from . import phon

    ready, note = phon.readiness(spec.code)
    return True, f"{detail} + {note}" if ready else f"{detail} (注音: {note})"


def catalog(*, probe: bool = False, dicdir: str | None = None) -> list[dict]:
    """给 ``/api/health`` 的语言清单; ``probe`` 决定是否附上依赖检测结果."""
    out = []
    for spec in _LANGS:
        if not probe:
            out.append(spec.json())
            continue
        ok, detail = readiness(spec, dicdir)
        out.append(spec.json(ready=ok, detail=detail))
    return out


# ---------------------------------------------------------------- 分析器缓存

_lock = threading.Lock()
_cache: dict[tuple[str, bool, str], object] = {}


def analyzer(spec: LangSpec, *, merge: bool = True, dicdir: str | None = None):
    """取 (或建) 一个分析器.

    分析器**不是线程安全的** (MeCab tagger 与 spaCy 都不是), 所以调用方必须自己
    串行化; :mod:`pipeline.api` 用一把全局锁做这件事。
    """
    key = (spec.code, bool(merge), str(dicdir or ""))
    with _lock:
        hit = _cache.get(key)
        if hit is not None:
            return hit
    if spec.engine == "mecab":
        from .ja import JapaneseAnalyzer

        built = JapaneseAnalyzer(spec, merge=merge, dicdir=dicdir)
    else:
        from .spacy_ import SpacyAnalyzer

        built = SpacyAnalyzer(spec, merge=merge)
    with _lock:
        _cache.setdefault(key, built)
        return _cache[key]
