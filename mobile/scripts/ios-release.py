"""Sign and export on a disposable macOS GitHub Actions runner; never print credentials."""
import base64
import os
from pathlib import Path
import plistlib
import shlex
import subprocess
import tempfile
import uuid


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def main():
    keys = ('IOS_CERTIFICATE_BASE64', 'IOS_PROVISION_PROFILE_BASE64', 'IOS_TEAM_ID')
    if not any(os.environ.get(key) for key in keys):
        print('No iOS signing credentials: unsigned compilation completed; no installable IPA exported.')
        return
    if not all(os.environ.get(key) for key in keys):
        raise SystemExit('Configure all IOS_CERTIFICATE_BASE64 / IOS_PROVISION_PROFILE_BASE64 / IOS_TEAM_ID secrets.')
    method = os.environ.get('IOS_EXPORT_METHOD', 'release-testing')
    if method not in ('release-testing', 'app-store-connect', 'enterprise', 'debugging'):
        raise SystemExit('Unsupported IOS_EXPORT_METHOD')
    old_keychains = shlex.split(run('security', 'list-keychains', '-d', 'user', capture_output=True, text=True).stdout)
    installed_profile = None
    with tempfile.TemporaryDirectory(prefix='lingua-sign-') as temp:
        folder = Path(temp)
        keychain = str(folder / 'signing.keychain-db')
        password = str(uuid.uuid4())
        cert = folder / 'certificate.p12'
        cert.write_bytes(base64.b64decode(os.environ['IOS_CERTIFICATE_BASE64'], validate=True))
        profile = folder / 'profile.mobileprovision'
        profile.write_bytes(base64.b64decode(os.environ['IOS_PROVISION_PROFILE_BASE64'], validate=True))
        try:
            run('security', 'create-keychain', '-p', password, keychain)
            run('security', 'set-keychain-settings', '-lut', '21600', keychain)
            run('security', 'unlock-keychain', '-p', password, keychain)
            run('security', 'import', str(cert), '-P', os.environ.get('IOS_CERTIFICATE_PASSWORD', ''),
                '-k', keychain, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security', stdout=subprocess.DEVNULL)
            run('security', 'set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-k', password,
                keychain, stdout=subprocess.DEVNULL)
            run('security', 'list-keychains', '-d', 'user', '-s', keychain, *old_keychains)
            decoded = plistlib.loads(run('security', 'cms', '-D', '-i', str(profile), capture_output=True).stdout)
            profile_id = str(uuid.UUID(decoded['UUID']))
            profile_dir = Path.home() / 'Library/MobileDevice/Provisioning Profiles'
            profile_dir.mkdir(parents=True, exist_ok=True)
            profile_path = profile_dir / (profile_id + '.mobileprovision')
            if profile_path.exists():
                raise RuntimeError('Refusing to overwrite an existing provisioning profile')
            installed_profile = profile_path
            installed_profile.write_bytes(profile.read_bytes())
            team = os.environ['IOS_TEAM_ID']
            bundle = 'app.linguatrack.mobile'
            if decoded['Entitlements'].get('application-identifier') != f'{team}.{bundle}':
                raise RuntimeError('Provisioning profile does not match app.linguatrack.mobile and IOS_TEAM_ID')
            archive = str(Path('ios/App/build/Lingua.xcarchive').resolve())
            identity = 'Apple Development' if method == 'debugging' else 'Apple Distribution'
            run('xcodebuild', '-project', 'ios/App/App.xcodeproj', '-scheme', 'App', '-configuration', 'Release',
                '-destination', 'generic/platform=iOS', '-archivePath', archive,
                'CODE_SIGN_STYLE=Manual', f'DEVELOPMENT_TEAM={team}', f'CODE_SIGN_IDENTITY={identity}',
                f'PROVISIONING_PROFILE_SPECIFIER={profile_id}', f'OTHER_CODE_SIGN_FLAGS=--keychain {keychain}', 'archive')
            options = folder / 'ExportOptions.plist'
            options.write_bytes(plistlib.dumps({'method': method, 'teamID': team, 'signingStyle': 'manual',
                'provisioningProfiles': {bundle: profile_id}, 'uploadSymbols': False, 'destination': 'export'}))
            run('xcodebuild', '-exportArchive', '-archivePath', archive, '-exportPath', 'ios/App/build/ipa',
                '-exportOptionsPlist', str(options))
        finally:
            if installed_profile and installed_profile.exists():
                installed_profile.unlink()
            subprocess.run(['security', 'list-keychains', '-d', 'user', '-s', *old_keychains], check=False)
            subprocess.run(['security', 'delete-keychain', keychain], check=False, capture_output=True)


if __name__ == '__main__':
    main()
