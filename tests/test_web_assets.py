"""前端静态资源的静态检查 —— 只读文件, 不起浏览器.

只用标准库::

    python -m unittest discover -s tests -v

这一组用例守的是一类**沉默的**样式 bug: CSS 自定义属性拼错了名字。

没注册的自定义属性一旦拼错, ``var()`` 会「在计算值时失效」(invalid at
computed-value time)。对**非继承**属性来说这不是「这一个值没生效」, 而是整条声明
连坐回落 —— ``grid-template-rows: var(--lh-read) …`` 里错一个名字, 整个
``grid-template-rows`` 就变成 ``none``, 单词卡片的四行高度改由内容决定: 有注音的词
比没注音的词高一截, 于是**同一行里的原文上下参差**。

这曾经真的发生过 (``--lh-roman`` 被写成 ``--lh-romanan``), 而且它不报错、不刷红,
只是字幕看着歪了。所以下面两条各守一头:

* :meth:`CssVariablesTest.test_every_var_reference_is_defined` —— 拼错就红;
* :meth:`WordChipGridTest.test_grid_rows_are_registered_properties` —— 万一还是拼错了,
  ``@property`` 让它只回落到那一个变量的初始值, 网格结构不塌。
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"

#: ``--x: …`` 的定义 (行首 / ``{`` / ``;`` 之后, 免得把 ``var(--x)`` 里的名字算进来)
_DEF = re.compile(r"(?:^|[;{\s])(--[\w-]+)\s*:")
#: ``@property --x { … }`` 注册, 也算定义
_PROP = re.compile(r"@property\s+(--[\w-]+)")
#: ``var(--x)`` / ``var(--x, 回落值)`` —— 第二组捕获到逗号就说明有回落值
_USE = re.compile(r"var\(\s*(--[\w-]+)\s*(,)?")


def assets() -> list[Path]:
    """所有会参与样式计算的文件 (HTML 里也能写内联自定义属性)."""
    files = sorted(WEB.rglob("*.css")) + sorted(WEB.glob("*.html"))
    assert files, f"没找到前端资源, WEB={WEB}"
    return files


def scan() -> tuple[dict[str, set[str]], dict[str, set[str]], dict[str, set[str]]]:
    """扫一遍全部资源, 返回 (定义, 无回落值的引用, 全部引用); 值是出现的文件名."""
    defined: dict[str, set[str]] = {}
    bare: dict[str, set[str]] = {}
    used: dict[str, set[str]] = {}
    for path in assets():
        text = path.read_text(encoding="utf-8")
        where = path.name
        for name in set(_DEF.findall(text)) | set(_PROP.findall(text)):
            defined.setdefault(name, set()).add(where)
        for match in _USE.finditer(text):
            used.setdefault(match.group(1), set()).add(where)
            if not match.group(2):
                bare.setdefault(match.group(1), set()).add(where)
    return defined, bare, used


class CssVariablesTest(unittest.TestCase):
    """自定义属性的名字必须对得上 —— 这是那类「不报错只歪掉」的 bug 的唯一防线."""

    @classmethod
    def setUpClass(cls):
        cls.defined, cls.bare, cls.used = scan()

    def test_every_var_reference_is_defined(self):
        """``var(--x)`` (没写回落值的) 引用的名字必须在某处定义过."""
        missing = {name: sorted(files)
                   for name, files in self.bare.items() if name not in self.defined}
        self.assertFalse(missing, f"引用了没定义的自定义属性: {missing}")

    def test_no_dead_custom_properties(self):
        """定义了却没人用的变量要清掉 —— 常常是改名改了一半的残留."""
        dead = sorted(name for name in self.defined if name not in self.used)
        self.assertFalse(dead, f"定义了但没用到的自定义属性: {dead}")

    def test_scan_actually_found_something(self):
        """正则要是哪天匹配不上了, 上面两条会静静地全绿 —— 这里兜一下底."""
        self.assertGreater(len(self.defined), 30)
        self.assertGreater(len(self.bare), 30)
        self.assertIn("--ink", self.defined)


class WordChipGridTest(unittest.TestCase):
    """单词卡片的四行网格: 行高必须是**与内容无关**的固定长度.

    这条不变式撑着两件事 —— 同一视觉行里所有原文落在同一条基线上 (有没有注音都一样),
    以及虚拟列表能不测 DOM 就算准句子高度。
    """

    @classmethod
    def setUpClass(cls):
        cls.reader = (WEB / "css" / "reader.css").read_text(encoding="utf-8")
        cls.base = (WEB / "css" / "base.css").read_text(encoding="utf-8")

    def grid_vars(self) -> list[str]:
        """``.w`` 的 ``grid-template-rows`` 里用到的自定义属性."""
        bodies = [m.group(1) for m in re.finditer(r"\.w\s*\{([^}]*)\}", self.reader)
                  if "grid-template-rows" in m.group(1)]
        self.assertEqual(len(bodies), 1, "reader.css 里 .w 的网格声明不唯一")
        rows = re.search(r"grid-template-rows\s*:([^;]*);", bodies[0])
        self.assertIsNotNone(rows, "没找到 grid-template-rows")
        return [m.group(1) for m in _USE.finditer(rows.group(1))]

    def test_grid_rows_come_from_variables(self):
        names = self.grid_vars()
        #  行1 注音 / 行2 原文 / 行3 记号条 (高度 + 间距) / 行4 转写
        self.assertEqual(names, ["--lh-read", "--lh-text", "--h-bar", "--gap-bar",
                                 "--lh-roman"])

    def test_grid_rows_are_registered_properties(self):
        """每一个都得 ``@property`` 注册成 ``<length>`` 且带初始值.

        注册过之后, 名字拼错只会让**那一个**变量回落到初始值; 没注册的话整条
        ``grid-template-rows`` 会回落成 ``none``, 四行高度改由内容决定 —— 字幕就歪了。
        """
        blocks = dict(re.findall(r"@property\s+(--[\w-]+)\s*\{([^}]*)\}", self.base))
        for name in self.grid_vars():
            with self.subTest(var=name):
                body = blocks.get(name)
                self.assertIsNotNone(body, f"{name} 没有 @property 注册")
                self.assertIn("<length>", body)
                self.assertRegex(body, r"initial-value\s*:\s*[\d.]+px")

    def test_layers_can_be_switched_off_without_breaking_the_grid(self):
        """关掉注音/转写是把那一行的高度压成 0, 而不是删掉变量."""
        for attr, var in (("data-read", "--lh-read"), ("data-roman", "--lh-roman")):
            with self.subTest(layer=attr):
                self.assertRegex(
                    self.reader,
                    r'html\[' + attr + r'="0"\]\s*\{\s*' + var + r'\s*:\s*0px;\s*\}')


if __name__ == "__main__":
    unittest.main(verbosity=2)
