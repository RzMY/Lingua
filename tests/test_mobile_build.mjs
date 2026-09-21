import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { parse } from 'yaml';
import xcode from 'xcode';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFile(new URL('../' + path, import.meta.url));

test('native caption plugin is included in the iOS target and registered by the bridge', async () => {
  const project = xcode.project(fileURLToPath(new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url)));
  project.parseSync();
  const phase = project.pbxSourcesBuildPhaseObj('504EC3031FED79650016851F');
  assert.ok(phase.files.some((file) => file.comment === 'CaptionPipPlugin.swift in Sources'));
  assert.ok(phase.files.some((file) => file.comment === 'AudioPlayerPlugin.swift in Sources'));
  assert.match((await read('ios/App/App/AppDelegate.swift')).toString(), /registerPluginInstance\(CaptionPipPlugin\(\)\)/);
  assert.match((await read('ios/App/App/AppDelegate.swift')).toString(), /registerPluginInstance\(AudioPlayerPlugin\(\)\)/);
  const plugin = (await read('ios/App/App/CaptionPipPlugin.swift')).toString();
  assert.match(plugin, /AVPictureInPictureVideoCallViewController/);
  assert.doesNotMatch(plugin, /AVPlayerLayer|AVSampleBufferDisplayLayer|setValue\(|forKey:|NSSelectorFromString/);
});

test('iOS playback uses a valid shared audio category and retains the caption controller after normal stop', async () => {
  const shell = (await read('ios/App/App/AppDelegate.swift')).toString();
  const audio = (await read('ios/App/App/AudioPlayerPlugin.swift')).toString();
  const captions = (await read('ios/App/App/CaptionPipPlugin.swift')).toString();
  assert.match(shell, /setCategory\(\.playback, mode: \.moviePlayback, options: \[\]\)/);
  for (const source of [shell, audio, captions]) assert.doesNotMatch(source, /options:\s*\[\.allowAirPlay\]/);
  assert.match(audio, /try PlaybackSession.activate\(\)/);
  assert.match(captions, /try PlaybackSession.activate\(\)/);
  assert.match(audio, /audiovisualBackgroundPlaybackPolicy = \.continuesIfPossible/);
  assert.match(audio, /mediaType == \.video \{ track.isEnabled = false/);
  assert.match(captions, /pictureInPictureControllerDidStopPictureInPicture[\s\S]*?finish\(reuse: true\)/);
  assert.match(captions, /if !reuse \|\| retiring \{/);
});
test('mobile release contains complete application assets and produces identical ZIP bytes twice', async () => {
  const build = () => execFileSync(process.execPath, ['mobile/scripts/build.mjs', '--release'], { cwd: root });
  build();
  const meta = JSON.parse(await read('web/mobile/manifest.json'));
  const zip = await read('web/mobile/' + meta.bundle);
  assert.equal(createHash('sha256').update(zip).digest('hex'), meta.checksum);
  assert.equal(zip.length, meta.size);
  const entries = unzipSync(zip);
  for (const name of ['index.html', 'player.html', 'js/home.js', 'js/main.js', 'native.js', 'native-bundle.json', 'js/native-caption-pip.js', 'js/native-audio.js']) {
    assert.ok(entries[name], name);
  }
  for (const dir of ['css', 'js', 'js/vendor']) {
    for (const file of await readdir(new URL('../web/' + dir, import.meta.url), { withFileTypes: true })) {
      if (file.isFile()) assert.ok(entries[dir + '/' + file.name], `missing ${dir}/${file.name}`);
    }
  }
  assert.equal(JSON.parse(Buffer.from(entries['native-bundle.json'])).version, meta.version);
  assert.match(Buffer.from(entries['index.html']).toString(), /await ready; await import\("\.\/js\/home.js"\)/);
  assert.ok(Object.keys(entries).every((p) => !p.startsWith('data/') && !p.startsWith('mobile/') && !p.includes('node_modules')));
  build();
  assert.deepEqual(JSON.parse(await read('web/mobile/manifest.json')), meta);
  assert.deepEqual(await read('web/mobile/' + meta.bundle), zip);
  const browser = unzipSync(await read('web/mobile/Lingua-web.zip'));
  assert.ok(browser['index.html'] && browser['js/home.js']);
  assert.equal(browser['native.js'], undefined);
  assert.equal(browser['assets/pip-black.mp4'], undefined);
  assert.equal(browser['js/caption-video.js'], undefined);
  assert.doesNotMatch(Buffer.from(browser['index.html']).toString(), /await ready/);
});
test('GitHub workflow exposes Android, signed iOS and update artifacts with no credentials required for PR checks', async () => {
  const workflow = parse((await read('.github/workflows/mobile.yml')).toString());
  assert.ok(workflow.on.workflow_dispatch !== undefined);
  assert.deepEqual(Object.keys(workflow.jobs), ['frontend', 'android', 'ios', 'publish']);
  for (const name of ['frontend', 'android', 'ios']) assert.ok(workflow.jobs[name].steps.some((s) => s.uses === 'actions/upload-artifact@v4'));
  assert.deepEqual(workflow.on.release.types, ['published']);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.equal(workflow.jobs.publish.permissions.contents, 'write');
  assert.deepEqual(workflow.jobs.publish.needs, ['frontend', 'android', 'ios']);
  assert.match(workflow.jobs.publish.if, /pull_request/);
  const androidSetup = workflow.jobs.android.steps.find((s) => s.uses === 'android-actions/setup-android@v3');
  assert.doesNotMatch(androidSetup.with.packages, /(?:^|\s)tools(?:\s|$)/);
  assert.match(androidSetup.with.packages, /platforms;android-36/);
  assert.match(androidSetup.with.packages, /build-tools;36\.0\.0/);
  const androidArtifact = workflow.jobs.android.steps.find((s) => s.uses === 'actions/upload-artifact@v4');
  assert.match(androidArtifact.with.path, /android\/dist\/Lingua\.apk/);
  assert.doesNotMatch(androidArtifact.with.path, /android\/dist\/Lingua\.aab/);
  const androidBuild = workflow.jobs.android.steps.find((s) => s.name === 'Build APKs');
  assert.match(androidBuild.run, /assembleDebug assembleRelease/);
  assert.doesNotMatch(androidBuild.run, /bundleRelease/);
  const ios = workflow.jobs.ios.steps.find((s) => s.name === 'Export signed IPA when credentials are configured');
  assert.match(ios.run, /IOS_CERTIFICATE_BASE64/);
  assert.match(ios.run, /mobile\/scripts\/ios-release\.py/);
  assert.ok(workflow.jobs.ios.env.IOS_CERTIFICATE_BASE64);
  const unsignedIpa = workflow.jobs.ios.steps.find((s) => s.name === 'Package unsigned IPA');
  assert.match(unsignedIpa.if, /hashFiles\('ios\/App\/build\/ipa\/Lingua\.ipa'\) == ''/);
  assert.match(unsignedIpa.env.APP_PATH, /Release-iphoneos\/App\.app/);
  assert.match(unsignedIpa.run, /mobile-artifacts\/Lingua\.ipa/);
  const signedIpa = workflow.jobs.ios.steps.find((s) => s.name === 'Collect signed IPA');
  assert.match(signedIpa.if, /hashFiles\('ios\/App\/build\/ipa\/Lingua\.ipa'\) != ''/);
  assert.match(signedIpa.run, /mobile-artifacts\/Lingua\.ipa/);
  const config = JSON.parse(await read('capacitor.config.json'));
  assert.equal(config.plugins.CapacitorUpdater.autoUpdate, false);
  assert.equal(config.plugins.CapacitorUpdater.statsUrl, '');
  assert.equal(config.server.url, undefined);
  assert.equal(config.appName, 'Lingua');
  assert.equal(config.ios.contentInset, 'never');
});
