"""Release publication ordering and rolling preview retention, without external writes."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).parents[1] / 'mobile/scripts/publish-release.py'
if SCRIPT.exists():
    spec = importlib.util.spec_from_file_location('publish_release', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


class FakeGitHub:
    def __init__(self, preview=True, sha='new'):
        self.calls = []
        self.sha = sha
        self.release = {'id': 1, 'prerelease': preview, 'upload_url': 'https://uploads.github.com/repos/RzMY/Lingua/releases/1/assets{?name,label}'}

    def request(self, method, path, data=None, content_type=None):
        self.calls.append((method, path, data))
        if method == 'GET' and path == '/git/ref/heads/main':
            return {'object': {'sha': self.sha}}
        if method == 'GET' and path.startswith('/releases/tags/'):
            return self.release
        if method == 'GET' and path.startswith('/git/ref/tags/'):
            return {'object': {'sha': 'old'}}
        return {}

    def assets(self, _):
        return [{'name': 'manifest.json', 'id': 3}, {'name': 'bundle-old.zip', 'id': 4},
                {'name': 'user-notes.txt', 'id': 5}, {'name': 'Lingua.aab', 'id': 6}]


@unittest.skipUnless(SCRIPT.exists(), 'Build tools are excluded from the production Python image; tested in Mobile apps CI')
class PublicationTests(unittest.TestCase):
    def files(self, folder):
        root = Path(folder)
        version = 'a' * 64
        bundle = f'bundle-{version}.zip'
        data = b'test bundle'
        (root / bundle).write_bytes(data)
        (root / 'manifest.json').write_text(json.dumps({'version': version, 'bundle': bundle,
            'size': len(data), 'checksum': hashlib.sha256(data).hexdigest()}))
        for name in ('Lingua-web.zip', 'Lingua.apk', 'Lingua.aab', 'Lingua.ipa', 'bundle-stale.zip'):
            (root / name).write_bytes(b'package')
        return module.release_files(root)

    def test_preview_replaces_owned_assets_only_and_manifest_is_uploaded_last(self):
        with tempfile.TemporaryDirectory() as folder:
            paths = self.files(folder)
            self.assertNotIn('bundle-stale.zip', paths)
            self.assertNotIn('Lingua.aab', paths)
            api = FakeGitHub()
            module.publish(api, paths, preview=True, tag='pre-release', sha='new')
            uploads = [path for method, path, _ in api.calls if method == 'POST' and path.startswith('https://')]
            self.assertTrue(uploads[-1].endswith('name=manifest.json'))
            self.assertIn(('DELETE', '/releases/assets/4', None), api.calls)
            self.assertIn(('DELETE', '/releases/assets/6', None), api.calls)
            self.assertNotIn(('DELETE', '/releases/assets/5', None), api.calls)
            self.assertIn(('PATCH', '/git/refs/tags/pre-release', {'sha': 'new', 'force': True}), api.calls)
            body = next(data['body'] for method, path, data in api.calls
                        if method == 'PATCH' and path == '/releases/1')
            self.assertNotIn('Assets are replaced', body)
            self.assertNotIn('unsigned IPA', body)
            self.assertNotIn('aab', body.lower())

    def test_superseded_commit_cannot_publish(self):
        api = FakeGitHub(sha='newer')
        module.publish(api, {}, preview=True, tag='pre-release', sha='old')
        self.assertTrue(all(method == 'GET' for method, _, _ in api.calls))

    def test_formal_release_preserves_tag_and_release_notes(self):
        with tempfile.TemporaryDirectory() as folder:
            api = FakeGitHub(preview=False)
            module.publish(api, self.files(folder), preview=False, tag='v1.0.0', sha='new')
            self.assertFalse(any(method == 'PATCH' for method, _, _ in api.calls))
            self.assertFalse(any('/git/' in path for _, path, _ in api.calls))

    def test_incomplete_or_corrupt_build_cannot_be_published(self):
        with tempfile.TemporaryDirectory() as folder:
            self.files(folder)
            (Path(folder) / 'Lingua.ipa').unlink()
            with self.assertRaisesRegex(RuntimeError, 'Missing release assets'):
                module.release_files(Path(folder))


if __name__ == '__main__':
    unittest.main()
