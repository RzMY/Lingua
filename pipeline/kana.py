"""假名工具与罗马音转写.

零依赖实现, 避免 pykakasi / cutlet 之类的可选依赖在离线环境里装不上.

罗马音采用「修正训令式・长音展开」风格 (与目标设计稿一致):

* ``しょうじき`` -> ``shoujiki`` (长音写成元音串, 不用 macron)
* ``おもって``   -> ``omotte``   (促音双写后继辅音)
* ``こんにちは`` -> ``konnichiha`` (逐字转写, 不做 は/wa 的语法特例)
* ``しんや``     -> ``shin'ya``  (ん 后接元音/y 时补撇号消歧)
"""

from __future__ import annotations

import re

# ---------------------------------------------------------------- 字符区间

_HIRA_START, _HIRA_END = 0x3041, 0x3096
_KATA_START, _KATA_END = 0x30A1, 0x30F6
_KATA_OFFSET = _KATA_START - _HIRA_START  # 0x60

KANJI_RE = re.compile(r"[々〇〻㐀-䶿一-鿿豈-﫿]")
KANA_RE = re.compile(r"[ぁ-ゖァ-ヺーｦ-ﾝ]")
LATIN_RE = re.compile(r"[A-Za-z0-9]")


def to_katakana(text: str) -> str:
    """平假名 -> 片假名 (其余字符原样保留)."""
    out = []
    for ch in text:
        code = ord(ch)
        if _HIRA_START <= code <= _HIRA_END:
            out.append(chr(code + _KATA_OFFSET))
        else:
            out.append(ch)
    return "".join(out)


def to_hiragana(text: str) -> str:
    """片假名 -> 平假名 (长音符 ー 保留, 其余字符原样保留)."""
    out = []
    for ch in text:
        code = ord(ch)
        if _KATA_START <= code <= _KATA_END:
            out.append(chr(code - _KATA_OFFSET))
        else:
            out.append(ch)
    return "".join(out)


def has_kanji(text: str) -> bool:
    return bool(KANJI_RE.search(text))


def is_all_kana(text: str) -> bool:
    stripped = text.strip()
    return bool(stripped) and all(KANA_RE.match(ch) or ch in "ーゝゞヽヾ" for ch in stripped)


# ---------------------------------------------------------------- 罗马音表

#: 拗音 / 外来音等两字组合, 必须优先于单字匹配.
_DIGRAPHS = {
    "キャ": "kya", "キュ": "kyu", "キョ": "kyo", "キェ": "kye",
    "ギャ": "gya", "ギュ": "gyu", "ギョ": "gyo", "ギェ": "gye",
    "シャ": "sha", "シュ": "shu", "ショ": "sho", "シェ": "she", "シィ": "shi",
    "ジャ": "ja", "ジュ": "ju", "ジョ": "jo", "ジェ": "je", "ジィ": "ji",
    "チャ": "cha", "チュ": "chu", "チョ": "cho", "チェ": "che",
    "ヂャ": "ja", "ヂュ": "ju", "ヂョ": "jo",
    "ニャ": "nya", "ニュ": "nyu", "ニョ": "nyo", "ニェ": "nye",
    "ヒャ": "hya", "ヒュ": "hyu", "ヒョ": "hyo", "ヒェ": "hye",
    "ビャ": "bya", "ビュ": "byu", "ビョ": "byo", "ビェ": "bye",
    "ピャ": "pya", "ピュ": "pyu", "ピョ": "pyo", "ピェ": "pye",
    "ミャ": "mya", "ミュ": "myu", "ミョ": "myo", "ミェ": "mye",
    "リャ": "rya", "リュ": "ryu", "リョ": "ryo", "リェ": "rye",
    "ファ": "fa", "フィ": "fi", "フェ": "fe", "フォ": "fo", "フュ": "fyu", "フャ": "fya",
    "ヴァ": "va", "ヴィ": "vi", "ヴェ": "ve", "ヴォ": "vo", "ヴュ": "vyu",
    "ツァ": "tsa", "ツィ": "tsi", "ツェ": "tse", "ツォ": "tso",
    "ティ": "ti", "トゥ": "tu", "テュ": "tyu",
    "ディ": "di", "ドゥ": "du", "デュ": "dyu",
    "ウィ": "wi", "ウェ": "we", "ウォ": "wo",
    "スィ": "si", "ズィ": "zi",
    "クヮ": "kwa", "クァ": "kwa", "クィ": "kwi", "クェ": "kwe", "クォ": "kwo",
    "グヮ": "gwa", "グァ": "gwa", "グィ": "gwi", "グェ": "gwe", "グォ": "gwo",
    "イェ": "ye",
}

#: 单假名.
_MONOGRAPHS = {
    "ア": "a", "イ": "i", "ウ": "u", "エ": "e", "オ": "o",
    "カ": "ka", "キ": "ki", "ク": "ku", "ケ": "ke", "コ": "ko",
    "ガ": "ga", "ギ": "gi", "グ": "gu", "ゲ": "ge", "ゴ": "go",
    "サ": "sa", "シ": "shi", "ス": "su", "セ": "se", "ソ": "so",
    "ザ": "za", "ジ": "ji", "ズ": "zu", "ゼ": "ze", "ゾ": "zo",
    "タ": "ta", "チ": "chi", "ツ": "tsu", "テ": "te", "ト": "to",
    "ダ": "da", "ヂ": "ji", "ヅ": "zu", "デ": "de", "ド": "do",
    "ナ": "na", "ニ": "ni", "ヌ": "nu", "ネ": "ne", "ノ": "no",
    "ハ": "ha", "ヒ": "hi", "フ": "fu", "ヘ": "he", "ホ": "ho",
    "バ": "ba", "ビ": "bi", "ブ": "bu", "ベ": "be", "ボ": "bo",
    "パ": "pa", "ピ": "pi", "プ": "pu", "ペ": "pe", "ポ": "po",
    "マ": "ma", "ミ": "mi", "ム": "mu", "メ": "me", "モ": "mo",
    "ヤ": "ya", "ユ": "yu", "ヨ": "yo",
    "ラ": "ra", "リ": "ri", "ル": "ru", "レ": "re", "ロ": "ro",
    "ワ": "wa", "ヰ": "i", "ヱ": "e", "ヲ": "o",
    "ヴ": "vu",
    "ァ": "a", "ィ": "i", "ゥ": "u", "ェ": "e", "ォ": "o",
    "ャ": "ya", "ュ": "yu", "ョ": "yo", "ヮ": "wa",
    "ヵ": "ka", "ヶ": "ke",
}

#: 全角标点 -> 便于西文排版的等价符号.
_PUNCT = {
    "、": ",", "，": ",", "。": ".", "．": ".", "！": "!", "？": "?",
    "・": "-", "「": '"', "」": '"', "『": '"', "』": '"',
    "（": "(", "）": ")", "：": ":", "；": ";", "〜": "~", "ー": "-",
    "　": " ", "…": "...",
}

_VOWELS = "aiueo"

# 单元种类
_SYL = 0  # 普通音节
_SOKUON = 1  # 促音 ッ
_MOraN = 2  # 撥音 ン
_CHOON = 3  # 长音 ー
_RAW = 4  # 直接透传 (拉丁字母 / 标点 / 汉字…)


def _scan_units(kata: str) -> list[tuple[int, str, str]]:
    """把片假名串扫描成 ``(kind, 原文, 初步罗马音)`` 单元序列."""
    units: list[tuple[int, str, str]] = []
    i, n = 0, len(kata)
    while i < n:
        pair = kata[i : i + 2]
        if len(pair) == 2 and pair in _DIGRAPHS:
            units.append((_SYL, pair, _DIGRAPHS[pair]))
            i += 2
            continue
        ch = kata[i]
        i += 1
        if ch == "ッ":
            units.append((_SOKUON, ch, ""))
        elif ch == "ン":
            units.append((_MOraN, ch, "n"))
        elif ch in "ーヽヾゝゞ":
            units.append((_CHOON, ch, ""))
        elif ch in _MONOGRAPHS:
            units.append((_SYL, ch, _MONOGRAPHS[ch]))
        else:
            units.append((_RAW, ch, _PUNCT.get(ch, ch)))
    return units


def _next_romaji(units: list[tuple[int, str, str]], idx: int) -> str:
    """向后找到第一个有实际发音的罗马音, 用于促音/撥音的上下文判断."""
    for kind, _, rom in units[idx + 1 :]:
        if kind == _SOKUON:
            continue
        if rom:
            return rom
    return ""


def kana_to_romaji(text: str, next_kana: str = "") -> str:
    """假名(平/片)转罗马音. 非假名字符按标点表映射或原样保留.

    ``next_kana`` 是下一个形态素的读音, 只用于「词尾促音」的前瞻:
    MeCab 会把 ``思って`` 切成 ``思っ`` + ``て``, 有了前瞻才能得到
    ``omot`` + ``te`` 而不是丢音的 ``omo`` + ``te``.
    """
    if not text:
        return ""
    units = _scan_units(to_katakana(text))
    emit = len(units)
    if next_kana:
        units += _scan_units(to_katakana(next_kana))
    out: list[str] = []
    for idx, (kind, _src, rom) in enumerate(units[:emit]):
        if kind == _SYL or kind == _RAW:
            out.append(rom)
        elif kind == _SOKUON:
            nxt = _next_romaji(units, idx)
            if not nxt or nxt[0] in _VOWELS:
                continue  # 词尾促音 / 元音前促音: 不转写
            out.append("t" if nxt.startswith("ch") else nxt[0])
        elif kind == _MOraN:
            nxt = _next_romaji(units, idx)
            out.append("n'" if nxt[:1] in ("a", "i", "u", "e", "o", "y") else "n")
        elif kind == _CHOON:
            tail = "".join(out)
            prev_vowel = next((c for c in reversed(tail) if c in _VOWELS), "")
            out.append(prev_vowel)
    return "".join(out)


_CHOON_FILL = {"a": "ア", "i": "イ", "u": "ウ", "e": "エ", "o": "ウ"}


def expand_choon(kata: str) -> str:
    """把发音形里的长音符 ``ー`` 展开成假名 (``キョー`` -> ``キョウ``).

    仅在字典缺少「書字形の仮名」列时作为兜底, 因此不追求 100% 正字法正确.
    """
    if "ー" not in kata:
        return kata
    out: list[str] = []
    for ch in kata:
        if ch == "ー" and out:
            rom = kana_to_romaji("".join(out))
            vowel = next((c for c in reversed(rom) if c in _VOWELS), "")
            out.append(_CHOON_FILL.get(vowel, ""))
        elif ch != "ー":
            out.append(ch)
    return "".join(out)


def furigana_for(surface: str, kana_reading: str) -> str:
    reading = to_hiragana(kana_reading or "")
    if not reading:
        return ""
    if not (has_kanji(surface) or LATIN_RE.search(surface)):
        return ""
    if reading == to_hiragana(surface):
        return ""
    return reading


