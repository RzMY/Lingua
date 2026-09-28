"""Release publication ordering and rolling preview retention, without external writes."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).parents[1] / 'mobile/scripts/publish-release.py'
if SCRIPT.exists():
    spec = importlib.util.spec_from_file_location('publish_release', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


class FakeGitHub:
    def __init__(self, preview=True, sha='new', *, draft=False, exists=True, release_pages=None):
        self.calls = []
        self.sha = sha
        self.release = {'id': 1, 'prerelease': preview, 'draft': draft,
                        'tag_name': 'pre-release' if preview else 'v1.0.0',
                        'name': 'Handwritten title', 'body': 'Handwritten release notes',
                        'upload_url': 'https://uploads.github.com/repos/RzMY/Lingua/releases/1/assets{?name,label}'} if exists else None
        self.release_pages = release_pages

    def request(self, method, path, data=None, content_type=None):
        self.calls.append((method, path, data))
        if method == 'GET' and path == '/git/ref/heads/main':
            return {'object': {'sha': self.sha}}
        if method == 'GET' and path.startswith('/releases/tags/'):
            if self.release and self.release['draft']:
                return None
            return self.release
        if method == 'GET' and path.startswith('/releases?'):
            page = int(path.rsplit('=', 1)[1])
            if self.release_pages is not None:
                return self.release_pages.get(page, [])
            return [self.release] if self.release else []
        if method == 'POST' and path == '/releases':
            self.release = dict(data, id=1,
                                upload_url='https://uploads.github.com/repos/RzMY/Lingua/releases/1/assets{?name,label}')
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

    def test_tag_creates_draft_with_generated_notes_and_complete_assets(self):
        with tempfile.TemporaryDirectory() as folder:
            api = FakeGitHub(preview=False, exists=False)
            paths = self.files(folder)
            module.publish(api, paths, preview=False, tag='v1.0.0', sha='new')
            created = next(data for method, path, data in api.calls if method == 'POST' and path == '/releases')
            self.assertEqual(created['tag_name'], 'v1.0.0')
            self.assertEqual(created['target_commitish'], 'new')
            self.assertEqual(created['name'], 'Lingua v1.0.0')
            self.assertTrue(created['draft'])
            self.assertFalse(created['prerelease'])
            self.assertTrue(created['generate_release_notes'])
            self.assertNotIn('make_latest', created)
            uploads = [path for method, path, _ in api.calls if method == 'POST' and path.startswith('https://')]
            self.assertEqual(len(uploads), len(paths))
            self.assertTrue(uploads[-1].endswith('name=manifest.json'))
            self.assertFalse(any(method == 'PATCH' or '/git/' in path for method, path, _ in api.calls))

    def test_rerun_reuses_hidden_draft_and_preserves_edited_notes(self):
        with tempfile.TemporaryDirectory() as folder:
            api = FakeGitHub(preview=False, draft=True)
            original = dict(api.release)
            paths = self.files(folder)
            for _ in range(2):
                module.publish(api, paths, preview=False, tag='v1.0.0', sha='new')
            self.assertIn(('GET', '/releases?per_page=100&page=1', None), api.calls)
            self.assertEqual(api.release, original)
            self.assertFalse(any(method == 'POST' and path == '/releases' for method, path, _ in api.calls))
            self.assertFalse(any(method == 'PATCH' or '/git/' in path for method, path, _ in api.calls))
            self.assertNotIn(('DELETE', '/releases/assets/5', None), api.calls)
            uploads = [path for method, path, _ in api.calls if method == 'POST' and path.startswith('https://')]
            self.assertEqual(len(uploads), 2 * len(paths))

    def test_draft_lookup_checks_later_pages(self):
        api = FakeGitHub(preview=False, draft=True)
        api.release_pages = {1: [{'tag_name': f'v0.0.{i}'} for i in range(100)], 2: [api.release]}
        self.assertIs(module.find_release(api, 'v1.0.0'), api.release)
        self.assertIn(('GET', '/releases?per_page=100&page=2', None), api.calls)

    def test_new_main_preview_is_published_immediately(self):
        with tempfile.TemporaryDirectory() as folder:
            api = FakeGitHub(exists=False)
            module.publish(api, self.files(folder), preview=True, tag='pre-release', sha='new')
            self.assertEqual(api.release['tag_name'], 'pre-release')
            self.assertFalse(api.release['draft'])
            self.assertTrue(api.release['prerelease'])
            self.assertEqual(api.release['make_latest'], 'false')

    def test_entrypoint_routes_main_and_version_tags_only(self):
        config = json.loads((SCRIPT.parents[1] / 'release-config.json').read_text())
        with patch.dict(module.os.environ, {'GITHUB_REPOSITORY': config['repository'], 'GH_TOKEN': 'test',
                                          'GITHUB_SHA': 'new'}, clear=True), \
                patch.object(module.sys, 'argv', [str(SCRIPT), 'release-assets']), \
                patch.object(module, 'release_files', return_value={}), \
                patch.object(module, 'publish') as publish:
            for ref, preview, tag in [('refs/heads/main', True, config['previewTag']),
                                      ('refs/tags/v1.0.0', False, 'v1.0.0')]:
                with self.subTest(ref=ref):
                    module.os.environ['GITHUB_REF'] = ref
                    module.main()
                    self.assertEqual(publish.call_args.kwargs, {'preview': preview, 'tag': tag, 'sha': 'new'})
            publish.reset_mock()
            for ref in ['refs/heads/feature', 'refs/pull/1/merge', f"refs/tags/{config['previewTag']}", 'refs/tags/test']:
                with self.subTest(ref=ref), self.assertRaises(SystemExit):
                    module.os.environ['GITHUB_REF'] = ref
                    module.main()
            publish.assert_not_called()

    def test_incomplete_or_corrupt_build_cannot_be_published(self):
        with tempfile.TemporaryDirectory() as folder:
            self.files(folder)
            (Path(folder) / 'Lingua.ipa').unlink()
            with self.assertRaisesRegex(RuntimeError, 'Missing release assets'):
                module.release_files(Path(folder))
        with tempfile.TemporaryDirectory() as folder:
            paths = self.files(folder)
            bundle = next(path for name, path in paths.items() if name.startswith('bundle-'))
            bundle.write_bytes(b'corrupt bundle')
            with self.assertRaisesRegex(RuntimeError, 'Bundle checksum/size mismatch'):
                module.release_files(Path(folder))


if __name__ == '__main__':
    unittest.main()
