"""Lingua 分析管道的单元测试.

只用标准库, 不需要 pytest::

    python -m unittest discover -s tests -v

按语言依赖自动跳过: 日语用例需要 fugashi + UniDic 词典, 其余五门语言需要 spaCy 及
对应的 ``*_core_*_sm`` 模型。与语言无关的部分 (输入解析 / 时间轴 / 切句 / 罗马字)
纯离线, 任何环境都会跑。
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline import SCHEMA_VERSION, align, inputs, kana, langs, pos  # noqa: E402
from pipeline.analyze import AnalyzeOptions, analyze  # noqa: E402
from pipeline.inputs import Chunk, InputError  # noqa: E402
from pipeline.langs import hangul, phon  # noqa: E402
from pipeline.langs.base import Part, head_of  # noqa: E402
from pipeline.merge import DisplayWord, merge_morphemes  # noqa: E402
from pipeline.tokenizer import Morpheme, resolve_dicdir  # noqa: E402


def _ready(code: str) -> bool:
    """依赖是否装齐 —— 直接问注册表, 与 ``/api/health?probe=1`` 同一条路径."""
    spec = langs.resolve(code)
    return bool(spec) and langs.readiness(spec)[0]


HAS_MECAB = _ready("ja")
needs_mecab = unittest.skipUnless(HAS_MECAB, "需要 fugashi + UniDic 词典")


def needs_lang(code: str):
    return unittest.skipUnless(_ready(code), f"需要 {code} 的分析依赖")


def needs_read(code: str):
    """注音后端是**可选**依赖 —— 缺了只是没有上层, 不该让整套测试变红.

    只管注音后端; 分词引擎另外由 :func:`needs_lang` 把关 (端到端用例两个都要)。
    """
    return unittest.skipUnless(
        phon.readiness(code)[0],
        f"需要 {code} 的注音后端 ({phon.backend_of(code)})")


def mk(surface: str, tag: str = "noun", *, start: int = 0, kana_: str = "",
       pron: str = "", detail: str = "") -> Morpheme:
    """手搓一个形态素, 免得单元测试都得先跑 MeCab."""
    reading = kana_ or kana.to_katakana(surface)
    return Morpheme(
        surface=surface,
        char_start=start,
        char_end=start + len(surface),
        kana=reading,
        pron=pron or reading,
        romaji="" if tag == "punct" else kana.kana_to_romaji(pron or reading),
        pos=tag,
        pos_detail=detail,
    )


def chain(*specs) -> list[Morpheme]:
    """按顺序拼形态素, 自动接续 char 偏移 (合并规则要求字符相邻)."""
    out: list[Morpheme] = []
    at = 0
    for spec in specs:
        surface, tag = spec[0], spec[1]
        extra = spec[2] if len(spec) > 2 else {}
        out.append(mk(surface, tag, start=at, **extra))
        at += len(surface)
    return out


class KanaTest(unittest.TestCase):
    def test_case_conversion(self):
        self.assertEqual(kana.to_hiragana("キョウ"), "きょう")
        self.assertEqual(kana.to_katakana("きょう"), "キョウ")
        self.assertEqual(kana.to_hiragana("リャー"), "りゃー")  # 长音符原样保留

    def test_predicates(self):
        self.assertTrue(kana.is_all_kana("こんばんは"))
        self.assertTrue(kana.is_all_kana("リャー"))
        self.assertFalse(kana.is_all_kana("今日"))
        self.assertTrue(kana.has_kanji("今日"))
        self.assertFalse(kana.has_kanji("きょう"))

    def test_romaji_basics(self):
        self.assertEqual(kana.kana_to_romaji("キョウ"), "kyou")
        self.assertEqual(kana.kana_to_romaji("トウキョウ"), "toukyou")
        self.assertEqual(kana.kana_to_romaji("リャー"), "ryaa")   # 拗音 + 长音
        self.assertEqual(kana.kana_to_romaji("マッチャ"), "matcha")
        self.assertEqual(kana.kana_to_romaji("ファイト"), "faito")

    def test_romaji_needs_next_kana_for_trailing_sokuon(self):
        """词尾促音只有看到下一个词才能转写: 思っ|て -> omot|te."""
        self.assertEqual(kana.kana_to_romaji("オモッ"), "omo")
        self.assertEqual(kana.kana_to_romaji("オモッ", "テ"), "omot")

    def test_expand_choon(self):
        self.assertEqual(kana.expand_choon("キョー"), "キョウ")
        self.assertEqual(kana.expand_choon("キョウ"), "キョウ")   # 幂等

    def test_furigana_only_when_needed(self):
        self.assertEqual(kana.furigana_for("今日", "キョウ"), "きょう")
        self.assertEqual(kana.furigana_for("お疲れ様", "オツカレサマ"), "おつかれさま")
        self.assertEqual(kana.furigana_for("ある", "アル"), "")   # 纯假名不注音


class PosTest(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(pos.classify("名詞", "普通名詞"), "noun")
        self.assertEqual(pos.classify("名詞", "固有名詞"), "propn")
        self.assertEqual(pos.classify("名詞", "数詞"), "num")
        self.assertEqual(pos.classify("動詞"), "verb")
        self.assertEqual(pos.classify("助詞", "接続助詞"), "particle")
        self.assertEqual(pos.classify("補助記号", "句点"), "punct")
        self.assertEqual(pos.classify("接尾辞", "動詞的"), "verb")
        self.assertEqual(pos.classify("なにこれ"), "other")

    def test_pos_chain_stops_at_star(self):
        self.assertEqual(pos.pos_chain("名詞", "普通名詞", "*", "*"), "名詞-普通名詞")

    def test_legend_covers_every_tag(self):
        legend = pos.legend()
        for tag in ("noun", "verb", "particle", "aux", "punct", "other"):
            self.assertIn(tag, legend)
            self.assertTrue(legend[tag]["label"])


SRT = """1
00:00:01,000 --> 00:00:03,500
こんばんは。
おかえりなさい。

2
00:00:04,000 --> 00:00:05,250
Good evening
everyone
"""

VTT = """WEBVTT

00:00:01.000 --> 00:00:02.000
<00:00:01.000>今日<00:00:01.400>は<00:00:01.600>ね
"""


class InputsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def write(self, name: str, text: str) -> Path:
        path = self.dir / name
        path.write_text(text, encoding="utf-8")
        return path

    def test_srt(self):
        segs = inputs.load_subtitle(self.write("a.srt", SRT))
        self.assertEqual(len(segs), 2)
        self.assertEqual(segs[0].start, 1.0)
        self.assertEqual(segs[0].end, 3.5)
        # 日语换行处不能插空格, 西文之间要插
        self.assertEqual(segs[0].text, "こんばんは。おかえりなさい。")
        self.assertEqual(segs[1].text, "Good evening everyone")
        self.assertFalse(segs[0].has_word_timing)

    def test_vtt_inline_karaoke_timestamps(self):
        segs = inputs.load_subtitle(self.write("a.vtt", VTT))
        self.assertEqual(len(segs), 1)
        self.assertEqual(segs[0].text, "今日はね")
        self.assertTrue(segs[0].has_word_timing)
        self.assertEqual([c.text for c in segs[0].chunks], ["今日", "は", "ね"])
        self.assertAlmostEqual(segs[0].chunks[1].start, 1.4, places=3)

    def test_word_json(self):
        payload = {
            "language": "ja",
            "segments": [{
                "start": 0.5, "end": 1.4, "text": "今日はね",
                "words": [
                    {"word": "今日", "start": 0.5, "end": 0.9},
                    {"word": "は", "start": 0.9, "end": 1.1},
                    {"word": "ね", "start": 1.1, "end": 1.4},
                ],
            }],
        }
        path = self.write("a.json", json.dumps(payload, ensure_ascii=False))
        segs, lang = inputs.load_word_json(path)
        self.assertEqual(lang, "ja")
        self.assertEqual(len(segs), 1)
        self.assertTrue(segs[0].has_word_timing)
        self.assertEqual(len(segs[0].chunks), 3)

    def test_bad_inputs(self):
        with self.assertRaises(InputError):
            inputs.load_any(self.write("a.txt", "hi"))
        with self.assertRaises(InputError):
            inputs.load_subtitle(self.write("empty.srt", "\n\n"))


class AlignTest(unittest.TestCase):
    def test_char_timeline_is_exact_when_chunks_cover_text(self):
        text = "今日はね"
        chunks = [Chunk("今日", 0.5, 0.9), Chunk("は", 0.9, 1.1), Chunk("ね", 1.1, 1.4)]
        tl = align.build_char_timeline(text, chunks, 0.5, 1.4)
        self.assertTrue(tl.exact)
        self.assertEqual(len(tl), len(text))
        self.assertAlmostEqual(tl.cs[0], 0.5)
        self.assertAlmostEqual(tl.ce[-1], 1.4)
        for i in range(1, len(tl)):
            self.assertGreaterEqual(tl.cs[i], tl.cs[i - 1])   # 单调
        self.assertAlmostEqual(tl.span(0, 2)[1], 0.9)          # 「今日」的区间

    def test_char_timeline_falls_back_to_uniform(self):
        tl = align.build_char_timeline("あいうえお", [], 0.0, 5.0)
        self.assertFalse(tl.exact)
        self.assertAlmostEqual(tl.cs[3], 3.0)

    def test_char_timeline_interpolates_uncovered_chars(self):
        """标点没有 ASR 片段, 要按两侧邻居插值, 不能留 None."""
        text = "はい、そう"
        chunks = [Chunk("はい", 0.0, 1.0), Chunk("そう", 2.0, 3.0)]
        tl = align.build_char_timeline(text, chunks, 0.0, 3.0)
        self.assertFalse(tl.exact)      # 「、」没被覆盖
        self.assertEqual(len(tl), len(text))
        self.assertTrue(all(x is not None for x in tl.cs))
        self.assertAlmostEqual(tl.cs[2], 1.0)
        self.assertAlmostEqual(tl.ce[2], 2.0)

    def test_chunks_are_normalized_before_use(self):
        """倒序/重叠的 ASR 时间戳会被裁直, 否则前端二分查找会错位."""
        text = "あいう"
        chunks = [Chunk("あ", 1.0, 2.0), Chunk("い", 0.5, 1.5), Chunk("う", 3.0, 3.0)]
        tl = align.build_char_timeline(text, chunks, 1.0, 3.5)
        self.assertGreaterEqual(tl.cs[1], tl.cs[0])
        self.assertGreaterEqual(tl.cs[2], tl.cs[1])
        self.assertGreater(tl.ce[2], tl.cs[2])

    def test_split_by_punctuation(self):
        text = "こんばんは。おかえりなさい。"
        tl = align.build_char_timeline(text, [], 0.0, 4.0)
        ranges = align.split_ranges(text, tl)
        self.assertEqual([text[a:b] for a, b in ranges],
                         ["こんばんは。", "おかえりなさい。"])

    def test_split_keeps_closing_bracket_with_the_sentence(self):
        text = "「そう。」でもね。"
        tl = align.build_char_timeline(text, [], 0.0, 4.0)
        ranges = align.split_ranges(text, tl)
        self.assertEqual([text[a:b] for a, b in ranges], ["「そう。」", "でもね。"])

    def test_tiny_fragments_merge_back(self):
        text = "あ。"
        tl = align.build_char_timeline(text, [], 0.0, 1.0)
        self.assertEqual(align.split_ranges(text, tl), [(0, 2)])

    def test_split_by_gap_needs_exact_timeline(self):
        """没有词级时间戳时不按停顿切句 —— 估算出来的停顿是假的."""
        text = "あ" * 40
        tl = align.build_char_timeline(text, [], 0.0, 40.0)
        self.assertEqual(align.split_ranges(text, tl, max_seconds=5.0), [(0, 40)])

    def test_split_long_run_by_gap(self):
        text = "あいうえおかきくけこ"
        chunks = [Chunk(ch, i * 2.0 if i < 5 else i * 2.0 + 4, i * 2.0 + 1.0 if i < 5 else i * 2.0 + 5)
                  for i, ch in enumerate(text)]
        tl = align.build_char_timeline(text, chunks, 0.0, 28.0)
        ranges = align.split_ranges(text, tl, max_seconds=6.0, min_gap=0.5)
        self.assertGreater(len(ranges), 1)
        self.assertEqual("".join(text[a:b] for a, b in ranges), text)

    def test_assign_word_times_is_monotonic(self):
        text = "今日はね"
        chunks = [Chunk("今日", 0.5, 0.9), Chunk("は", 0.9, 1.1), Chunk("ね", 1.1, 1.4)]
        tl = align.build_char_timeline(text, chunks, 0.5, 1.4)
        ms = chain(("今日", "noun"), ("は", "particle"), ("ね", "particle"))
        align.assign_word_times(ms, tl)
        self.assertAlmostEqual(ms[0].start, 0.5)
        self.assertAlmostEqual(ms[-1].end, 1.4)
        for prev, cur in zip(ms, ms[1:]):
            self.assertGreaterEqual(cur.start, prev.end)
            self.assertGreater(cur.end, cur.start)

    def test_enforce_monotonic_fixes_overlap_and_zero_length(self):
        fixed = align.enforce_monotonic([(0.0, 1.0), (0.5, 0.8), (0.8, 0.8)])
        self.assertEqual(fixed[0], (0.0, 1.0))
        self.assertGreaterEqual(fixed[1][0], 1.0)
        for start, end in fixed:
            self.assertGreaterEqual(end - start, align.MIN_WORD_DUR - 1e-9)
        for prev, cur in zip(fixed, fixed[1:]):
            self.assertGreaterEqual(cur[0], prev[1])


class MergeTest(unittest.TestCase):
    def units(self, *specs) -> list[DisplayWord]:
        return merge_morphemes(chain(*specs))

    def surfaces(self, *specs) -> list[str]:
        return [w.surface for w in self.units(*specs)]

    def test_r1_prefix_plus_content(self):
        self.assertEqual(self.surfaces(("お", "prefix"), ("疲れ", "noun")), ["お疲れ"])
        # 中心语在后: お疲れ 是名词, 不是前缀
        self.assertEqual(self.units(("お", "prefix"), ("疲れ", "noun"))[0].pos, "noun")

    def test_r2_compound_noun(self):
        self.assertEqual(
            self.surfaces(("4", "num"), ("回", "noun"), ("目", "suffix")), ["4回目"])

    def test_r2_skips_verbal_suffix(self):
        """動詞的接尾辞 (``がる``) 不该粘到名詞上."""
        got = self.surfaces(("寒", "noun"), ("がる", "suffix", {"detail": "接尾辞-動詞的"}))
        self.assertEqual(got, ["寒", "がる"])

    def test_r3_aux_chain_is_capped(self):
        long_chain = self.surfaces(
            ("し", "verb"), ("て", "aux"), ("い", "aux"), ("まし", "aux"), ("た", "aux"))
        self.assertEqual(len(long_chain), 2)
        self.assertEqual(long_chain[0], "していまし")

    def test_r4_conjunctive_particle(self):
        got = self.surfaces(
            ("覆われ", "verb"), ("て", "particle", {"detail": "助詞-接続助詞"}))
        self.assertEqual(got, ["覆われて"])

    def test_r4_only_for_te_de(self):
        """``けど``/``から`` 是独立的语法标记, 不合并."""
        got = self.surfaces(
            ("行く", "verb"), ("けど", "particle", {"detail": "助詞-接続助詞"}))
        self.assertEqual(got, ["行く", "けど"])

    def test_r5_glue_chars_cannot_start_a_word(self):
        got = self.units(("り", "aux"), ("ゃ", "interj"), ("ー", "punct"))
        self.assertEqual([w.surface for w in got], ["りゃー"])
        self.assertEqual(got[0].pos, "aux")          # 词性取头部, 不会变成标点
        self.assertEqual(got[0].romaji, "ryaa")      # 罗马音按合并后的整串重算

    def test_punctuation_never_merges(self):
        self.assertEqual(
            self.surfaces(("今日", "noun"), ("。", "punct"), ("は", "particle")),
            ["今日", "。", "は"])

    def test_non_adjacent_morphemes_never_merge(self):
        gapped = [mk("お", "prefix", start=0), mk("疲れ", "noun", start=2)]  # 中间有空格
        self.assertEqual([w.surface for w in merge_morphemes(gapped)], ["お", "疲れ"])

    def test_merge_can_be_disabled(self):
        raw = chain(("お", "prefix"), ("疲れ", "noun"))
        self.assertEqual([w.surface for w in merge_morphemes(raw, enabled=False)],
                         ["お", "疲れ"])

    def test_merged_word_recomputes_reading_and_time(self):
        ms = chain(("思っ", "verb", {"kana_": "オモッ", "pron": "オモッ"}),
                   ("て", "aux", {"kana_": "テ", "pron": "テ"}))
        ms[0].start, ms[0].end = 1.0, 1.4
        ms[1].start, ms[1].end = 1.4, 1.6
        word = merge_morphemes(ms)[0]
        self.assertEqual(word.surface, "思って")
        self.assertEqual(word.romaji, "omotte")      # 跨形态素的促音
        self.assertEqual(word.furigana, "おもって")
        self.assertAlmostEqual(word.start, 1.0)
        self.assertAlmostEqual(word.end, 1.6)
        self.assertEqual([p.surface for p in word.parts], ["思っ", "て"])

    def test_pron_drives_romaji_not_spelling(self):
        """助词 は 读作 wa: 罗马音必须用発音形, 注音仍用仮名形."""
        word = merge_morphemes([mk("は", "particle", kana_="ハ", pron="ワ")])[0]
        self.assertEqual(word.romaji, "wa")
        self.assertEqual(word.kana, "ハ")


@needs_mecab
class TokenizerTest(unittest.TestCase):
    """真跑一次 MeCab: 上面的用例都用手搓形态素, 这里守住字典接线是否正确."""

    @classmethod
    def setUpClass(cls):
        from pipeline.tokenizer import JapaneseTokenizer
        cls.tk = JapaneseTokenizer()

    def test_empty_text(self):
        self.assertEqual(self.tk.tokenize(""), [])

    def test_char_offsets_reconstruct_the_text(self):
        """时间戳对齐完全依赖 char 区间, 它必须能无损拼回原文."""
        text = "今日はいい天気ですね。"
        ms = self.tk.tokenize(text)
        self.assertEqual("".join(m.surface for m in ms), text)
        for m in ms:
            self.assertEqual(text[m.char_start:m.char_end], m.surface)
        for prev, cur in zip(ms, ms[1:]):
            self.assertLessEqual(prev.char_end, cur.char_start)

    def test_topic_particle_reads_as_wa(self):
        got = {m.surface: m for m in self.tk.tokenize("今日は寒い")}
        self.assertEqual(got["は"].kana, "ハ")     # 仮名形 (注音)
        self.assertEqual(got["は"].pron, "ワ")     # 発音形 (罗马音)
        self.assertEqual(got["は"].romaji, "wa")

    def test_furigana_only_on_kanji_and_pos_is_tagged(self):
        got = {m.surface: m for m in self.tk.tokenize("今日はある")}
        self.assertEqual(got["今日"].furigana, "きょう")
        self.assertEqual(got["今日"].pos, "noun")
        self.assertEqual(got["ある"].furigana, "")  # 纯假名不注音
        self.assertEqual(got["は"].pos, "particle")

    def test_punctuation_has_no_romaji(self):
        last = self.tk.tokenize("そうだね。")[-1]
        self.assertEqual(last.surface, "。")
        self.assertEqual(last.pos, "punct")
        self.assertEqual(last.romaji, "")


# ---------------------------------------------------------------- 韩语罗马字


class HangulTest(unittest.TestCase):
    """转写按「读音」而不是「字形」, 所以音变规则才是真正要守的部分."""

    def test_plain_syllables(self):
        self.assertEqual(hangul.romanize("안녕"), "annyeong")
        self.assertEqual(hangul.romanize("서울"), "seoul")
        self.assertEqual(hangul.romanize("내일"), "naeil")

    def test_liaison_moves_coda_to_the_next_syllable(self):
        self.assertEqual(hangul.romanize("한국어"), "hangugeo")
        self.assertEqual(hangul.romanize("집에"), "jibe")
        self.assertEqual(hangul.romanize("앞에서"), "apeseo")

    def test_nasalization(self):
        self.assertEqual(hangul.romanize("한국말"), "hangungmal")
        self.assertEqual(hangul.romanize("좋네요"), "jonneyo")

    def test_liquid_assimilation(self):
        self.assertEqual(hangul.romanize("설날"), "seollal")
        self.assertEqual(hangul.romanize("종로"), "jongno")

    def test_aspiration(self):
        self.assertEqual(hangul.romanize("좋고"), "joko")
        self.assertEqual(hangul.romanize("생각했어요"), "saenggakaesseoyo")

    def test_palatalization(self):
        self.assertEqual(hangul.romanize("같이"), "gachi")

    def test_non_hangul_passes_through(self):
        self.assertEqual(hangul.romanize("7시"), "7si")
        self.assertEqual(hangul.romanize("?"), "?")
        self.assertEqual(hangul.romanize(""), "")

    def test_is_hangul(self):
        self.assertTrue(hangul.is_hangul("네"))
        self.assertFalse(hangul.is_hangul("abc 123"))


# ---------------------------------------------------------------- 注音 (read 层)


class ArpabetTest(unittest.TestCase):
    """ARPAbet → IPA: 纯查表, 不碰任何可选依赖, 所以这一组在哪儿都会跑."""

    #: CMUdict 的音素表. 这份清单**独立**写在测试里 —— phon 那张表漏一个音素,
    #: 或者两个音素抄成了同一个 IPA, 都得在这儿露出来。
    VOWELS = "AA AE AH AO AW AY EH ER EY IH IY OW OY UH UW".split()
    CONSONANTS = ("B CH D DH F G HH JH K L M N NG P R S SH T TH V W Y Z ZH").split()

    def test_all_39_phonemes_map_to_distinct_ipa(self):
        phones = self.VOWELS + self.CONSONANTS
        self.assertEqual(len(phones), 39)
        ipa = [phon.arpabet_to_ipa([p]) for p in phones]
        missing = [p for p, s in zip(phones, ipa) if not s]
        self.assertFalse(missing, f"没映射的音素: {missing}")
        self.assertEqual(len(set(ipa)), 39, "有两个音素映射到了同一个 IPA")

    def test_stress_mark_sits_before_the_stressed_vowel(self):
        self.assertEqual(phon.arpabet_to_ipa(["K", "AE1", "T"]), "kˈæt")
        self.assertEqual(
            phon.arpabet_to_ipa("IH1 N T R AH0 S T IH0 NG".split()), "ˈɪntɹəstɪŋ")
        self.assertEqual(phon.arpabet_to_ipa("F AH0 T AA1 G R AH0 F IY0".split()),
                         "fətˈɑɡɹəfi")
        self.assertEqual(phon.arpabet_to_ipa(["F", "OW2", "T"]), "fˌoʊt")   # 次重音

    def test_unstressed_ah_and_er_reduce(self):
        self.assertEqual(phon.arpabet_to_ipa("AH0 B AW1 T".split()), "əbˈaʊt")
        self.assertEqual(phon.arpabet_to_ipa("B EH1 T ER0".split()), "bˈɛtɚ")
        #  带重音时仍读本音, 不能一律弱化
        self.assertEqual(phon.arpabet_to_ipa("B AH1 T".split()), "bˈʌt")
        self.assertEqual(phon.arpabet_to_ipa("B ER1 D".split()), "bˈɝd")

    def test_word_gaps_kept_and_unknown_tokens_dropped(self):
        #  g2p-en 会把缩写展开成多个词, 词之间给一个空格 token —— 那个空格要留
        self.assertEqual(
            phon.arpabet_to_ipa(["M", "IH1", "S", "T", "ER0", " ",
                                 "S", "M", "IH1", "TH"]), "mˈɪstɚ smˈɪθ")
        self.assertEqual(phon.arpabet_to_ipa(["K", "AE1", "T", ",", "?", ""]), "kˈæt")
        self.assertEqual(phon.arpabet_to_ipa([]), "")
        self.assertEqual(phon.arpabet_to_ipa([",", " ", "!"]), "")

    def test_phone_case_does_not_matter(self):
        self.assertEqual(phon.arpabet_to_ipa(["k", "ae1", "t"]), "kˈæt")


class PhonBackendTest(unittest.TestCase):
    """三条后端各自的产出. 只要注音后端本身, 不加载 spaCy 模型 —— 比端到端快得多."""

    def test_routing_defaults_to_espeak(self):
        self.assertEqual(phon.backend_of("en"), "g2p-en")
        self.assertEqual(phon.backend_of("ko"), "hangulpy")
        for code in ("es", "fr", "de", "pt"):    # 没单独列出来的一律走 eSpeak
            self.assertEqual(phon.backend_of(code), phon.ESPEAK)

    def test_missing_backend_degrades_to_none(self):
        """eSpeak 里没有 ``qqq`` 这门语言 —— 注音是可选层, 只能安静地退化."""
        self.assertIsNone(phon.provider("qqq"))
        self.assertFalse(phon.readiness("qqq")[0])

    def test_shell_guards_punctuation_memoizes_and_never_raises(self):
        """三条后端共用的外壳; 拿假后端验, 不需要装任何东西."""
        asked: list[str] = []

        class Fake(phon._Backend):               # noqa: SLF001 - 就是要测这层外壳
            name = "fake"

            def _read(self, text: str) -> str:
                asked.append(text)
                if text == "boom":
                    raise RuntimeError("坏了")
                return text if text == "same" else text.upper()

        read = Fake()
        self.assertEqual(read("abc"), "ABC")
        self.assertEqual(read("  abc  "), "ABC")     # 先 strip, 再吃缓存
        self.assertEqual(asked, ["abc"])
        self.assertEqual(read("same"), "")           # 注音与表层相同 -> 不占一层
        self.assertEqual(read("……"), "")             # 纯标点根本不问后端
        self.assertEqual(read(""), "")
        self.assertEqual(read("boom"), "")           # 一个词出岔子不该毁掉整篇
        self.assertNotIn("……", asked)

    @needs_read("en")
    def test_english_is_ipa(self):
        read = phon.provider("en")
        self.assertEqual(read("cat"), "kˈæt")
        self.assertEqual(read("about"), "əbˈaʊt")
        self.assertEqual(read("photography"), "fətˈɑɡɹəfi")
        #  连字符得拆成两个词: 整串当未登录词会读成 wɛlkɔnɚ
        self.assertEqual(read("well-known"), "wˈɛl nˈoʊn")
        #  撇号**不能**拆 —— CMUdict 自己认得 isn't
        self.assertEqual(read("isn't"), "ˈɪzənt")
        #  数字先展开成词, 再由 _fold 把 twenty-six 的连字符换成空格
        self.assertEqual(read("2026"), "twˈɛnti twˈɛnti sˈɪks")
        #  变音符剥掉才查得到 (原样进去会读成 kˈæfi)
        self.assertEqual(read("café"), "kəfˈeɪ")
        self.assertEqual(read("."), "")

    @needs_read("ko")
    def test_korean_is_standard_pronunciation(self):
        read = phon.provider("ko")
        self.assertEqual(read("한국어"), "한구거")      # 连音
        self.assertEqual(read("집에"), "지베")
        self.assertEqual(read("읽어요"), "일거요")
        self.assertEqual(read("좋네요"), "존네요")      # 鼻音化
        self.assertEqual(read("설날"), "설랄")          # 流音化
        self.assertEqual(read("같이"), "가치")          # 口盖音化
        #  和罗马字层是一套音变、两种写法
        self.assertEqual(hangul.romanize("집에"), "jibe")
        #  没有音变的词读音就是字形本身, 不占一层
        self.assertEqual(read("안녕하세요"), "")
        self.assertEqual(read("네"), "")

    @needs_read("es")
    def test_spanish_is_ipa(self):
        read = phon.provider("es")
        self.assertEqual(read("mundo"), "mˈundo")
        self.assertEqual(read("señor"), "seɲˈoɾ")

    @needs_read("fr")
    def test_french_liaison_hyphen_is_stripped(self):
        read = phon.provider("fr")
        #  eSpeak 给「要和下一个词连读」的虚词补一个尾巴 (la → lˈa-): 逐词显示时
        #  那个连字符只是噪音, 首尾都得削掉。
        for word in ("la", "le", "de", "je", "et"):
            got = read(word)
            self.assertTrue(got, f"{word} 没注音")
            self.assertEqual(got, got.strip(" -‐‑‒–—"), f"{word} -> {got!r} 带连读记号")
        self.assertEqual(read("bonsoir"), "bɔ̃swˈaʁ")

    @needs_read("de")
    def test_german_is_ipa(self):
        read = phon.provider("de")
        self.assertEqual(read("Guten"), "ɡˈuːtən")
        self.assertEqual(read("Haus"), "hˈaʊs")


# ---------------------------------------------------------------- UPOS 映射


class UposTest(unittest.TestCase):
    def test_upos_is_mapped_to_compact_tags(self):
        for upos, tag in (("NOUN", "noun"), ("PROPN", "propn"), ("AUX", "aux"),
                          ("DET", "det"), ("ADP", "prep"), ("SCONJ", "conj"),
                          ("PUNCT", "punct"), ("SPACE", "punct"), ("X", "other")):
            with self.subTest(upos=upos):
                self.assertEqual(pos.classify_upos(upos), tag)

    def test_unknown_upos_falls_back_to_xpos(self):
        self.assertEqual(pos.classify_upos("", "NNG"), "noun")     # 韩语 세종 标签
        self.assertEqual(pos.classify_upos("WAT", ""), "other")

    def test_korean_xpos_prefix_fallback(self):
        self.assertEqual(pos.classify_xpos("JKS"), "particle")
        self.assertEqual(pos.classify_xpos("VV"), "verb")
        self.assertEqual(pos.classify_xpos("EFQQ"), "aux")         # 认前缀 E
        self.assertEqual(pos.classify_xpos("???"), "other")

    def test_legend_for_only_lists_used_tags(self):
        legend = pos.legend_for({"noun", "verb"})
        self.assertIn("noun", legend)
        self.assertIn("verb", legend)
        self.assertIn("punct", legend)       # 标点与 other 永远保留
        self.assertNotIn("adnom", legend)


# ---------------------------------------------------------------- 拉丁语切句


class LatinSplitTest(unittest.TestCase):
    """空白分词的语言里, 句末标点后必须跟空白 —— 否则缩写和小数会被切碎."""

    def ranges(self, text: str, **kw) -> list[str]:
        """切句结果; 与 ``analyze`` 一致地 strip —— 句间空白不属于任何一句."""
        tl = align.build_char_timeline(text, [], 0.0, float(len(text)) / 8 + 1)
        opts = {"sent_end": ".!?…", "trailing": "\"')]}»”’", "require_space": True}
        opts.update(kw)
        return [text[a:b].strip() for a, b in align.split_ranges(text, tl, **opts)]

    def test_split_on_sentence_end(self):
        self.assertEqual(self.ranges("Good evening. Welcome back home."),
                         ["Good evening.", "Welcome back home."])

    def test_question_and_exclamation(self):
        self.assertEqual(self.ranges("Really? Yes! Of course."),
                         ["Really?", "Yes!", "Of course."])

    def test_abbreviations_do_not_split(self):
        for text in ("Meet Dr. Smith tomorrow.", "See etc. for details.",
                     "Let's meet at 7 p.m. tonight."):
            with self.subTest(text=text):
                self.assertEqual(self.ranges(text), [text])

    def test_numbered_abbreviations_need_a_digit(self):
        """``No. 5`` 是编号所以不断句; 而 ``No.`` 独立成句时必须断开."""
        self.assertEqual(self.ranges("Take bus No. 5 downtown."),
                         ["Take bus No. 5 downtown."])
        self.assertEqual(self.ranges("See p. 12 for details."),
                         ["See p. 12 for details."])
        self.assertEqual(self.ranges("No. I don't think so."),
                         ["No.", "I don't think so."])

    def test_decimals_do_not_split(self):
        self.assertEqual(self.ranges("It costs 3.50 euros."), ["It costs 3.50 euros."])

    def test_initials_do_not_split(self):
        self.assertEqual(self.ranges("J. R. R. Tolkien wrote it."),
                         ["J. R. R. Tolkien wrote it."])

    def test_closing_quote_stays_with_the_sentence(self):
        self.assertEqual(self.ranges('He said "no." Then he left.'),
                         ['He said "no."', "Then he left."])

    def test_one_letter_word_can_end_a_sentence(self):
        """法语 ``il y a.`` 结尾是单个小写字母 —— 不能当成缩写吞掉."""
        self.assertEqual(self.ranges("Il y en a. C'est tout."),
                         ["Il y en a.", "C'est tout."])

    def test_no_space_after_period_is_not_a_boundary(self):
        """``file.txt`` / URL 里的点不是句号."""
        self.assertEqual(self.ranges("Open file.txt now."), ["Open file.txt now."])

    def test_cjk_does_not_require_space(self):
        text = "こんばんは。おかえりなさい。"
        tl = align.build_char_timeline(text, [], 0.0, 4.0)
        got = [text[a:b] for a, b in align.split_ranges(text, tl, require_space=False)]
        self.assertEqual(got, ["こんばんは。", "おかえりなさい。"])


# ---------------------------------------------------------------- 语言注册表


class RegistryTest(unittest.TestCase):
    def test_six_languages_are_registered(self):
        self.assertEqual(langs.codes(), ["ja", "en", "es", "fr", "de", "ko"])

    def test_aliases_and_region_tags_resolve(self):
        for raw, code in (("ja", "ja"), ("jpn", "ja"), ("Japanese", "ja"),
                          ("ja-JP", "ja"), ("en_US", "en"), ("ko-KR", "ko"),
                          ("Español", None), ("es-419", "es"), ("", None),
                          ("klingon", None)):
            with self.subTest(raw=raw):
                spec = langs.resolve(raw)
                self.assertEqual(spec.code if spec else None, code)

    def test_need_raises_for_unknown(self):
        with self.assertRaises(ValueError):
            langs.need("tlh")

    def test_features_follow_the_layers(self):
        ja = langs.need("ja")
        self.assertEqual(ja.features, ("read", "roman", "tr", "pos", "card"))
        en = langs.need("en")
        self.assertEqual(en.features, ("read", "roman", "tr", "pos", "card"))

    def test_every_language_declares_both_layers(self):
        """六门语言都有上下两层了, 只是各层放的东西不同 (见 phon.py)."""
        for code in langs.codes():
            with self.subTest(code=code):
                layer_map = langs.need(code).layer_map
                self.assertEqual(list(layer_map), ["read", "roman"])
                self.assertTrue(all(layer_map.values()))    # 标签不能为空

    def test_json_block_is_self_describing(self):
        block = langs.need("ko").json(ready=True, detail="ko_core_news_sm")
        self.assertEqual(block["code"], "ko")
        self.assertEqual(block["script"], "hangul")
        self.assertEqual(block["layerOrder"], ["read", "roman"])
        self.assertEqual(block["layers"]["read"], "发音")
        self.assertEqual(block["layers"]["roman"], "罗马字")
        self.assertTrue(block["spaceDelimited"])
        self.assertTrue(block["ready"])

    def test_catalog_covers_every_language(self):
        catalog = langs.catalog(probe=False)
        self.assertEqual([e["code"] for e in catalog], langs.codes())
        self.assertTrue(all("ready" not in e for e in catalog))

    def test_analyzer_instances_are_cached(self):
        spec = langs.need("ja") if HAS_MECAB else None
        if spec is None:
            self.skipTest("需要至少一门可用的语言")
        self.assertIs(langs.analyzer(spec), langs.analyzer(spec))


class HeadOfTest(unittest.TestCase):
    """合并单元的中心语只由词性权重决定, 不写语言特例."""

    def test_content_word_wins_over_function_word(self):
        parts = [Part("l'", "det"), Part("homme", "noun")]
        self.assertEqual(head_of(parts).text, "homme")

    def test_ties_prefer_the_earlier_part(self):
        parts = [Part("did", "aux"), Part("n't", "particle")]
        self.assertEqual(head_of(parts).text, "did")

    def test_adverb_loses_to_participle(self):
        parts = [Part("well", "adv"), Part("-", "punct"), Part("known", "verb")]
        self.assertEqual(head_of(parts).text, "known")

    def test_empty_is_safe(self):
        self.assertEqual(head_of([]).text, "")


# ---------------------------------------------------------------- 端到端分析

JA_WORD_JSON = {
    "language": "ja",
    "segments": [
        {
            "start": 0.0, "end": 2.4, "text": "こんばんは。おかえりなさい。",
            "words": [
                {"word": "こんばんは", "start": 0.0, "end": 1.0},
                {"word": "おかえりなさい", "start": 1.3, "end": 2.4},
            ],
        },
        {
            "start": 3.0, "end": 4.6, "text": "今日は寒かったね。",
            "words": [
                {"word": "今日", "start": 3.0, "end": 3.4},
                {"word": "は", "start": 3.4, "end": 3.6},
                {"word": "寒かった", "start": 3.6, "end": 4.3},
                {"word": "ね", "start": 4.3, "end": 4.6},
            ],
        },
    ],
}

EN_SRT = (
    "1\n00:00:00,000 --> 00:00:02,000\nGood evening. Welcome back home.\n\n"
    "2\n00:00:02,400 --> 00:00:05,000\nIt isn't a well-known place.\n"
)


def run(payload, lang: str = "", name: str = "t.json", **kw) -> dict:
    """跑一次完整分析; ``payload`` 是 dict (JSON) 或 str (SRT/VTT)."""
    raw = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    opts = AnalyzeOptions(language=lang, track_id="unit", title="单元测试", **kw)
    return analyze(raw, name, opts, log=lambda *_: None)


class ContractTest(unittest.TestCase):
    """与前端的契约里与语言无关的那部分 —— 任何环境都该跑."""

    def test_unknown_language_raises(self):
        with self.assertRaises(ValueError):
            run(JA_WORD_JSON, lang="tlh")

    def test_broken_input_raises(self):
        with self.assertRaises(InputError):
            run("not a subtitle at all", name="t.srt")


@needs_mecab
class AnalyzeJapaneseTest(unittest.TestCase):
    """端到端跑一遍管道, 校验 schemaVersion 2 的自描述契约."""

    @classmethod
    def setUpClass(cls):
        cls.track = run(JA_WORD_JSON, lang="ja")

    def test_meta_and_lang_block(self):
        t = self.track
        self.assertEqual(t["schemaVersion"], SCHEMA_VERSION)
        self.assertEqual(t["id"], "unit")
        self.assertEqual(t["title"], "单元测试")
        self.assertEqual(t["lang"]["code"], "ja")
        self.assertEqual(t["lang"]["engine"], "mecab")
        self.assertFalse(t["lang"]["spaceDelimited"])
        self.assertEqual(t["lang"]["layerOrder"], ["read", "roman"])
        self.assertTrue(t["hasWordTiming"])
        self.assertEqual(t["stats"]["sentences"], len(t["sentences"]))
        self.assertIn("lingua-pipeline", t["generator"])

    def test_backend_stores_nothing_and_never_translates(self):
        self.assertNotIn("translation", self.track["sentences"][0])
        self.assertNotIn("path", self.track)
        self.assertEqual(self.track["audio"]["src"], "")

    def test_sentences_are_split_and_ordered(self):
        sents = self.track["sentences"]
        self.assertGreaterEqual(len(sents), 3)      # 第一段按句点切成两句
        self.assertEqual([s["i"] for s in sents], list(range(len(sents))))
        for prev, cur in zip(sents, sents[1:]):
            self.assertGreaterEqual(cur["start"], prev["start"])
        for s in sents:
            self.assertGreater(s["end"], s["start"])
            # 日语没有词间空白, 所以单词能无损拼回句子
            self.assertEqual("".join(w["text"] for w in s["words"]), s["text"])

    def test_word_timing_is_monotonic_inside_the_sentence(self):
        for s in self.track["sentences"]:
            self.assertTrue(s["wordTiming"])
            self.assertAlmostEqual(s["words"][0]["start"], s["start"], places=3)
            self.assertAlmostEqual(s["words"][-1]["end"], s["end"], places=3)
            for prev, cur in zip(s["words"], s["words"][1:]):
                self.assertGreaterEqual(cur["start"], prev["end"] - 1e-6)

    def test_words_carry_layers_and_pos(self):
        words = [w for s in self.track["sentences"] for w in s["words"]]
        kanji = next(w for w in words if w["text"] == "今日")
        self.assertEqual(kanji["read"], "きょう")
        self.assertEqual(kanji["roman"], "kyou")
        self.assertEqual(kanji["pos"], "noun")
        for w in words:
            self.assertIn(w["pos"], self.track["posLegend"])
        merged = [w for w in words if "parts" in w]
        self.assertTrue(merged)
        for w in merged:
            self.assertEqual("".join(p["text"] for p in w["parts"]), w["text"])

    def test_estimate_flag_is_a_no_op_when_timing_exists(self):
        with_estimate = run(JA_WORD_JSON, lang="ja", estimate_word_timing=True)
        self.assertEqual(with_estimate["stats"], self.track["stats"])

    def test_duration_defaults_to_the_last_sentence(self):
        self.assertAlmostEqual(self.track["audio"]["duration"],
                               self.track["sentences"][-1]["end"], places=3)
        fixed = run(JA_WORD_JSON, lang="ja", duration=99.0)
        self.assertEqual(fixed["audio"]["duration"], 99.0)


@needs_lang("en")
class AnalyzeEnglishTest(unittest.TestCase):
    """空白分词语言的两处差异: 单词拼不回句子, 以及 roman 层放的是原形."""

    @classmethod
    def setUpClass(cls):
        cls.track = run(EN_SRT, lang="en", name="t.srt")

    def words(self) -> list[dict]:
        return [w for s in self.track["sentences"] for w in s["words"]]

    def test_lang_block(self):
        block = self.track["lang"]
        self.assertEqual(block["engine"], "spacy")
        self.assertTrue(block["spaceDelimited"])
        self.assertEqual(block["layerOrder"], ["read", "roman"])
        self.assertEqual(block["layers"]["read"], "音标")

    def test_sentence_split_by_punctuation(self):
        texts = [s["text"] for s in self.track["sentences"]]
        self.assertIn("Good evening.", texts)
        self.assertIn("Welcome back home.", texts)

    def test_words_are_a_subsequence_of_the_sentence(self):
        """有空白的语言拼不回原句, 但每个词都得能在句子里按序找到."""
        for s in self.track["sentences"]:
            at = 0
            for w in s["words"]:
                at = s["text"].find(w["text"], at)
                self.assertGreaterEqual(at, 0, f"{w['text']!r} 不在 {s['text']!r} 里")
                at += len(w["text"])

    def test_roman_layer_holds_the_lemma_only_when_it_differs(self):
        words = {w["text"]: w for w in self.words()}
        self.assertEqual(words["isn't"]["roman"], "be")
        self.assertEqual(words["isn't"]["lemma"], "be")
        self.assertNotIn("roman", words["place"])       # 原形与词形相同就不占一层

    @needs_read("en")
    def test_read_layer_holds_ipa(self):
        words = {w["text"]: w for w in self.words()}
        self.assertEqual(words["Good"]["read"], "ɡˈʊd")
        self.assertEqual(words["evening"]["read"], "ˈivnɪŋ")
        self.assertNotIn("read", words["."])            # 标点不注音

    @needs_read("en")
    def test_merged_units_recompute_read_over_the_whole_surface(self):
        """拼接各成分的音标是错的 —— ``isn't`` 不是 ``ˈɪz`` + ``ˈɛntˈaɪ``."""
        merged = {w["text"]: w for w in self.words() if "parts" in w}
        self.assertEqual(merged["isn't"]["read"], "ˈɪzənt")
        self.assertEqual(merged["well-known"]["read"], "wˈɛl nˈoʊn")
        #  带撇号的附着成分单独拿出来不成词, 它自己那层要空着
        parts = {p["text"]: p for p in merged["isn't"]["parts"]}
        self.assertNotIn("read", parts["n't"])
        #  连字符复合词的两半拼写完整, 各自的音标是对的, 留着
        self.assertEqual({p["text"]: p.get("read", "")
                          for p in merged["well-known"]["parts"]},
                         {"well": "wˈɛl", "-": "", "known": "nˈoʊn"})

    def test_contractions_and_hyphens_are_merged(self):
        surfaces = [w["text"] for w in self.words()]
        self.assertIn("isn't", surfaces)
        self.assertIn("well-known", surfaces)
        merged = {w["text"]: w for w in self.words() if "parts" in w}
        self.assertEqual([p["text"] for p in merged["isn't"]["parts"]], ["is", "n't"])
        # 中心语决定合并单元的词性: well-known 是形容词/分词, 不是副词
        self.assertNotEqual(merged["well-known"]["pos"], "adv")

    def test_merge_can_be_disabled(self):
        raw = run(EN_SRT, lang="en", name="t.srt", merge_words=False)
        surfaces = [w["text"] for s in raw["sentences"] for w in s["words"]]
        self.assertNotIn("isn't", surfaces)
        self.assertIn("n't", surfaces)

    def test_sentence_level_input_has_no_word_times(self):
        self.assertFalse(self.track["hasWordTiming"])
        for s in self.track["sentences"]:
            for w in s["words"]:
                self.assertNotIn("start", w)

    def test_estimated_word_times_cover_the_sentence(self):
        est = run(EN_SRT, lang="en", name="t.srt", estimate_word_timing=True)
        self.assertTrue(est["hasWordTiming"])
        for s in est["sentences"]:
            self.assertTrue(s["wordTiming"])
            self.assertAlmostEqual(s["words"][0]["start"], s["start"], places=3)
            self.assertAlmostEqual(s["words"][-1]["end"], s["end"], places=3)
            for prev, cur in zip(s["words"], s["words"][1:]):
                self.assertGreaterEqual(cur["start"], prev["end"] - 1e-6)


@needs_lang("ko")
class AnalyzeKoreanTest(unittest.TestCase):
    """韩语: spaCy 给的是 ``+`` 拼起来的语素串, 要拆成 parts 并各自转写."""

    @classmethod
    def setUpClass(cls):
        cls.track = run(
            {"language": "ko", "segments": [{"start": 0.0, "end": 3.0,
             "text": "안녕하세요. 집에 잘 오셨어요."}]}, lang="ko", name="t.json")

    def test_roman_layer_is_revised_romanization(self):
        words = {w["text"]: w for s in self.track["sentences"] for w in s["words"]}
        self.assertEqual(words["집에"]["roman"], "jibe")
        self.assertEqual(words["안녕하세요"]["roman"], "annyeonghaseyo")

    @needs_read("ko")
    def test_read_layer_is_the_standard_pronunciation_in_hangul(self):
        """上层写读音的谚文, 下层写同一套音变的罗马字 —— 对着看正好."""
        words = {w["text"]: w for s in self.track["sentences"] for w in s["words"]}
        self.assertEqual(words["집에"]["read"], "지베")
        self.assertEqual(words["오셨어요"]["read"], "오셔써요")
        #  没有音变的词读音就是字形本身: 不下发这一层 (和日语「纯假名词不注音」同一条规矩)
        self.assertNotIn("read", words["안녕하세요"])
        self.assertNotIn("read", words["."])

    def test_lang_block_says_hangul(self):
        self.assertEqual(self.track["lang"]["script"], "hangul")
        self.assertEqual(self.track["lang"]["layers"],
                         {"read": "发音", "roman": "罗马字"})

    def test_morpheme_parts_are_exposed(self):
        multi = [w for s in self.track["sentences"] for w in s["words"] if "parts" in w]
        self.assertTrue(multi)
        for w in multi:
            self.assertTrue(all(p["text"] for p in w["parts"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
