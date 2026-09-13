"""韩语罗马字转写 (문화체육관광부 「국어의 로마자 표기법」 / Revised Romanization).

零依赖: 谚文音节可以直接用 Unicode 算式拆成 초성/중성/종성 三个字母, 再按表转写。
真正的难点不是查表, 而是**音变**: 罗马字要按「读音」写而不是按「字形」写, 所以
``한국어`` 是 ``hangugeo`` 而不是 ``hangukeo``, ``종로`` 是 ``jongno`` 而不是 ``jongro``。

已实现的音变 (够覆盖日常文本):

* 连音 —— 韵尾遇到零声母 ``ㅇ`` 移到下一音节 (``한국어`` → hangugeo)
* 鼻音化 —— ``ㄱㄷㅂ`` 遇 ``ㄴㅁ`` 变 ``ㅇㄴㅁ`` (``한국말`` → hangungmal)
* 流音化 —— ``ㄴ+ㄹ`` / ``ㄹ+ㄴ`` 都读 ``ll`` (``설날`` → seollal)
* ``ㄹ`` 前的鼻音化 —— ``종로`` → jongno
* 送气化 —— ``ㅎ`` 与 ``ㄱㄷㅂㅈ`` 相遇 (``좋고`` → joko, ``입학`` → ipak)
* 口盖音化 —— ``ㄷㅌ`` + ``이`` (``같이`` → gachi)

**不**实现的: 硬音化 (罗马字本来就不标)、复合词的 ㄴ 添加、人名/地名的惯用拼法。
词与词之间不做跨界音变 —— 转写以「词」为单位, 与规范一致。
"""

from __future__ import annotations

_BASE = 0xAC00
_LAST = 0xD7A3

# 초성 19 个
_INITIAL = ("g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "",
            "j", "jj", "ch", "k", "t", "p", "h")
# 중성 21 个
_MEDIAL = ("a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae",
           "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i")
# 종성 28 个 (0 = 无韵尾) 的代表音
_CODA = ("", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l",
         "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t")
#: 韵尾遇零声母时的 (留下的韵尾, 移到下一音节的声母)
_LIAISON = (
    ("", ""), ("", "g"), ("", "kk"), ("k", "s"), ("", "n"), ("n", "j"),
    ("n", ""), ("", "d"), ("", "r"), ("l", "g"), ("l", "m"), ("l", "b"),
    ("l", "s"), ("l", "t"), ("l", "p"), ("", "r"), ("", "m"), ("", "b"),
    ("p", "s"), ("", "s"), ("", "ss"), ("ng", ""), ("", "j"), ("", "ch"),
    ("", "k"), ("", "t"), ("", "p"), ("", ""),
)

_N, _M, _R, _NG_H = 2, 6, 5, 18          # 초성下标: ㄴ ㅁ ㄹ ㅎ
_ZERO = 11                               # 초성 ㅇ
_I = 20                                  # 중성 ㅣ
#: 韵尾 ㅎ 遇到这些声母时的送气结果
_ASPIRATE = {0: "k", 3: "t", 7: "p", 12: "ch", 9: "ss"}
_NASALIZE = {"k": "ng", "t": "n", "p": "m"}
#: 含 ㅎ 的韵尾 -> ㅎ 脱落后剩下的辅音
_H_CODA = {6: "n", 15: "l", 27: ""}
_PALATAL = {7: "j", 25: "ch"}            # 종성 ㄷ / ㅌ + 이


def _decompose(ch: str) -> tuple[int, int, int] | None:
    """谚文音节 -> (초성, 중성, 종성) 下标; 非谚文音节返回 ``None``."""
    code = ord(ch)
    if code < _BASE or code > _LAST:
        return None
    code -= _BASE
    return code // 588, (code % 588) // 28, code % 28


def is_hangul(text: str) -> bool:
    return any(_decompose(ch) is not None for ch in text)


def _coda_pair(tail: int, nxt: tuple[int, int, int] | None) -> tuple[str, str | None]:
    """韵尾的转写结果, 以及 (可选的) 强加给下一音节的声母."""
    if tail == 0:
        return "", None
    if nxt is None:
        return _CODA[tail], None
    init, medial, _ = nxt

    if init == _ZERO:                                    # 连音 / 口盖音化
        if tail in _PALATAL and medial == _I:
            return "", _PALATAL[tail]
        keep, moved = _LIAISON[tail]
        return keep, moved

    coda = _CODA[tail]

    if tail in _H_CODA:                                  # 韵尾含 ㅎ
        base = _H_CODA[tail]
        asp = _ASPIRATE.get(init)
        if asp:
            return base, asp
        if init == _N:
            return ("l", "l") if base == "l" else ("n", "n")
        if init == _R:
            return "l", "l"
        return base or coda, None

    if init == _NG_H:                                    # 下一个是 ㅎ: 合成送气音
        if coda in ("k", "t", "p"):
            return "", coda
        return coda, "h"

    if init in (_N, _M):                                 # 鼻音化 / ㄹ+ㄴ
        if coda in _NASALIZE:
            return _NASALIZE[coda], None
        if coda == "l" and init == _N:
            return "l", "l"
        return coda, None

    if init == _R:                                       # ㄹ 前
        if coda in _NASALIZE:
            return _NASALIZE[coda], "n"
        if coda in ("m", "ng"):
            return coda, "n"
        if coda in ("n", "l"):
            return "l", "l"

    return coda, None


def romanize(text: str) -> str:
    """把一段韩语转写成罗马字; 非谚文字符原样保留."""
    if not text:
        return ""
    dec = [_decompose(ch) for ch in text]
    override: list[str | None] = [None] * len(text)
    out: list[str] = []
    for k, cur in enumerate(dec):
        if cur is None:
            out.append(text[k])
            continue
        init, medial, tail = cur
        onset = override[k] if override[k] is not None else _INITIAL[init]
        coda, moved = _coda_pair(tail, dec[k + 1] if k + 1 < len(text) else None)
        if moved is not None and k + 1 < len(text):
            override[k + 1] = moved
        out.append(f"{onset}{_MEDIAL[medial]}{coda}")
    return "".join(out)
