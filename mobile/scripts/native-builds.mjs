import { readFile } from 'node:fs/promises';

export function nativeBuildsFromSources(android, ios) {
  const androidBuilds = [...android.matchAll(/^\s*versionCode\s+(\d+)\s*$/gm)].map((match) => Number(match[1]));
  const iosBuilds = [...ios.matchAll(/^\s*CURRENT_PROJECT_VERSION\s*=\s*(\d+);\s*$/gm)].map((match) => Number(match[1]));
  if (androidBuilds.length !== 1 || !iosBuilds.length
      || ![...androidBuilds, ...iosBuilds].every((value) => Number.isSafeInteger(value) && value > 0)
      || iosBuilds.some((value) => value !== iosBuilds[0])) {
    throw Error('Native build versions must be positive integers and identical across iOS configurations');
  }
  return { android: androidBuilds[0], ios: iosBuilds[0] };
}

export async function readNativeBuilds(root = new URL('../../', import.meta.url)) {
  const [android, ios] = await Promise.all([
    readFile(new URL('android/app/build.gradle', root), 'utf8'),
    readFile(new URL('ios/App/App.xcodeproj/project.pbxproj', root), 'utf8'),
  ]);
  return nativeBuildsFromSources(android, ios);
}
