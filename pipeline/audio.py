"""音频时长探测.

前端拿到 ``<audio>`` 元数据后也能自己算时长, 所以这里探测失败不算致命错误 ——
但离线就知道时长可以让进度条在首帧就正确, 不出现 ``--:--`` 闪烁。
"""

from __future__ import annotations

import contextlib
import json
import shutil
import subprocess
import wave
from pathlib import Path


def _wave_duration(path: Path) -> float | None:
    with contextlib.suppress(Exception), wave.open(str(path), "rb") as wf:
        rate = wf.getframerate()
        if rate:
            return wf.getnframes() / rate
    return None


def _mutagen_duration(path: Path) -> float | None:
    try:
        from mutagen import File as MutagenFile  # type: ignore
    except ImportError:
        return None
    with contextlib.suppress(Exception):
        media = MutagenFile(str(path))
        if media is not None and media.info is not None:
            return float(media.info.length)
    return None


def _ffprobe_duration(path: Path) -> float | None:
    exe = shutil.which("ffprobe")
    if not exe:
        return None
    cmd = [
        exe, "-v", "error", "-show_entries", "format=duration",
        "-of", "json", str(path),
    ]
    with contextlib.suppress(Exception):
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=True)
        value = json.loads(out.stdout)["format"]["duration"]
        return float(value)
    return None


def probe_duration(path: str | Path) -> float | None:
    """返回秒数; 全部手段失败返回 ``None``."""
    p = Path(path)
    if not p.is_file():
        return None
    if p.suffix.lower() == ".wav":
        value = _wave_duration(p)
        if value:
            return value
    return _mutagen_duration(p) or _ffprobe_duration(p)
