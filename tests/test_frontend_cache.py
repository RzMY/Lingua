import json
import tempfile
import threading
import unittest
from functools import partial
from hashlib import sha256
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

from pipeline.frontend_cache import frontend_manifest
from pipeline.serve import RangeHandler


class FrontendCacheTest(unittest.TestCase):
    def test_inventory_is_fresh_complete_and_excludes_user_data(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, value in {"index.html": "home", "player.html": "player", "js/lazy.js": "v1",
                                "assets/sample.wav": "binary", "data/private.json": "private",
                                "mobile/native.js": "native", ".env": "secret"}.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(value)
            manifest = frontend_manifest(root)
            self.assertEqual({f["path"] for f in manifest["files"]},
                             {"index.html", "player.html", "js/lazy.js", "assets/sample.wav"})
            for item in manifest["files"]:
                data = (root / item["path"]).read_bytes()
                self.assertEqual(item["sha256"], sha256(data).hexdigest())
                self.assertEqual(item["size"], len(data))
            (root / "js/new.js").write_text("new")
            self.assertIn("js/new.js", {f["path"] for f in frontend_manifest(root)["files"]})

    def test_get_and_head_use_actual_subdirectory_source_without_writes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            site = root / "lingua"
            site.mkdir()
            (site / "index.html").write_text("home")
            (site / "development-cache.json").write_text("stale")
            server = ThreadingHTTPServer(("127.0.0.1", 0), partial(RangeHandler, directory=folder))
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                before = {p: p.read_bytes() for p in root.rglob("*") if p.is_file()}
                address = f"http://127.0.0.1:{server.server_port}/lingua/development-cache.json"
                with urlopen(address) as response:
                    manifest = json.load(response)
                    self.assertEqual(response.headers["Cache-Control"], "no-store")
                self.assertEqual(manifest, frontend_manifest(site))
                with urlopen(Request(address, method="HEAD")) as response:
                    self.assertEqual(response.headers["Content-Type"], "application/json")
                    self.assertEqual(response.read(), b"")
                    self.assertGreater(int(response.headers["Content-Length"]), 0)
                (site / "player.html").write_text("player")
                with urlopen(address + "?fresh=1") as response:
                    self.assertEqual(len(json.load(response)["files"]), 2)
                for path, data in before.items():
                    self.assertEqual(path.read_bytes(), data)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()
