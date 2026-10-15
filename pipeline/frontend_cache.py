"""Read-only inventory for explicit native development snapshots."""
from hashlib import sha256
from pathlib import Path

MANIFEST_NAME = "development-cache.json"
ROOT_FILES = {"index.html", "player.html", "manifest.webmanifest", "favicon.ico"}
ASSET_DIRS = {"js", "css", "icons", "assets"}


def frontend_manifest(root: Path) -> dict:
    root = root.resolve()
    files = []
    candidates = [root / name for name in ROOT_FILES]
    for name in ASSET_DIRS:
        folder = root / name
        if folder.is_dir() and not folder.is_symlink():
            candidates.extend(folder.rglob("*"))
    for path in sorted(candidates):
        relative = path.relative_to(root)
        if relative.as_posix() not in ROOT_FILES and relative.parts[0] not in ASSET_DIRS:
            continue
        if path.name == 'audio-probe.wav':
            continue
        if not path.is_file() or not path.resolve().is_relative_to(root):
            continue
        data = path.read_bytes()
        files.append({"path": relative.as_posix(), "size": len(data), "sha256": sha256(data).hexdigest()})
    return {"schema": 1, "files": files}
