"""Publish completed build assets. A single preview tag is replaced by the latest main commit."""
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request


class GitHub:
    def __init__(self, repository, token):
        self.base = f'https://api.github.com/repos/{repository}'
        self.token = token

    def request(self, method, path, data=None, content_type='application/json'):
        url = path if path.startswith('https://') else self.base + path
        payload = data if isinstance(data, bytes) else json.dumps(data).encode() if data is not None else None
        request = urllib.request.Request(url, data=payload, method=method, headers={
            'Authorization': f'Bearer {self.token}', 'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': content_type,
            'User-Agent': 'Lingua-release-publisher'})
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                body = response.read()
                return json.loads(body) if body else None
        except urllib.error.HTTPError as error:
            if error.code == 404 and method == 'GET':
                return None
            raise RuntimeError(f'GitHub {method} failed: HTTP {error.code}') from None

    def assets(self, release_id):
        found = []
        for page in range(1, 101):
            batch = self.request('GET', f'/releases/{release_id}/assets?per_page=100&page={page}') or []
            found.extend(batch)
            if len(batch) < 100:
                return found
        raise RuntimeError('Release has too many assets')


def release_files(folder):
    paths = {path.name: path for path in folder.rglob('*') if path.is_file()}
    required = {'manifest.json', 'Lingua-web.zip', 'Lingua.apk', 'Lingua.ipa'}
    if required - paths.keys():
        raise RuntimeError('Missing release assets: ' + ', '.join(sorted(required - paths.keys())))
    manifest = json.loads(paths['manifest.json'].read_text())
    name = f"bundle-{manifest['version']}.zip"
    if manifest.get('bundle') != name or name not in paths:
        raise RuntimeError('Missing mobile bundle')
    content = paths[name].read_bytes()
    if hashlib.sha256(content).hexdigest() != manifest['checksum'] or len(content) != manifest['size']:
        raise RuntimeError('Bundle checksum/size mismatch')
    names = required | {name}
    if 'Lingua-release.apk' in paths:
        names.add('Lingua-release.apk')
    # Only the current manifest's ZIP is published, even if local tests built earlier versions.
    return {name: paths[name] for name in names}


def owned_asset(name):
    # AAB is no longer built or uploaded, but still counts as owned so the
    # next preview publish removes the obsolete asset from the Pre-release.
    return name in {'manifest.json', 'Lingua-web.zip', 'Lingua.apk', 'Lingua.aab', 'Lingua.ipa', 'Lingua-release.apk'} or (
        name.startswith('bundle-') and name.endswith('.zip'))


def publish(api, paths, *, preview, tag, sha):
    if preview:
        # A slow, superseded build must never roll the preview tag back to an old commit.
        head = api.request('GET', '/git/ref/heads/main')
        if not head or head['object']['sha'] != sha:
            print('Skipping superseded main build; a newer commit owns Pre-release.')
            return
    encoded_tag = urllib.parse.quote(tag, safe='')
    release = api.request('GET', f'/releases/tags/{encoded_tag}')
    if release and bool(release['prerelease']) != preview:
        raise RuntimeError('Refusing to change a release between stable and preview')
    if release and release.get('draft'):
        raise RuntimeError('Publish the formal Release before attaching artifacts')
    if preview:
        ref = f'/git/refs/tags/{encoded_tag}'
        if api.request('GET', f'/git/ref/tags/{encoded_tag}'):
            api.request('PATCH', ref, {'sha': sha, 'force': True})
        else:
            api.request('POST', '/git/refs', {'ref': f'refs/tags/{tag}', 'sha': sha})
    if release is None:
        release = api.request('POST', '/releases', {'tag_name': tag, 'target_commitish': sha,
            'name': 'Lingua Pre-release' if preview else f'Lingua {tag}', 'prerelease': preview,
            'draft': False, 'make_latest': 'false' if preview else 'true'})
    if preview:
        api.request('PATCH', f"/releases/{release['id']}", {'name': 'Lingua Pre-release',
            'target_commitish': sha, 'prerelease': True, 'make_latest': 'false',
            'body': f'Latest main build: `{sha}`.\n\n'
                    'Lingua.apk / Lingua.ipa / Lingua-web.zip / mobile update manifest and ZIP.'})
    existing = {asset['name']: asset for asset in api.assets(release['id'])}
    upload = release['upload_url'].split('{')[0]
    for name in sorted(paths, key=lambda name: (name == 'manifest.json', name)):
        if name in existing:
            api.request('DELETE', f"/releases/assets/{existing[name]['id']}")
        url = upload + '?' + urllib.parse.urlencode({'name': name})
        api.request('POST', url, paths[name].read_bytes(), mimetypes.guess_type(name)[0] or 'application/octet-stream')
        print(f'Published {name}')
    # Remove obsolete preview artifacts only after the new manifest is in place.
    for name, asset in existing.items():
        if owned_asset(name) and name not in paths:
            api.request('DELETE', f"/releases/assets/{asset['id']}")


def main():
    config = json.loads((Path(__file__).parents[1] / 'release-config.json').read_text())
    repository = os.environ['GITHUB_REPOSITORY']
    if repository.lower() != config['repository'].lower():
        raise SystemExit('Update mobile/release-config.json to this repository before publishing a fork.')
    ref = os.environ['GITHUB_REF']
    tag = os.environ.get('RELEASE_TAG') or (ref.removeprefix('refs/tags/') if ref.startswith('refs/tags/') else '')
    preview = not tag
    if not preview and tag == config['previewTag']:
        raise SystemExit('The rolling preview tag cannot be used as a formal release.')
    publish(GitHub(repository, os.environ['GH_TOKEN']), release_files(Path(sys.argv[1])), preview=preview,
            tag=config['previewTag'] if preview else tag, sha=os.environ['GITHUB_SHA'])


if __name__ == '__main__':
    main()
