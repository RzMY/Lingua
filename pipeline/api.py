"""无状态分析 API —— 后端的全部功能就这两个端点.

* ``GET  /api/health``  —— 版本 / schema 版本 / 每门语言的依赖是否就位
* ``POST /api/analyze`` —— 请求体是字幕原文 (裸 body), 响应是 ``track.json``

设计约束 (来自「前后端完全分离」):

* **不存任何数据** —— 字幕在内存里解析完就丢, 不写临时文件、不留日志文件、不建库。
  音频、译文、词卡、讲解全部归浏览器 (IndexedDB) 管。
* **不调大模型** —— 这里连 ``requests`` 都不需要, 翻译/讲解都在前端直连模型端点。
* **同步返回** —— 既然没有存储就没有「作业」可轮询; 分析是一次请求内完成的,
  过程日志随响应一起给前端展示。
* **不引入 Web 框架** —— 仍然是 stdlib ``http.server``, 路由手写, 依赖为零。

鉴权: 配置 ``LINGUA_API_TOKEN`` 后, 所有 API 请求都需要 Bearer Token (OPTIONS
预检除外)。校验在读取字幕、探测依赖之前完成; 默认只监听 ``127.0.0.1``。
"""

from __future__ import annotations

import json
import re
import secrets
import threading
import unicodedata
import urllib.parse
from pathlib import Path

from . import SCHEMA_VERSION, __version__, langs
from .analyze import AnalyzeOptions, analyze
from .inputs import SUFFIXES, InputError

#: 字幕是纯文本, 64 MiB 足够放三小时的词级时间戳 JSON
MAX_BODY = 64 * 1024 * 1024
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
MAX_LOG = 200

_CORS = (
    ("Access-Control-Allow-Origin", "*"),
    ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
    ("Access-Control-Allow-Headers", "Content-Type, Authorization"),
    ("Access-Control-Max-Age", "86400"),
    ("Vary", "Origin"),
)


class ApiError(RuntimeError):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def safe_name(raw: str, fallback: str = "file") -> str:
    """把上传来的文件名收敛成安全的单段文件名 (保留中日韩文字符).

    这里已经不落盘了, 但文件名仍然会被回显进日志与 ``track.json`` 的标题, 所以照旧
    去掉路径分隔符与控制字符。
    """
    name = urllib.parse.unquote(raw or "").replace("\\", "/").split("/")[-1]
    name = unicodedata.normalize("NFC", name).strip()
    name = re.sub(r'[\x00-\x1f<>:"|?*]', "_", name).lstrip(". ")
    if not name:
        return fallback
    if len(name) > 120:
        stem, dot, ext = name.rpartition(".")
        name = stem[:100] + dot + ext[:16] if dot else name[:120]
    return name


def slug_id(name: str) -> str:
    """文件名 -> URL 安全的短 id; 全非 ASCII 时退回 ``audio``."""
    ascii_only = unicodedata.normalize("NFKD", Path(name).stem)
    ascii_only = ascii_only.encode("ascii", "ignore").decode()
    out = re.sub(r"[^A-Za-z0-9]+", "-", ascii_only).strip("-").lower()[:40]
    return out or "audio"


def check_id(tid: str) -> str:
    """id 只允许 ``[A-Za-z0-9._-]`` 且不以点开头 —— 它会进 JSON, 也会当缓存键."""
    if not ID_RE.match(tid or "") or ".." in tid:
        raise ApiError(400, f"非法的曲目 id: {tid!r}")
    return tid


def _flag(query: dict, key: str, default: bool) -> bool:
    raw = query.get(key)
    if raw is None or raw == "":
        return default
    return str(raw).lower() not in ("0", "false", "no", "off")


def _number(query: dict, key: str, default=None):
    raw = query.get(key)
    if raw is None or raw == "":
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ApiError(400, f"{key} 必须是数字, 收到 {raw!r}") from None
    return value


class Api:
    """挂在 HTTP 服务器上的 ``/api/*`` 路由表; 一个进程一份."""

    def __init__(self, dicdir: str | None = None, api_token: str | None = None) -> None:
        self.dicdir = dicdir or None
        token = (api_token or "").strip()
        if token and not re.fullmatch(r"[!-~]+", token):
            raise ValueError("LINGUA_API_TOKEN 必须是无空格的 ASCII 字符串")
        self._token = token.encode("ascii")
        #  分析器 (MeCab tagger / spaCy Language) 都不是线程安全的, 而
        #  ThreadingHTTPServer 是多线程的 —— 用一把锁把分析串起来。反正是 CPU 密集,
        #  并发跑也不会更快。
        self._lock = threading.Lock()

    # ---------------------------------------------------------------- 入口

    def handle(self, h, method: str) -> bool:
        """返回 True 表示这条请求已被 API 处理, 静态文件分支不用再管."""
        split = urllib.parse.urlsplit(h.path)
        if split.path != "/api" and not split.path.startswith("/api/"):
            return False
        query = {k: v[-1] for k, v in urllib.parse.parse_qs(split.query).items()}
        try:
            self._route(h, method, split.path, query)
        except ApiError as exc:
            self._send(h, exc.status, {"error": exc.message})
        except (InputError, ValueError, RuntimeError, FileNotFoundError) as exc:
            # 缺少语言模型/词典是可修复的部署配置问题，应作为客户端可处理的分析错误返回。
            self._send(h, 400, {"error": str(exc)})
        except Exception as exc:                                   # noqa: BLE001
            self._send(h, 500, {"error": f"{type(exc).__name__}: {exc}"})
        return True

    def _route(self, h, method: str, path: str, query: dict) -> None:
        if method == "OPTIONS":                      # CORS 预检
            return self._preflight(h)
        self._authorize(h)
        parts = [p for p in path.strip("/").split("/") if p][1:]
        if parts == ["health"] and method == "GET":
            return self._health(h, query)
        if parts == ["analyze"] and method == "POST":
            return self._analyze(h, query)
        raise ApiError(404, f"没有这个接口: {method} {path}")

    def _authorize(self, h) -> None:
        if not self._token:
            return
        headers = h.headers.get_all("Authorization", [])
        scheme, _, token = (headers[0] if len(headers) == 1 else "").partition(" ")
        if scheme.lower() == "bearer" and secrets.compare_digest(
                token.encode("utf-8"), self._token):
            return
        # 未读取的 POST body 不能被复用连接当成下一条请求。
        h.close_connection = True
        raise ApiError(401, "分析后端鉴权失败: 请在「设置 → 分析后端」填写正确的访问令牌")

    # ---------------------------------------------------------------- 端点

    def _health(self, h, query: dict) -> None:
        probe = _flag(query, "probe", True)
        self._send(h, 200, {
            "ok": True,
            "service": "lingua-analyze",
            "version": __version__,
            "schemaVersion": SCHEMA_VERSION,
            "stateless": True,
            "formats": list(SUFFIXES),
            "maxBody": MAX_BODY,
            "languages": langs.catalog(probe=probe, dicdir=self.dicdir),
        })

    def _analyze(self, h, query: dict) -> None:
        name = safe_name(query.get("name", ""), "transcript.json")
        raw = self._read_body(h)
        wanted = (query.get("lang") or "").strip()
        if wanted and langs.resolve(wanted) is None:
            raise ApiError(400, f"不支持的语言 {wanted!r}; 可用: {', '.join(langs.codes())}")
        track_id = (query.get("id") or "").strip() or slug_id(name)
        opts = AnalyzeOptions(
            language=wanted,
            track_id=check_id(track_id),
            title=(query.get("title") or "").strip()[:200] or Path(name).stem,
            split_sentences=_flag(query, "split", True),
            merge_words=_flag(query, "merge", True),
            estimate_word_timing=_flag(query, "estimate", False),
            max_sentence_seconds=max(0.0, _number(query, "maxSeconds", 11.0)),
            duration=_number(query, "duration"),
            audio_src=(query.get("audio") or "").strip()[:400],
            dicdir=self.dicdir,
        )
        lines: list[str] = []

        def log(text: str = "") -> None:
            if len(lines) < MAX_LOG:
                lines.append(str(text).rstrip())

        with self._lock:                                # 分析器不是线程安全的
            track = analyze(raw, name, opts, log=log)
        self._send(h, 200, {"ok": True, "log": lines, "track": track},
                   pretty=_flag(query, "pretty", False))

    # ---------------------------------------------------------------- 收发

    def _read_body(self, h) -> bytes:
        try:
            length = int(h.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            raise ApiError(411, "缺少 Content-Length 或请求体为空")
        if length > MAX_BODY:
            raise ApiError(413, f"字幕超过 {MAX_BODY // (1 << 20)} MiB")
        chunks: list[bytes] = []
        left = length
        while left > 0:
            piece = h.rfile.read(min(1 << 20, left))
            if not piece:
                break
            chunks.append(piece)
            left -= len(piece)
        if left:
            raise ApiError(400, "上传中断, 请重试")
        return b"".join(chunks)

    def _preflight(self, h) -> None:
        h.send_response(204)
        for key, value in _CORS:
            h.send_header(key, value)
        h.send_header("Content-Length", "0")
        h.end_headers()

    def _send(self, h, status: int, obj: dict, pretty: bool = False) -> None:
        text = (json.dumps(obj, ensure_ascii=False, indent=2) if pretty
                else json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
        raw = text.encode("utf-8")
        h.send_response(status)
        h.send_header("Content-Type", "application/json; charset=utf-8")
        h.send_header("Content-Length", str(len(raw)))
        if status == 401:
            h.send_header("WWW-Authenticate", 'Bearer realm="lingua-analyze"')
            h.send_header("Connection", "close")
        for key, value in _CORS:
            h.send_header(key, value)
        h.end_headers()
        if h.command != "HEAD":
            h.wfile.write(raw)
