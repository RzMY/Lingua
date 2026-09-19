import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const permissions = JSON.parse(await readFile(resolve(root, 'mobile/permissions.json'), 'utf8'));
const android = [], ios = [];
if (permissions.microphone) {
  android.push('<uses-permission android:name="android.permission.RECORD_AUDIO" />',
    '<uses-feature android:name="android.hardware.microphone" android:required="false" />');
  ios.push('<key>NSMicrophoneUsageDescription</key><string>在你主动开始录音练习或语音输入时使用麦克风。</string>');
}
if (permissions.camera) {
  android.push('<uses-permission android:name="android.permission.CAMERA" />',
    '<uses-feature android:name="android.hardware.camera" android:required="false" />');
  ios.push('<key>NSCameraUsageDescription</key><string>在你主动拍摄学习素材或扫描导入码时使用摄像头。</string>');
}
if (permissions.photoLibrary) {
  // Current imports use the system document picker and do not need these permissions.
  android.push('<uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />',
    '<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />',
    '<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />',
    '<uses-permission android:name="android.permission.READ_MEDIA_VISUAL_USER_SELECTED" />',
    '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />');
  ios.push('<key>NSPhotoLibraryUsageDescription</key><string>在你选择从相册导入学习素材时读取所选照片和视频。</string>',
    '<key>NSPhotoLibraryAddUsageDescription</key><string>在你选择保存学习素材到相册时写入媒体文件。</string>');
}
if (permissions.notifications) android.push('<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />');
for (const [file, lines] of [['android/app/src/main/AndroidManifest.xml', android], ['ios/App/App/Info.plist', ios]]) {
  const path = resolve(root, file);
  let text = await readFile(path, 'utf8');
  const block = `<!-- BEGIN OPTIONAL PERMISSIONS -->\n${lines.join('\n')}\n<!-- END OPTIONAL PERMISSIONS -->`;
  if (text.includes('<!-- BEGIN OPTIONAL PERMISSIONS -->')) {
    text = text.replace(/<!-- BEGIN OPTIONAL PERMISSIONS -->[\s\S]*?<!-- END OPTIONAL PERMISSIONS -->/, block);
  } else {
    const end = file.endsWith('.xml') ? '</manifest>' : '</dict>\n</plist>';
    // Normalize newlines to make this insertion deterministic on Windows and CI.
    text = text.replaceAll('\r\n', '\n').replace(end, block + '\n' + end);
  }
  await writeFile(path, text);
}
console.log('Native permission declarations updated; runtime prompts remain user-initiated.');
