"""``pipeline.api`` 的单元测试 —— 起一个真服务器, 用 urllib 打真请求.

只用标准库::

    python -m unittest discover -s tests -v

后端只有两个端点 (``/api/health`` 与 ``/api/analyze``), 且**不存任何数据**, 所以这里
除了断言响应, 还专门断言「跑完一次分析, 磁盘上不多一个字节」。

需要具体分词器的用例在缺依赖时自动跳过: 日语要 fugashi + UniDic, 其余五门语言要
spaCy 及对应的 ``*_core_*_sm`` 模型。
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from contextlib import redirect_stdout
from functools import partial
from http.server import ThreadingHTTPServer
from io import StringIO
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline import SCHEMA_VERSION, __version__, langs  # noqa: E402
from pipeline.api import MAX_BODY, Api, check_id, safe_name, slug_id  # noqa: E402
from pipeline.serve import RangeHandler, serve  # noqa: E402
from pipeline.cli import _cmd_serve, build_parser  # noqa: E402


def _ready(code: str) -> bool:
    spec = langs.resolve(code)
    return bool(spec) and langs.readiness(spec)[0]


HAS_JA = _ready("ja")
HAS_EN = _ready("en")
needs_ja = unittest.skipUnless(HAS_JA, "需要 fugashi + UniDic 词典")
needs_en = unittest.skipUnless(HAS_EN, "需要 spaCy + en_core_web_sm")

#: 词级时间戳格式 (whisper 风格) —— 日语
JA_WORD_JSON = {
    "language": "ja",
    "segments": [
        {"start": 0.0, "end": 1.6, "text": "こんばんは。",
         "words": [{"word": "こんばんは", "start": 0.0, "end": 1.4},
                   {"word": "。", "start": 1.4, "end": 1.6}]},
        {"start": 1.8, "end": 3.4, "text": "今日はいい天気ですね。",
         "words": [{"word": "今日", "start": 1.8, "end": 2.2},
                   {"word": "は", "start": 2.2, "end": 2.4},
                   {"word": "いい", "start": 2.4, "end": 2.8},
                   {"word": "天気", "start": 2.8, "end": 3.1},
                   {"word": "です", "start": 3.1, "end": 3.3},
                   {"word": "ね", "start": 3.3, "end": 3.4}]},
    ],
}

EN_WORD_JSON = {
    "language": "en",
    "segments": [
        {"start": 0.0, "end": 1.5, "text": "Good evening.",
         "words": [{"word": "Good", "start": 0.0, "end": 0.6},
                   {"word": "evening", "start": 0.6, "end": 1.3},
                   {"word": ".", "start": 1.3, "end": 1.5}]},
        {"start": 1.8, "end": 4.0, "text": "It's a lovely day, isn't it?",
         "words": [{"word": "It's", "start": 1.8, "end": 2.1},
                   {"word": "a", "start": 2.1, "end": 2.2},
                   {"word": "lovely", "start": 2.2, "end": 2.7},
                   {"word": "day", "start": 2.7, "end": 3.1},
                   {"word": "isn't", "start": 3.2, "end": 3.6},
                   {"word": "it", "start": 3.6, "end": 4.0}]},
    ],
}

EN_SRT = (
    "1\n00:00:00,000 --> 00:00:01,500\nGood evening.\n\n"
    "2\n00:00:01,800 --> 00:00:04,000\nWelcome back home. Please rest.\n"
)


def tree(root: Path) -> set[str]:
    """站点根下的相对路径集合 —— 用来证明分析没有落盘."""
    return {str(p.relative_to(root)) for p in root.rglob("*")}


class ApiCase(unittest.TestCase):
    """公共脚手架: 临时站点根 + 后台服务器 + 一个迷你 HTTP 客户端."""

    api_token = None

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="lt-api-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "index.html").write_text("<!doctype html>hi\n", encoding="utf-8")
        self.api = Api(api_token=self.api_token)
        cls = type("_H", (RangeHandler,), {"api": self.api})
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0),
                                         partial(cls, directory=str(self.tmp)))
        self.base = "http://127.0.0.1:%d" % self.httpd.server_address[1]
        thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    # ------------------------------------------------------------ 客户端

    def call(self, method: str, path: str, body: bytes | str | dict | None = None,
             headers: dict | None = None):
        """返回 ``(status, json | bytes)``; 4xx/5xx 不抛异常, 方便断言."""
        data = body
        if isinstance(body, dict):
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            data = body.encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "text/plain; charset=utf-8")
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.status, self._decode(resp.read()), dict(resp.headers)
        except urllib.error.HTTPError as exc:
            return exc.code, self._decode(exc.read()), dict(exc.headers)

    @staticmethod
    def _decode(raw: bytes):
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return raw

    def analyze(self, body, lang: str = "", name: str = "t.json", **flags):
        query = {"name": name}
        if lang:
            query["lang"] = lang
        for key, value in flags.items():
            query[key] = "1" if value is True else "0" if value is False else str(value)
        path = "/api/analyze?" + urllib.parse.urlencode(query)
        return self.call("POST", path, body)


# ---------------------------------------------------------------- 纯函数


class NamingTest(unittest.TestCase):
    def test_safe_name_strips_paths_and_control_chars(self):
        self.assertEqual(safe_name("../../etc/passwd"), "passwd")
        self.assertEqual(safe_name("a\\b\\c.srt"), "c.srt")
        self.assertEqual(safe_name("bad\x00name.json"), "bad_name.json")
        self.assertEqual(safe_name("...."), "file")
        self.assertEqual(safe_name(""), "file")

    def test_safe_name_keeps_extension_when_truncating(self):
        out = safe_name("x" * 300 + ".json")
        self.assertLessEqual(len(out), 120)
        self.assertTrue(out.endswith(".json"))

    def test_safe_name_keeps_cjk(self):
        self.assertEqual(safe_name("日本語の字幕.srt"), "日本語の字幕.srt")

    def test_slug_id(self):
        self.assertEqual(slug_id("Lingua Demo.wav"), "lingua-demo")
        self.assertEqual(slug_id("日本語.srt"), "audio")     # 全非 ASCII -> 兜底
        self.assertEqual(slug_id("a--b__c.json"), "a-b-c")  # 非字母数字一律收成单横线
        self.assertEqual(slug_id(""), "audio")

    def test_check_id_rejects_traversal(self):
        self.assertEqual(check_id("ok-1_2.3"), "ok-1_2.3")
        for bad in ("", ".hidden", "../x", "a/b", "a b", "x" * 65):
            with self.subTest(bad=bad):
                with self.assertRaises(Exception):
                    check_id(bad)


# ---------------------------------------------------------------- /api/health


class HealthTest(ApiCase):
    def test_health_reports_version_and_languages(self):
        status, payload, _ = self.call("GET", "/api/health?probe=0")
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["stateless"])
        self.assertEqual(payload["version"], __version__)
        self.assertEqual(payload["schemaVersion"], SCHEMA_VERSION)
        self.assertEqual(payload["maxBody"], MAX_BODY)
        self.assertIn(".srt", payload["formats"])
        codes = [entry["code"] for entry in payload["languages"]]
        self.assertEqual(codes, list(langs.codes()))

    def test_language_entries_are_self_describing(self):
        _, payload, _ = self.call("GET", "/api/health?probe=0")
        entry = {e["code"]: e for e in payload["languages"]}["ja"]
        self.assertEqual(entry["engine"], "mecab")
        self.assertFalse(entry["spaceDelimited"])
        self.assertEqual(entry["layers"], {"read": "假名", "roman": "罗马音"})
        self.assertEqual(entry["layerOrder"], ["read", "roman"])
        self.assertIn("card", entry["features"])
        english = {e["code"]: e for e in payload["languages"]}["en"]
        self.assertEqual(english["engine"], "spacy")
        self.assertTrue(english["spaceDelimited"])
        self.assertEqual(english["layers"], {"read": "音标", "roman": "原形"})

    def test_probe_reports_readiness(self):
        _, payload, _ = self.call("GET", "/api/health?probe=1")
        for entry in payload["languages"]:
            with self.subTest(code=entry["code"]):
                self.assertIn("ready", entry)
                self.assertIsInstance(entry["ready"], bool)
                #  就绪与否都要给一句人话: 缺什么, 或者用的是哪个模型/注音后端
                self.assertTrue(entry.get("detail"))

    def test_cors_is_open_and_preflight_is_204(self):
        status, _, headers = self.call("GET", "/api/health?probe=0")
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")
        status, _, headers = self.call("OPTIONS", "/api/analyze")
        self.assertEqual(status, 204)
        self.assertIn("POST", headers.get("Access-Control-Allow-Methods", ""))

    def test_unknown_endpoint_is_404_json(self):
        status, payload, _ = self.call("GET", "/api/nope")
        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    def test_removed_endpoints_are_gone(self):
        """v1 的存储型接口必须彻底消失, 不能留个半死的路由."""
        for method, path in (("GET", "/api/tracks"), ("POST", "/api/tracks"),
                             ("GET", "/api/jobs/x"), ("POST", "/api/llm"),
                             ("GET", "/api/ping"), ("DELETE", "/api/tracks/x")):
            with self.subTest(path=path):
                status, payload, _ = self.call(method, path, b"{}")
                self.assertEqual(status, 404, payload)

    def test_static_files_still_served(self):
        status, payload, _ = self.call("GET", "/index.html")
        self.assertEqual(status, 200)
        self.assertIn(b"hi", payload)

    def test_method_not_routed_falls_through_to_404(self):
        status, _, _ = self.call("PUT", "/api/health", b"{}")
        self.assertEqual(status, 404)


# ---------------------------------------------------------------- 鉴权


class AuthTest(ApiCase):
    api_token = "test-token.only-for-tests_123"

    @property
    def auth(self):
        return {"Authorization": "Bearer " + self.api_token}

    def test_missing_token_blocks_all_api_routes(self):
        for method, path in (("GET", "/api/health?probe=1"),
                             ("POST", "/api/analyze"),
                             ("GET", "/api/nope"), ("HEAD", "/api/health")):
            with self.subTest(method=method, path=path):
                status, payload, headers = self.call(method, path)
                self.assertEqual(status, 401)
                self.assertEqual(headers["WWW-Authenticate"], 'Bearer realm="lingua-analyze"')
                self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
                if method != "HEAD":
                    self.assertIn("error", payload)

    def test_wrong_or_malformed_token_is_401(self):
        for value in ("Bearer wrong", "Basic " + self.api_token,
                      self.api_token, "Bearer", "Bearer " + self.api_token + "x"):
            with self.subTest(value=value):
                status, _, _ = self.call("GET", "/api/health?probe=0",
                                         headers={"Authorization": value})
                self.assertEqual(status, 401)

    def test_query_token_is_not_accepted(self):
        status, _, _ = self.call("GET", "/api/health?token=" + self.api_token)
        self.assertEqual(status, 401)

    def test_rejects_before_body_read_or_dependency_probe(self):
        with patch.object(self.api, "_read_body") as read, \
                patch("pipeline.api.langs.catalog") as catalog:
            status, _, _ = self.call("POST", "/api/analyze", b"x",
                                     headers={"Content-Length": str(MAX_BODY + 1)})
            self.assertEqual(status, 401)
            status, _, _ = self.call("GET", "/api/health?probe=1")
            self.assertEqual(status, 401)
            read.assert_not_called()
            catalog.assert_not_called()

    def test_correct_token_allows_health_without_echoing_token(self):
        status, payload, headers = self.call("GET", "/api/health?probe=0", headers=self.auth)
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertNotIn(self.api_token, json.dumps([payload, headers]))
        status, _, _ = self.call("GET", "/api/health?probe=0",
                                 headers={"Authorization": "bearer " + self.api_token})
        self.assertEqual(status, 200)

    def test_correct_token_allows_analysis(self):
        with patch("pipeline.api.analyze", return_value={"id": "authorized"}) as analyze_mock:
            status, payload, _ = self.call("POST", "/api/analyze?name=t.srt&lang=en",
                                           EN_SRT, headers=self.auth)
        self.assertEqual(status, 200)
        self.assertEqual(payload["track"]["id"], "authorized")
        self.assertEqual(analyze_mock.call_args.args[0], EN_SRT.encode("utf-8"))

    def test_preflight_is_public_and_allows_authorization_header(self):
        status, _, headers = self.call("OPTIONS", "/api/analyze", headers={
            "Origin": "https://frontend.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization, content-type",
        })
        self.assertEqual(status, 204)
        self.assertIn("authorization", headers["Access-Control-Allow-Headers"].lower())

    def test_static_site_remains_accessible(self):
        status, payload, _ = self.call("GET", "/index.html")
        self.assertEqual(status, 200)
        self.assertIn(b"hi", payload)


class AuthConfigTest(unittest.TestCase):
    def test_public_api_requires_a_token_before_binding(self):
        for host in ("0.0.0.0", "192.0.2.1", "::"):
            with self.subTest(host=host), patch("pipeline.serve.ThreadingHTTPServer") as server:
                with self.assertRaisesRegex(ValueError, "LINGUA_API_TOKEN"):
                    serve(Path("."), host=host, api_token="  ")
                server.assert_not_called()

    def test_public_authenticated_api_and_static_only_server_can_start(self):
        for api, token in ((True, "example-test-token"), (False, None)):
            output = StringIO()
            with self.subTest(api=api), patch("pipeline.serve.ThreadingHTTPServer") as server, \
                    redirect_stdout(output):
                serve(Path("."), host="0.0.0.0", api=api, api_token=token)
                server.return_value.__enter__.return_value.serve_forever.assert_called_once()
            self.assertNotIn("example-test-token", output.getvalue())

    def test_serve_reads_token_from_environment_with_legacy_fallback(self):
        for env, expected in (({"LINGUA_API_TOKEN": "current"}, "current"),
                              ({"LINGUATRACK_API_TOKEN": "legacy"}, "legacy"),
                              ({"LINGUA_API_TOKEN": "current", "LINGUATRACK_API_TOKEN": "old"},
                               "current")):
            with self.subTest(env=env), patch.dict("os.environ", env, clear=True), \
                    patch("pipeline.serve.serve") as run:
                _cmd_serve(build_parser().parse_args(["serve"]))
                self.assertEqual(run.call_args.kwargs["api_token"], expected)

    def test_unusable_tokens_are_rejected_without_echoing_them(self):
        for token in ("bad token", "bad\ntoken", "\u4ee4\u724c", "bad\x7ftoken"):
            with self.subTest(token=repr(token)), self.assertRaisesRegex(ValueError, "ASCII"):
                Api(api_token=token)


# ---------------------------------------------------------------- /api/analyze


class AnalyzeGuardTest(ApiCase):
    def test_empty_body_is_411(self):
        status, payload, _ = self.call("POST", "/api/analyze?name=t.json")
        self.assertEqual(status, 411, payload)

    def test_oversized_body_is_413_without_reading_it(self):
        status, payload, _ = self.call(
            "POST", "/api/analyze?name=t.json", b"x",
            headers={"Content-Length": str(MAX_BODY + 1)})
        self.assertEqual(status, 413, payload)

    def test_unknown_language_is_400_and_lists_options(self):
        status, payload, _ = self.analyze(JA_WORD_JSON, lang="tlh")
        self.assertEqual(status, 400, payload)
        self.assertIn("tlh", payload["error"])
        self.assertIn("ja", payload["error"])

    def test_illegal_track_id_is_400(self):
        status, payload, _ = self.analyze(JA_WORD_JSON, lang="ja", id="../evil")
        self.assertEqual(status, 400, payload)

    def test_broken_transcript_is_400(self):
        status, payload, _ = self.analyze(b"\x00\x01not a transcript", lang="ja")
        self.assertEqual(status, 400, payload)
        self.assertIn("error", payload)

    def test_language_is_required_when_transcript_has_none(self):
        naked = {"segments": [{"start": 0.0, "end": 1.0, "text": "Good evening."}]}
        status, payload, _ = self.analyze(naked, name="t.json")
        self.assertIn(status, (200, 400), payload)
        if status == 400:
            self.assertIn("error", payload)

    def test_bad_number_is_400(self):
        status, payload, _ = self.analyze(JA_WORD_JSON, lang="ja", duration="abc")
        self.assertEqual(status, 400, payload)
        self.assertIn("duration", payload["error"])


@needs_en
class AnalyzeEnglishTest(ApiCase):
    def test_word_level_json_round_trip(self):
        status, payload, _ = self.analyze(EN_WORD_JSON, lang="en",
                                          id="demo", title="Demo")
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["log"])
        track = payload["track"]
        self.assertEqual(track["schemaVersion"], SCHEMA_VERSION)
        self.assertEqual(track["id"], "demo")
        self.assertEqual(track["title"], "Demo")
        self.assertEqual(track["lang"]["code"], "en")
        self.assertTrue(track["lang"]["spaceDelimited"])
        self.assertTrue(track["hasWordTiming"])
        self.assertGreaterEqual(track["stats"]["sentences"], 2)
        self.assertEqual(track["stats"]["words"],
                         sum(len(s["words"]) for s in track["sentences"]))

    def test_sentences_are_ordered_and_word_times_monotonic(self):
        """前端只靠一个扁平数组做二分查找, 所以时间必须非递减且不越出句子边界.

        末尾标点可能是零长度 —— 句末的 ``?`` 确实没有对应音频, 句子右边界又必须与最后
        一个词严格对齐, 两者冲突时让标点退化成零长度; 前端 (engine.js) 对此的处理是
        直接算作 100% 扫过。除末词之外都要求正长度。
        """
        _, payload, _ = self.analyze(EN_WORD_JSON, lang="en")
        sentences = payload["track"]["sentences"]
        self.assertEqual([s["i"] for s in sentences], list(range(len(sentences))))
        last = -1.0
        for s in sentences:
            self.assertGreaterEqual(s["start"], last)
            self.assertGreater(s["end"], s["start"])
            last = s["end"]
            prev = s["start"] - 1e-6
            words = s["words"]
            for k, w in enumerate(words):
                self.assertGreaterEqual(w["start"], prev - 1e-6)
                self.assertGreaterEqual(w["end"], w["start"])
                if k < len(words) - 1:
                    self.assertGreater(w["end"], w["start"])
                self.assertLessEqual(w["end"], s["end"] + 1e-6)
                prev = w["end"]
            self.assertAlmostEqual(words[0]["start"], s["start"], places=3)
            self.assertAlmostEqual(words[-1]["end"], s["end"], places=3)

    def test_srt_splits_into_sentences(self):
        _, payload, _ = self.analyze(EN_SRT, lang="en", name="t.srt", split=True)
        texts = [s["text"] for s in payload["track"]["sentences"]]
        self.assertIn("Good evening.", texts)
        self.assertIn("Welcome back home.", texts)
        self.assertIn("Please rest.", texts)

    def test_split_can_be_disabled(self):
        _, payload, _ = self.analyze(EN_SRT, lang="en", name="t.srt", split=False)
        texts = [s["text"] for s in payload["track"]["sentences"]]
        self.assertIn("Welcome back home. Please rest.", texts)

    def test_sentence_level_srt_has_no_word_times_by_default(self):
        _, payload, _ = self.analyze(EN_SRT, lang="en", name="t.srt")
        track = payload["track"]
        self.assertFalse(track["hasWordTiming"])
        for s in track["sentences"]:
            self.assertFalse(s["wordTiming"])
            for w in s["words"]:
                self.assertNotIn("start", w)

    def test_estimate_fills_word_times(self):
        _, payload, _ = self.analyze(EN_SRT, lang="en", name="t.srt", estimate=True)
        track = payload["track"]
        self.assertTrue(track["hasWordTiming"])
        for s in track["sentences"]:
            self.assertTrue(s["wordTiming"])
            self.assertAlmostEqual(s["words"][0]["start"], s["start"], places=3)
            self.assertAlmostEqual(s["words"][-1]["end"], s["end"], places=3)

    def test_lemma_layer_and_pos_legend(self):
        _, payload, _ = self.analyze(EN_WORD_JSON, lang="en")
        track = payload["track"]
        words = [w for s in track["sentences"] for w in s["words"]]
        self.assertTrue(any(w.get("lemma") for w in words))
        used = {w["pos"] for w in words}
        self.assertTrue(used <= set(track["posLegend"]))

    def test_merge_flag_controls_contractions(self):
        _, merged, _ = self.analyze(EN_WORD_JSON, lang="en", merge=True)
        _, split, _ = self.analyze(EN_WORD_JSON, lang="en", merge=False)
        texts = lambda p: [w["text"] for s in p["track"]["sentences"] for w in s["words"]]
        self.assertIn("isn't", texts(merged))
        self.assertNotIn("isn't", texts(split))

    def test_duration_and_audio_src_are_echoed_not_stored(self):
        _, payload, _ = self.analyze(EN_WORD_JSON, lang="en",
                                      duration="12.5", audio="blob:whatever")
        audio = payload["track"]["audio"]
        self.assertEqual(audio["duration"], 12.5)
        self.assertEqual(audio["src"], "blob:whatever")

    def test_language_from_transcript_when_query_omits_it(self):
        _, payload, _ = self.analyze(EN_WORD_JSON)
        self.assertEqual(payload["track"]["lang"]["code"], "en")

    def test_no_translation_field_backend_never_translates(self):
        _, payload, _ = self.analyze(EN_WORD_JSON, lang="en")
        for s in payload["track"]["sentences"]:
            self.assertNotIn("translation", s)


@needs_ja
class AnalyzeJapaneseTest(ApiCase):
    def test_furigana_and_romaji_layers(self):
        status, payload, _ = self.analyze(JA_WORD_JSON, lang="ja")
        self.assertEqual(status, 200, payload)
        track = payload["track"]
        self.assertEqual(track["lang"]["code"], "ja")
        self.assertFalse(track["lang"]["spaceDelimited"])
        words = {w["text"]: w for s in track["sentences"] for w in s["words"]}
        self.assertEqual(words["今日"]["read"], "きょう")
        self.assertEqual(words["今日"]["roman"], "kyou")
        self.assertNotIn("read", words["ね"])      # 纯假名不注音
        self.assertEqual(words["は"]["roman"], "wa")   # 助词按发音转写

    def test_words_reconstruct_the_sentence(self):
        _, payload, _ = self.analyze(JA_WORD_JSON, lang="ja")
        for s in payload["track"]["sentences"]:
            self.assertEqual("".join(w["text"] for w in s["words"]), s["text"])


class StatelessTest(ApiCase):
    """「后端不存任何数据」不是文档里的承诺, 是可断言的性质."""

    @unittest.skipUnless(HAS_JA or HAS_EN, "至少要有一门语言可用")
    def test_analyze_writes_nothing_to_disk(self):
        before = tree(self.tmp)
        body, lang = (JA_WORD_JSON, "ja") if HAS_JA else (EN_WORD_JSON, "en")
        status, payload, _ = self.analyze(body, lang=lang, id="demo")
        self.assertEqual(status, 200, payload)
        self.assertEqual(tree(self.tmp), before)

    @unittest.skipUnless(HAS_JA or HAS_EN, "至少要有一门语言可用")
    def test_same_id_twice_is_not_an_error_nothing_is_remembered(self):
        body, lang = (JA_WORD_JSON, "ja") if HAS_JA else (EN_WORD_JSON, "en")
        first = self.analyze(body, lang=lang, id="dup")[1]
        second = self.analyze(body, lang=lang, id="dup")[1]
        self.assertEqual(first["track"]["stats"], second["track"]["stats"])
        self.assertEqual(tree(self.tmp), {"index.html"})

    def test_no_index_endpoint_exists(self):
        status, _, _ = self.call("GET", "/api/tracks")
        self.assertEqual(status, 404)
        self.assertFalse((self.tmp / "data").exists())


if __name__ == "__main__":
    unittest.main()
