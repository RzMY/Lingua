"""命令行入口.

    python -m pipeline serve                     # 分析 API + 静态站点 (日常就用这个)
    python -m pipeline serve --no-static -p 8000 # 只跑分析 API, 部署在别的机器上
    python -m pipeline analyze -s a.srt -l en    # 调试: 直接看一遍分析结果
    python -m pipeline langs                     # 各语言的依赖装好了没

``analyze`` 是调试工具, 走的是和 ``/api/analyze`` **完全同一条**代码路径 (
:func:`pipeline.analyze.analyze`), 所以它的输出就是接口的输出。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import __version__, langs
from .analyze import AnalyzeOptions, analyze

REPO_ROOT = Path(__file__).resolve().parent.parent


def load_dotenv(path: Path | None = None) -> None:
    """极简 .env 读取, 不覆盖已存在的环境变量 (免得多一个 python-dotenv 依赖)."""
    env_path = path or REPO_ROOT / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value


def _env(name: str, default: str = "") -> str:
    """读 ``LINGUA_<name>``, 读不到再回落到旧的 ``LINGUATRACK_<name>``."""
    value = os.environ.get(f"LINGUA_{name}")
    if value is None:
        value = os.environ.get(f"LINGUATRACK_{name}")
    return default if value is None else value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m pipeline",
        description="Lingua 分析后端 —— 字幕进, track.json 出; 不存数据, 不调模型",
    )
    parser.add_argument("--version", action="version", version=f"Lingua {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)
    _add_serve(sub)
    _add_analyze(sub)
    sub.add_parser("langs", help="列出支持的语言与依赖状态")
    return parser


def _add_serve(sub) -> None:
    s = sub.add_parser("serve", help="启动分析 API (默认同时提供静态站点)")
    s.add_argument("-r", "--root", default="web", help="站点根目录 (默认 web)")
    s.add_argument("-p", "--port", type=int, default=int(_env("PORT", "5173") or 5173))
    s.add_argument("--host", default=_env("HOST", "127.0.0.1"))
    s.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    s.add_argument("--dicdir", default=_env("DICDIR"), help="UniDic 目录, 默认用 ./dic")
    s.add_argument("--no-api", dest="api", action="store_false",
                   help="只做静态服务 (前端会提示连不上分析后端)")
    s.add_argument("--no-static", dest="static", action="store_false",
                   help="只跑分析 API, 不提供静态文件")


def _add_analyze(sub) -> None:
    b = sub.add_parser("analyze", help="调试: 分析一份字幕并打印 / 写出 track.json")
    b.add_argument("-s", "--subtitle", required=True, help="字幕: .json / .srt / .vtt")
    b.add_argument("-l", "--lang", default="", help=f"源语言 ({'/'.join(langs.codes())})")
    b.add_argument("-o", "--out", default="", help="输出文件 (默认打到标准输出)")
    b.add_argument("--id", dest="track_id", default="", help="曲目 id")
    b.add_argument("--title", default="", help="显示标题")
    b.add_argument("-a", "--audio", help="只用来探测时长, 不复制、不引用")
    b.add_argument("--duration", type=float, default=0.0, help="直接给时长 (秒)")
    b.add_argument("--dicdir", default=_env("DICDIR"), help="UniDic 目录, 默认用 ./dic")
    b.add_argument("--no-split", action="store_true", help="不按句末标点/停顿再切句")
    b.add_argument("--no-merge", action="store_true", help="不合并分词 (4回目 / don't)")
    b.add_argument("--estimate-word-timing", action="store_true",
                   help="字幕没有词级时间戳时按字符均摊估算 (默认关, 只做整句高亮)")
    b.add_argument("--max-sentence-seconds", type=float, default=11.0,
                   help="超过该时长且无标点的句子按停顿再切 (0 = 关闭)")
    b.add_argument("--pretty", action="store_true", help="缩进输出 JSON")


# ---------------------------------------------------------------- 子命令实现


def _cmd_serve(args: argparse.Namespace) -> int:
    from .serve import serve

    serve(root=Path(args.root), host=args.host, port=args.port,
          open_browser=args.open, api=args.api, static=args.static,
          dicdir=args.dicdir or None, api_token=_env("API_TOKEN"))
    return 0


def _cmd_analyze(args: argparse.Namespace) -> int:
    subtitle = Path(args.subtitle)
    if not subtitle.is_file():
        raise FileNotFoundError(f"字幕文件不存在: {subtitle}")

    duration = args.duration or None
    if not duration and args.audio:
        from .audio import probe_duration

        duration = probe_duration(Path(args.audio))

    opts = AnalyzeOptions(
        language=args.lang,
        track_id=args.track_id or subtitle.stem,
        title=args.title or subtitle.stem,
        split_sentences=not args.no_split,
        merge_words=not args.no_merge,
        estimate_word_timing=args.estimate_word_timing,
        max_sentence_seconds=args.max_sentence_seconds,
        duration=duration,
        dicdir=args.dicdir or None,
    )
    log = (lambda text="": print(text, file=sys.stderr)) if args.out else (lambda *_: None)
    track = analyze(subtitle.read_bytes(), subtitle.name, opts, log=log)
    text = (json.dumps(track, ensure_ascii=False, indent=2) if args.pretty
            else json.dumps(track, ensure_ascii=False, separators=(",", ":")))
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        stats = track["stats"]
        print(f"\n完成: {out.as_posix()} — {stats['sentences']} 句 / {stats['words']} 词"
              f" / 逐词高亮 {'开' if track['hasWordTiming'] else '关'}", file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


def _cmd_langs(_args: argparse.Namespace) -> int:
    print(f"{'代码':<6}{'语言':<12}{'引擎':<8}{'文字层':<16}状态")
    for entry in langs.catalog(probe=True):
        layers = "/".join(entry["layerOrder"]) or "-"
        state = "就绪" if entry["ready"] else "缺依赖"
        print(f"{entry['code']:<6}{entry['name']:<12}{entry['engine']:<8}"
              f"{layers:<16}{state}  {entry['detail']}")
    return 0


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    args = build_parser().parse_args(argv)
    try:
        if args.command == "serve":
            return _cmd_serve(args)
        if args.command == "analyze":
            return _cmd_analyze(args)
        if args.command == "langs":
            return _cmd_langs(args)
    except KeyboardInterrupt:
        print("\n已中断", file=sys.stderr)
        return 130
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1
    return 2
