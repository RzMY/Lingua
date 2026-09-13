"""注音层 (``read``) —— 日语以外的读音标注.

日语的假名注音由 MeCab 顺手给出 (见 :mod:`pipeline.kana`); 其余语言的读音得另外算,
按语言路由到三条后端:

===== ==================================== =========================================
语言   后端                                  ``read`` 里放什么
===== ==================================== =========================================
en    g2p-en (CMUdict + 神经网络补未登录词)  IPA 音标 (``cat`` → ``kˈæt``)
ko    hangulpy (표준 발음법)                 标准发音的谚文 (``한국어`` → ``한구거``)
其余   phonemizer + eSpeak NG                IPA 音标 (``mundo`` → ``mˈundo``)
===== ==================================== =========================================

三条后端**全是可选依赖**: 装了就有注音, 缺了就不下发 ``read`` 字段 —— 分析照常完成,
前端那一行会自己收掉。所以这里的任何失败都只意味着「这门语言暂时没注音」, 绝不让
``/api/analyze`` 挂掉; :func:`readiness` 负责在 ``/api/health`` 与
``python -m pipeline langs`` 里说清缺的到底是什么。

**重音符一律放在重音元音前面** (``interesting`` → ``ˈɪntɹəstɪŋ``, ``photography`` →
``fətˈɑɡɹəfi``)。这是 eSpeak 自己的写法, 英语跟着它走, 四门语言的音标风格才一致;
字典式的音节划分 (``fəˈtɑɡɹəfi``) 更严谨, 但为一个辅助层引入音节化算法不划算,
两种写法学习者都读得懂。

后端对象**不是线程安全的** (eSpeak 共享库里全是全局变量), 和分析器一样靠
:mod:`pipeline.api` 的全局锁串行化, 所以下面的记忆化缓存也不加锁。
"""

from __future__ import annotations

import importlib.util
import logging
import os
import pathlib
import re
import unicodedata

#: 语言 -> 后端名; 没列进来的语言走 eSpeak NG
BACKENDS: dict[str, str] = {"en": "g2p-en", "ko": "hangulpy"}
ESPEAK = "eSpeak NG"

#: eSpeak 的声音名与语言码不总是一样 (fr → fr-fr), 认不出来时按前缀现找 (见 _voice)
_VOICE: dict[str, str] = {}

#: 语言 -> 已建好的后端 (或 _UNAVAILABLE); 建一次很贵, 之后一直复用
_UNAVAILABLE = object()
_cache: dict[str, object] = {}

#: 全是标点的 token 不值得注音 (数字要注: ``2026`` → ``twˈɛnti twˈɛnti sˈɪks``)
_WORDY = re.compile(r"[^\W_]", re.UNICODE)
_HYPHENS = re.compile(r"[-‐-―]")
#: 注音串首尾要削掉的字符 (eSpeak 的连读记号)
_EDGE = " -‐‑‒–—"

_LOG = logging.getLogger("pipeline.phon")
_LOG.addHandler(logging.NullHandler())


# ---------------------------------------------------------------- ARPAbet → IPA

#: CMUdict 的 39 个音素. g2p-en 吐的是 ARPAbet (``K AE1 T``), 学习者要的是 IPA,
#: 而且 es/fr/de 那边 eSpeak 直接给 IPA —— 统一成 IPA, 四门语言才是同一套符号。
_ARPA: dict[str, str] = {
    "AA": "ɑ", "AE": "æ", "AH": "ʌ", "AO": "ɔ", "AW": "aʊ", "AY": "aɪ",
    "EH": "ɛ", "ER": "ɝ", "EY": "eɪ", "IH": "ɪ", "IY": "i",
    "OW": "oʊ", "OY": "ɔɪ", "UH": "ʊ", "UW": "u",
    "B": "b", "CH": "tʃ", "D": "d", "DH": "ð", "F": "f", "G": "ɡ", "HH": "h",
    "JH": "dʒ", "K": "k", "L": "l", "M": "m", "N": "n", "NG": "ŋ", "P": "p",
    "R": "ɹ", "S": "s", "SH": "ʃ", "T": "t", "TH": "θ", "V": "v", "W": "w",
    "Y": "j", "Z": "z", "ZH": "ʒ",
}
#: 这两个元音在**无重音**时读的是另一个音: schwa 与 r 化 schwa.
#: 不区分的话 ``about`` 会写成 ``ʌbˈaʊt``, 与词典 ``əˈbaʊt`` 差得太远。
_REDUCED = {"AH": "ə", "ER": "ɚ"}
_STRESS = {"1": "ˈ", "2": "ˌ"}


def arpabet_to_ipa(phones) -> str:
    """``['K', 'AE1', 'T']`` → ``'kˈæt'``; 不认识的 token (标点等) 直接丢掉.

    重音数字只用来挑重音符与判断元音是否弱读, 不进输出。g2p-en 会把数字和缩写展开成
    多个词 (``2026`` → 两个词, ``Mr.`` → ``mister`` + ``.``), 词之间给一个空格 token,
    照样保留 —— 一个展示单元里出现空格是对的。
    """
    out: list[str] = []
    for phone in phones:
        if not phone or phone.isspace():
            out.append(" ")
            continue
        stress = phone[-1] if phone[-1] in "012" else ""
        base = (phone[:-1] if stress else phone).upper()
        ipa = _REDUCED.get(base, "") if stress == "0" else ""
        ipa = ipa or _ARPA.get(base, "")
        if ipa:
            out.append(_STRESS.get(stress, "") + ipa)
    return " ".join("".join(out).split())


# ---------------------------------------------------------------- 三条后端

def _has(name: str) -> bool:
    """包在不在 —— 只查, 不 import (``/api/health`` 得秒回)."""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _fold(text: str) -> str:
    """喂给 g2p-en 之前的规整.

    * 变音符剥掉: 它只认 ASCII, ``café`` 原样进去会被读成 ``kˈæfi``;
    * 连字符换空格: ``well-known`` 整个当未登录词会得到 ``wɛlkɔnɚ``,
      拆成两个词才是 ``wɛl noʊn``。撇号**不能**动 —— ``isn't`` 它自己认得。
    """
    plain = unicodedata.normalize("NFKD", text)
    plain = "".join(ch for ch in plain if not unicodedata.combining(ch))
    return _HYPHENS.sub(" ", plain)


class _Backend:
    """三条后端的公共外壳: 前置守卫 + 按词记忆化 + 「与表层相同就不注音」.

    子类只实现 :meth:`_read`。一份字幕里同一个词往往出现几十次, 所以缓存很值;
    上限不设 —— 一次分析最多也就几万个不同的词, 而对象随分析器一起常驻。
    """

    name = ""

    def __init__(self) -> None:
        self._memo: dict[str, str] = {}

    def _read(self, text: str) -> str:
        raise NotImplementedError

    def __call__(self, surface: str) -> str:
        text = (surface or "").strip()
        if not text or not _WORDY.search(text):
            return ""                          # 纯标点不注音
        hit = self._memo.get(text)
        if hit is not None:
            return hit
        try:
            out = " ".join(str(self._read(text) or "").split())
        except Exception as exc:               # noqa: BLE001 - 一个词出岔子不该毁掉整篇
            _LOG.info("注音失败 %r: %s", text, exc)
            out = ""
        #  注音与表层一模一样就不占一行 —— 和日语「纯假名词不注音」同一条规矩
        self._memo[text] = out = "" if out == text else out
        return out


class _English(_Backend):
    """g2p-en: 先查 CMUdict, 未登录词交给它自带的 seq2seq 模型."""

    name = BACKENDS["en"]

    def __init__(self) -> None:
        super().__init__()
        missing = _nltk_missing()
        if missing:
            #  g2p_en 在 import 时就会自己 nltk.download() —— 数据不在本地的机器上,
            #  那会变成一次分析请求里悄悄发起的网络下载。宁可先在这儿拒绝。
            raise RuntimeError(f"缺 nltk 数据 {missing}")
        from g2p_en import G2p

        self._g2p = G2p()
        try:
            #  数字先展开成词: g2p 自己也会展开, 但 ``2026`` → ``twenty twenty-six``
            #  里的连字符它不拆, 于是 ``twenty-six`` 当未登录词读成了 ``twɛntiskaɪz``。
            #  先展开、再由 _fold 把连字符换成空格就对了。
            from g2p_en.expand import normalize_numbers

            self._expand = normalize_numbers
        except ImportError:                    # 版本里没这个模块就算了, 只影响数字
            self._expand = lambda text: text

    def _read(self, text: str) -> str:
        return arpabet_to_ipa(self._g2p(_fold(self._expand(text.lower()))))


class _Korean(_Backend):
    """hangulpy 的 표준 발음법: 连音/鼻音化/送气化/口盖音化算完, 写出来仍是谚文.

    和 :mod:`pipeline.langs.hangul` 是**一套音变、两种写法** —— 那边给罗马字放下层,
    这边给谚文发音放上层 (``읽어요`` → ``일거요``), 学习者对着看正好。
    """

    name = BACKENDS["ko"]

    def __init__(self) -> None:
        super().__init__()
        from hangulpy import standardize_pronunciation

        self._pron = standardize_pronunciation

    def _read(self, text: str) -> str:
        return self._pron(text)


class _Espeak(_Backend):
    """phonemizer + eSpeak NG: 一门语言一个 backend, 建一次长期复用."""

    name = ESPEAK

    def __init__(self, code: str) -> None:
        super().__init__()
        _load_espeak()
        from phonemizer.backend import EspeakBackend

        self._backend = EspeakBackend(
            _voice(code), with_stress=True, preserve_punctuation=False,
            #  外语词混进来时 eSpeak 会插一个 ``(en)`` 标记并打警告: 标记去掉,
            #  警告闭嘴 —— 一个辅助层不值得往分析日志里灌噪音。
            language_switch="remove-flags", words_mismatch="ignore", logger=_LOG,
        )

    def _read(self, text: str) -> str:
        #  **必须逐词调用**: 批量调用时 phonemizer 会把出不来音的词整项丢掉, 返回的
        #  列表和输入对不上号, 于是整句注音串位。逐词一次 0.07ms, 不值得为它冒险。
        out = self._backend.phonemize([text], strip=True)
        #  eSpeak 会给「要和下一个词连读」的虚词补一个尾巴 (法语 la → ``lˈa-``);
        #  逐词显示时那个连字符只是噪音。
        return out[0].strip(_EDGE) if out else ""


# ---------------------------------------------------------------- eSpeak 的安装位置

def _load_espeak() -> None:
    """告诉 phonemizer 用哪个 eSpeak 共享库, 并让 eSpeak 自己找得到数据目录.

    优先环境变量 (指向系统装的 eSpeak NG), 否则用 espeakng-loader 随 wheel 带进来的
    那一份 —— 于是 Windows / macOS / Linux 都不必另外装系统包:

    * ``LINGUA_ESPEAK_LIBRARY`` —— ``libespeak-ng.so`` / ``espeak-ng.dll`` 的完整路径
    * ``LINGUA_ESPEAK_DATA``    —— **包含** ``espeak-ng-data`` 的那个目录

    phonemizer 3.x 只认库路径 (``EspeakWrapper.set_library``), 数据目录得靠
    ``ESPEAK_DATA_PATH`` 直接告诉 eSpeak 本身。两样都没有时就什么都不做, 让
    phonemizer 走它自己的探测 (系统安装 / ``PHONEMIZER_ESPEAK_LIBRARY``)。
    """
    from phonemizer.backend.espeak.wrapper import EspeakWrapper

    lib = os.environ.get("LINGUA_ESPEAK_LIBRARY", "").strip()
    data = os.environ.get("LINGUA_ESPEAK_DATA", "").strip()
    if not lib and _has("espeakng_loader"):
        import espeakng_loader

        lib = str(espeakng_loader.get_library_path())
        data = data or str(pathlib.Path(espeakng_loader.get_data_path()).parent)
    if lib:
        EspeakWrapper.set_library(lib)
    if data and not os.environ.get("ESPEAK_DATA_PATH"):
        os.environ["ESPEAK_DATA_PATH"] = data


def _voice(code: str) -> str:
    """语言码 → eSpeak 声音名. ``de`` 就叫 ``de``, ``fr`` 得写成 ``fr-fr``.

    先试语言码本身, 再试 ``xx-xx`` (地区变体里最「标准」的那个), 最后才按前缀现找 ——
    直接取前缀第一个会挑到 ``fr-be``。
    """
    hit = _VOICE.get(code)
    if hit:
        return hit
    from phonemizer.backend import EspeakBackend

    names = set(EspeakBackend.supported_languages())
    for cand in (code, f"{code}-{code}"):
        if cand in names:
            hit = cand
            break
    else:
        prefix = code + "-"
        hit = next((n for n in sorted(names) if n.startswith(prefix)), "")
    if not hit:
        raise RuntimeError(f"eSpeak 里没有 {code} 的声音")
    _VOICE[code] = hit
    return hit


# ---------------------------------------------------------------- 依赖探测

#: g2p-en 真正需要的两份 nltk 数据. 词性标注器在 nltk 3.9 改了名, 认哪个都行
#: (老版本只有 ``averaged_perceptron_tagger``, 新版本只用 ``*_eng``)。
_NLTK: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("cmudict", ("corpora/cmudict",)),
    ("averaged_perceptron_tagger_eng", ("taggers/averaged_perceptron_tagger_eng",
                                        "taggers/averaged_perceptron_tagger")),
)


def _nltk_missing() -> str:
    """缺哪份 nltk 数据; 齐了返回空串. **只查本地文件, 绝不下载**."""
    if not _has("nltk"):
        return "nltk"
    import nltk.data

    def found(path: str) -> bool:
        try:
            nltk.data.find(path)
        except Exception:                      # noqa: BLE001 - LookupError 及其它都算没有
            return False
        return True

    for name, paths in _NLTK:
        if not any(found(p) for p in paths):
            return name
    return ""


def backend_of(code: str) -> str:
    """这门语言的注音后端叫什么 (只是名字, 不代表装好了)."""
    return BACKENDS.get(code, ESPEAK)


def readiness(code: str) -> tuple[bool, str]:
    """注音后端就位了吗 —— 只查包与数据文件, 不 import 重模块、不联网.

    给 ``/api/health?probe=1`` 与 ``python -m pipeline langs`` 用。已经建起来的后端
    直接算就位 (:func:`provider` 会把结果缓存下来)。
    """
    kind = backend_of(code)
    hit = _cache.get(code)
    if hit is not None:
        return (False, f"{kind} 不可用") if hit is _UNAVAILABLE else (True, kind)
    if kind == BACKENDS["en"]:
        if not _has("g2p_en"):
            return False, "缺 g2p-en"
        missing = _nltk_missing()
        return (False, f"缺 nltk 数据 {missing}") if missing else (True, kind)
    if kind == BACKENDS["ko"]:
        return (True, kind) if _has("hangulpy") else (False, "缺 hangulpy")
    if not _has("phonemizer"):
        return False, "缺 phonemizer"
    if (_has("espeakng_loader") or os.environ.get("LINGUA_ESPEAK_LIBRARY")
            or os.environ.get("PHONEMIZER_ESPEAK_LIBRARY")):
        return True, kind
    return False, "缺 eSpeak NG 共享库 (pip install espeakng-loader)"


# ---------------------------------------------------------------- 取后端

_BUILDERS = {
    BACKENDS["en"]: lambda _code: _English(),
    BACKENDS["ko"]: lambda _code: _Korean(),
}
#: 自检用的词 (顺手预热): 建得起来还得真能算出注音
_PROBE = {"en": "cat", "ko": "한국어"}


def provider(code: str):
    """取 (或建) 一门语言的注音函数; 依赖缺失时返回 ``None``, **从不抛异常**.

    返回值是个 ``(表层形) -> 注音串`` 的可调用对象, 内部按词记忆化。建后端很贵
    (g2p-en 要加载 CMUdict, eSpeak 要 dlopen 一个共享库), 所以按语言缓存一份 ——
    与 :func:`pipeline.langs.registry.analyzer` 一样, 线程安全由调用方的锁保证。
    """
    hit = _cache.get(code)
    if hit is None:
        try:
            hit = _BUILDERS.get(backend_of(code), _Espeak)(code)
            #  自检必须绕过 __call__ 的兜底: g2p-en 缺词性标注器时是**首次调用**才
            #  抛 LookupError, 构造函数一声不响。
            hit._read(_PROBE.get(code, "a"))            # noqa: SLF001
        except Exception as exc:                        # noqa: BLE001 - 注音是可选层
            _LOG.info("%s 的注音后端不可用: %s", code, exc)
            hit = _UNAVAILABLE
        _cache[code] = hit
    return None if hit is _UNAVAILABLE else hit

