"""词性 -> 前端紧凑标签.

两套输入折叠到同一套标签上:

* **UniDic** 的 ``品詞大分類/中分類`` (日语, 见 :func:`classify`);
* **UPOS / XPOS** (spaCy 的其它语言, 见 :func:`classify_upos`)。

之所以要折叠: 原始标签集有几十上百种, 直接塞给前端既臃肿又没法着色。这里压成 20 个
语言学上有意义、视觉上可区分的标签; 配色由 ``web/css/reader.css`` 的 ``.p-<tag>``
规则决定 —— 数据层不掺和表现层。
"""

from __future__ import annotations

#: tag -> (中文标签, 英文标签); 顺序即图例里的展示顺序
POS_LABELS: dict[str, tuple[str, str]] = {
    "noun": ("名词", "noun"),
    "propn": ("专有名词", "proper noun"),
    "pron": ("代词", "pronoun"),
    "num": ("数词", "numeral"),
    "verb": ("动词", "verb"),
    "adj": ("形容词", "adjective"),
    "adjn": ("形容动词", "na-adjective"),
    "adv": ("副词", "adverb"),
    "adnom": ("连体词", "adnominal"),
    "det": ("限定词", "determiner"),
    "conj": ("连词", "conjunction"),
    "interj": ("感叹词", "interjection"),
    "particle": ("助词", "particle"),
    "prep": ("介词", "preposition"),
    "aux": ("助动词", "auxiliary"),
    "prefix": ("前缀", "prefix"),
    "suffix": ("后缀", "suffix"),
    "fill": ("填充语", "filler"),
    "punct": ("标点", "punctuation"),
    "other": ("其他", "other"),
}

# ---------------------------------------------------------------- UniDic (日语)

#: 品詞大分類 -> tag (无需看中分類的直通项)
_POS1 = {
    "動詞": "verb",
    "形容詞": "adj",
    "形状詞": "adjn",
    "副詞": "adv",
    "連体詞": "adnom",
    "接続詞": "conj",
    "感動詞": "interj",
    "助詞": "particle",
    "助動詞": "aux",
    "接頭辞": "prefix",
    "接尾辞": "suffix",
    "代名詞": "pron",
    "フィラー": "fill",
    "補助記号": "punct",
    "記号": "punct",
    "空白": "punct",
    "未知語": "other",
    "UNK": "other",
}

#: 名詞 的中分類细化
_NOUN2 = {
    "固有名詞": "propn",
    "数詞": "num",
    "助動詞語幹": "aux",
}


def classify(pos1: str, pos2: str = "", pos3: str = "", pos4: str = "") -> str:
    """把 UniDic 四级词性折叠成一个紧凑标签."""
    if pos1 == "名詞":
        return _NOUN2.get(pos2, "noun")
    if pos1 == "接尾辞" and pos2 == "動詞的":
        return "verb"
    tag = _POS1.get(pos1)
    if tag:
        return tag
    return "other"


def pos_chain(*parts: str) -> str:
    """把四级词性拼成 ``名詞-普通名詞-副詞可能`` 形式, 丢掉尾部的 ``*``."""
    kept: list[str] = []
    for p in parts:
        if not p or p == "*":
            break
        kept.append(p)
    return "-".join(kept)


# ------------------------------------------------------------ UPOS (spaCy 通用)

#: Universal POS -> tag
UPOS: dict[str, str] = {
    "NOUN": "noun",
    "PROPN": "propn",
    "PRON": "pron",
    "NUM": "num",
    "VERB": "verb",
    "AUX": "aux",
    "ADJ": "adj",
    "ADV": "adv",
    "DET": "det",
    "CCONJ": "conj",
    "SCONJ": "conj",
    "CONJ": "conj",
    "INTJ": "interj",
    "PART": "particle",
    "ADP": "prep",
    "PUNCT": "punct",
    "SYM": "punct",
    "SPACE": "punct",
    "X": "other",
}

#: 韩语 (mecab-ko/세종) XPOS -> tag; ``tag_`` 里每个 ``+`` 段落对应一个语素
KO_XPOS: dict[str, str] = {
    "NNG": "noun", "NNP": "propn", "NNB": "noun", "NNBC": "noun",
    "NR": "num", "NP": "pron", "SN": "num",
    "VV": "verb", "VA": "adj", "VX": "aux", "VCP": "aux", "VCN": "aux",
    "MM": "det", "MAG": "adv", "MAJ": "conj", "IC": "interj",
    "JKS": "particle", "JKC": "particle", "JKG": "particle", "JKO": "particle",
    "JKB": "particle", "JKV": "particle", "JKQ": "particle", "JX": "particle",
    "JC": "particle",
    "EP": "aux", "EF": "aux", "EC": "aux", "ETN": "aux", "ETM": "aux",
    "XPN": "prefix", "XSN": "suffix", "XSV": "suffix", "XSA": "suffix",
    "XR": "noun",
    "SF": "punct", "SP": "punct", "SS": "punct", "SE": "punct", "SO": "punct",
    "SW": "punct", "SSO": "punct", "SSC": "punct", "SC": "punct",
    "SL": "other", "SH": "noun", "SY": "punct", "NA": "other", "UNKNOWN": "other",
}


def classify_upos(upos: str, xpos: str = "") -> str:
    """UPOS (必要时参考语言特有的 XPOS) -> 紧凑标签."""
    tag = UPOS.get((upos or "").upper())
    if tag:
        return tag
    return classify_xpos(xpos) if xpos else "other"


def classify_xpos(xpos: str) -> str:
    """韩语 XPOS 段落 -> 紧凑标签; 认不出来就 ``other``."""
    key = (xpos or "").strip().upper()
    if key in KO_XPOS:
        return KO_XPOS[key]
    # 세종 标签的首字母已经能定大类 (N 名词 / V 用言 / J 助词 / E 词尾 / S 符号)
    return {"N": "noun", "V": "verb", "J": "particle", "E": "aux",
            "M": "adv", "X": "suffix", "S": "punct"}.get(key[:1], "other")


# ---------------------------------------------------------------- 图例


def legend() -> dict[str, dict[str, str]]:
    """完整词性图例 (所有标签)."""
    return {tag: {"label": zh, "labelEn": en} for tag, (zh, en) in POS_LABELS.items()}


def legend_for(tags) -> dict[str, dict[str, str]]:
    """只导出本条音频真正用到的标签 —— 图例才不会列一堆用不上的词性."""
    used = {t for t in tags if t in POS_LABELS} | {"punct", "other"}
    return {tag: {"label": zh, "labelEn": en}
            for tag, (zh, en) in POS_LABELS.items() if tag in used}
