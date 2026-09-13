"""语言插件.

对外只暴露两样东西: 与语言无关的产物类型 (:class:`Word` / :class:`Part`), 以及
按语言取分析器的入口 (:func:`analyzer`)。具体实现 (MeCab / spaCy) 惰性导入,
所以只装了一半依赖也能跑起来 —— ``/api/health`` 会照实说哪门语言没就位。
"""

from .base import BASE_FEATURES, LAYER_KEYS, LangSpec, Part, Word, head_of
from .registry import (
    DEFAULT_LANG,
    REGISTRY,
    analyzer,
    catalog,
    codes,
    need,
    readiness,
    resolve,
)

__all__ = [
    "BASE_FEATURES", "LAYER_KEYS", "LangSpec", "Part", "Word", "head_of",
    "DEFAULT_LANG", "REGISTRY", "analyzer", "catalog", "codes", "need",
    "readiness", "resolve",
]
