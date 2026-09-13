"""MeCab + UniDic 分词 / 注音 / 罗马音 / 词性.

只依赖 ``fugashi`` (自带 libmecab, Windows / Linux 都有 wheel)。字典按以下顺序解析:

1. 显式传入的 ``dicdir``
2. 环境变量 ``LINGUA_DICDIR`` (旧名 ``LINGUATRACK_DICDIR`` 仍然认)
3. 仓库内 ``./dic`` (项目自带的 现代話し言葉UniDic)
4. pip 包 ``unidic`` / ``unidic_lite``
"""

from __future__ import annotations

import csv
import io
import os
from dataclasses import dataclass
from pathlib import Path

from .kana import expand_choon, furigana_for, is_all_kana, kana_to_romaji, to_katakana
from .pos import classify, pos_chain

# UniDic 特征列下标 (unidic-cwj/csj 2.x); unidic-lite 只有前 17 列, 取值时做长度保护
_F_POS1, _F_POS2, _F_POS3, _F_POS4 = 0, 1, 2, 3
_F_CTYPE, _F_CFORM = 4, 5
_F_LFORM, _F_LEMMA = 6, 7
_F_PRON = 9
_F_GOSHU = 12
_F_KANA = 20


@dataclass(slots=True)
class Morpheme:
    """一个形态素 (前端意义上的「单词」)."""

    surface: str
    char_start: int
    char_end: int
    kana: str = ""  # 出现形的片假名读音 (仮名形: 注音用, 助词 は 仍是 ハ)
    pron: str = ""  # 出现形的发音形 (発音形: 罗马音用, 助词 は 是 ワ)
    furigana: str = ""  # 需要展示的平假名注音 (纯假名词为空)
    romaji: str = ""
    pos: str = "other"  # 紧凑词性标签
    pos_detail: str = ""  # UniDic 完整词性链
    lemma: str = ""  # 词汇素 (辞书形)
    lemma_kana: str = ""
    lemma_romaji: str = ""
    conj: str = ""  # 活用型-活用形
    goshu: str = ""  # 語種 (和/漢/外…)
    start: float = -1.0
    end: float = -1.0

    @property
    def is_punct(self) -> bool:
        return self.pos == "punct"


def _cell(fields: list[str], idx: int) -> str:
    if idx >= len(fields):
        return ""
    value = fields[idx].strip()
    return "" if value in ("*", "") else value


def _parse_feature(raw: str) -> list[str]:
    """UniDic 的 aType 列形如 ``"2,0"``, 必须走 CSV 解析而不能裸 split."""
    try:
        return next(csv.reader(io.StringIO(raw)))
    except StopIteration:
        return []


def resolve_dicdir(explicit: str | os.PathLike[str] | None = None) -> str | None:
    """定位 UniDic 目录; 返回 ``None`` 表示用 MeCab 的系统默认字典."""
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit))
    env = os.environ.get("LINGUA_DICDIR") or os.environ.get("LINGUATRACK_DICDIR")
    if env:
        candidates.append(Path(env))
    candidates.append(Path(__file__).resolve().parent.parent / "dic")

    for cand in candidates:
        if (cand / "sys.dic").is_file():
            return str(cand)
        if cand.is_dir():  # 显式指定但内容不对: 早报错好过后面莫名其妙
            raise FileNotFoundError(f"{cand} 不是有效的 MeCab 字典目录 (缺少 sys.dic)")

    for pkg in ("unidic", "unidic_lite"):
        try:
            mod = __import__(pkg)
        except ImportError:
            continue
        dicdir = getattr(mod, "DICDIR", None)
        if dicdir and (Path(dicdir) / "sys.dic").is_file():
            return str(dicdir)
    return None


class JapaneseTokenizer:
    """线程安全性说明: MeCab tagger 不是线程安全的, 每个线程请各自 new 一个."""

    def __init__(self, dicdir: str | os.PathLike[str] | None = None) -> None:
        try:
            import fugashi
        except ImportError as exc:  # pragma: no cover - 环境问题
            raise RuntimeError("缺少 fugashi, 请先 `pip install fugashi`") from exc

        self.dicdir = resolve_dicdir(dicdir)
        args: list[str] = []
        if self.dicdir:
            # fugashi 走 shlex 拆参数, Windows 反斜杠会被当转义吃掉 -> 统一用正斜杠
            dic_posix = Path(self.dicdir).as_posix()
            # Windows 下 MeCab 找不到 c:\mecab\mecabrc 会直接抛错, 用字典自带的 dicrc 兜底
            rcfile = Path(self.dicdir) / "dicrc"
            if rcfile.is_file():
                args += ["-r", rcfile.as_posix()]
            args += ["-d", dic_posix]
        self._tagger = fugashi.GenericTagger(" ".join(args)) if args else fugashi.GenericTagger()

    # ------------------------------------------------------------------ 分词

    def tokenize(self, text: str) -> list[Morpheme]:
        """分词并回填每个形态素在 ``text`` 中的字符区间 (用于时间戳对齐)."""
        if not text:
            return []
        out: list[Morpheme] = []
        cursor = 0
        for node in self._tagger(text):
            surface = node.surface
            if not surface:
                continue
            pos = text.find(surface, cursor)
            if pos < 0:  # MeCab 归一化过表层形, 退化成顺序推进
                pos = cursor
            cursor = pos + len(surface)
            out.append(self._build(surface, pos, cursor, _parse_feature(node.feature_raw)))
        self._fix_trailing_sokuon(out)
        return out

    @staticmethod
    def _fix_trailing_sokuon(morphemes: list[Morpheme]) -> None:
        """``思っ``+``て`` -> ``omot``+``te``: 词尾促音需要看下一个词才能转写."""
        for i, m in enumerate(morphemes):
            if not m.pron.endswith("ッ"):
                continue
            nxt = morphemes[i + 1].pron if i + 1 < len(morphemes) else ""
            if nxt:
                m.romaji = kana_to_romaji(m.pron, nxt)

    # -------------------------------------------------------------- 单节点构造

    @staticmethod
    def _reading(fields: list[str], surface: str) -> str:
        """出现形的片假名读音."""
        kana = _cell(fields, _F_KANA)
        if kana:
            return kana
        pron = _cell(fields, _F_PRON)
        if pron:
            return expand_choon(pron)
        if is_all_kana(surface):
            return to_katakana(surface)
        return ""

    @staticmethod
    def _pron(fields: list[str], kana: str) -> str:
        """发音形: 罗马音要按「读音」转写 —— 助词 ``は`` 是 ``wa`` 而不是 ``ha``."""
        pron = _cell(fields, _F_PRON)
        return expand_choon(pron) if pron else kana

    def _build(self, surface: str, start: int, end: int, fields: list[str]) -> Morpheme:
        pos1 = _cell(fields, _F_POS1) or "UNK"
        tag = classify(
            pos1,
            _cell(fields, _F_POS2),
            _cell(fields, _F_POS3),
            _cell(fields, _F_POS4),
        )
        kana = self._reading(fields, surface)
        pron = self._pron(fields, kana)
        lemma = _cell(fields, _F_LEMMA) or surface
        lemma_kana = _cell(fields, _F_LFORM)
        return Morpheme(
            surface=surface,
            char_start=start,
            char_end=end,
            kana=kana,
            pron=pron,
            furigana=furigana_for(surface, kana),
            romaji="" if tag == "punct" else kana_to_romaji(pron),
            pos=tag,
            pos_detail=pos_chain(
                pos1,
                _cell(fields, _F_POS2),
                _cell(fields, _F_POS3),
                _cell(fields, _F_POS4),
            ),
            lemma=lemma,
            lemma_kana=lemma_kana,
            lemma_romaji=kana_to_romaji(lemma_kana) if lemma_kana else "",
            conj="-".join(x for x in (_cell(fields, _F_CTYPE), _cell(fields, _F_CFORM)) if x),
            goshu=_cell(fields, _F_GOSHU),
        )

