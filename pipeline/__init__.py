"""Lingua 分析后端.

只做一件事: 把「音频的字幕」加工成前端播放器直接消费的结构化 JSON。

    ASR JSON / SRT / VTT  ->  逐字时间轴  ->  切句
                          ->  逐语言分析 (MeCab / spaCy)  ->  Track JSON

**无状态**: 不存储任何用户数据, 不调用大模型 —— 音频、译文、词卡、讲解全部由浏览器
自己保管 (IndexedDB) 与调用。对外入口是 ``python -m pipeline serve`` 起的
``POST /api/analyze`` (见 :mod:`pipeline.api`), 以及一个同功能的调试子命令
``python -m pipeline analyze`` (见 :mod:`pipeline.cli`)。
"""

__version__ = "2.0.0"
GENERATOR = f"lingua-pipeline/{__version__}"
#: track.json 的契约版本. 2 起自描述语言信息 (``lang`` 块), 层名改为 read/roman。
SCHEMA_VERSION = 2

__all__ = ["__version__", "GENERATOR", "SCHEMA_VERSION"]
