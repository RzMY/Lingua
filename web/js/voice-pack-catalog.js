/** Curated offline TTS models. Revisions, origins and digests are immutable. */
export const VOICE_REVISION = 'c10ece1aade47bb51c153c893d14e5bf8e5b7117';
export const VOICE_HOSTS = Object.freeze({
  official: 'https://huggingface.co/rhasspy/piper-voices/resolve/',
  mirror: 'https://hf-mirror.com/rhasspy/piper-voices/resolve/',
});
const pack = (id, name, lang, hash, configHash, configSize, license) => {
  const [locale, speaker, quality] = id.split('-');
  return Object.freeze({ id, name, lang, license, engine: 'piper', revision: VOICE_REVISION, size: 63201294, configSize, hash, configHash,
    path: `${lang.split('-')[0]}/${locale}/${speaker}/${quality}/${id}.onnx` });
};
export const SUPERTONIC_REVISION = 'aafc6e32416a594460b32413efc49d7fe4ce6d46';
export const SUPERTONIC_GROUP = 'models:supertonic3-int8-v1';
export const SUPERTONIC_RUNTIME_KEY = 'runtime:ort-1.18';
const compressedRepo = 'csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11';
const compressedRevision = 'cca5a0e6c96e1d2c720986bf7e75fcc81dee3ae4';
const supertonicRepo = 'supertone-oss-archive/supertonic-3';
const sharedFile = (key, path, size, hash, compressed = false) => Object.freeze({ key, path, size, hash,
  repo: compressed ? compressedRepo : supertonicRepo, revision: compressed ? compressedRevision : SUPERTONIC_REVISION });
export const SUPERTONIC_FILES = Object.freeze([
  sharedFile('duration', 'duration_predictor.int8.onnx', 3700147, 'c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db', true),
  sharedFile('encoder', 'text_encoder.int8.onnx', 36416150, 'c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff', true),
  sharedFile('vector', 'vector_estimator.int8.onnx', 78400833, '20cd86fa5c6effedfda0e7cffe5b0569ca401c440a0c3a1d72bf39286c0db3fd', true),
  sharedFile('vocoder', 'vocoder.int8.onnx', 25991073, 'e923d60f53f95eb1ce235f1dc33ec56d9c057823c96fa6f8acf98f32b0da6152', true),
  sharedFile('config', 'onnx/tts.json', 8253, '42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09'),
  sharedFile('indexer', 'onnx/unicode_indexer.json', 277676, '9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f'),
  sharedFile('license', 'LICENSE', 15007, '0d944a9110fed9a9602d60e0423a272903e7bd21ab060490774efc77c2275e9f'),
]);
const supertonic = (lang, gender) => {
  const female = gender === 'female';
  const style = sharedFile('style', `voice_styles/${female ? 'F1' : 'M1'}.json`, female ? 292046 : 291748,
    female ? 'bbdec6ee00231c2c742ad05483df5334cab3b52fda3ba38e6a07059c4563dbc2' : 'e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b');
  return Object.freeze({ id: `${lang.replace('-', '_')}-supertonic3-${gender}`, name: `Supertonic 3 · ${female ? '女声' : '男声'}`,
    lang, engine: 'supertonic', revision: SUPERTONIC_REVISION, license: 'OpenRAIL-M（含用途限制）', style,
    size: style.size, group: SUPERTONIC_GROUP,
    modelCard: `https://huggingface.co/${supertonicRepo}/blob/${SUPERTONIC_REVISION}/README.md`,
    licenseURL: `https://huggingface.co/${supertonicRepo}/blob/${SUPERTONIC_REVISION}/LICENSE` });
};
export const VOICE_PACKS = Object.freeze([
  pack('en_US-lessac-medium', 'Lessac', 'en-US',
    '5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f',
    'efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0', 4885, 'Lessac 数据集许可'),
  pack('en_GB-alba-medium', 'Alba', 'en-GB',
    '401369c4a81d09fdd86c32c5c864440811dbdcc66466cde2d64f7133a66ad03b',
    'aa965a2f02ecced632c2694e1fc72bbff6d65f265fab567ca945918c73dd89f4', 4888, 'CC BY 4.0'),
  pack('fr_FR-siwis-medium', 'Siwis', 'fr-FR',
    '641d1ab097da2b81128c076810edb052b385decc8be3381814802a64a73baf99',
    '39479916c2db192b5ac9764daddd0c744d83e023ad890c6976c0633ae4df8959', 4875, 'CC BY 4.0'),
  pack('de_DE-thorsten-medium', 'Thorsten', 'de-DE',
    '7e64762d8e5118bb578f2eea6207e1a35a8e0c30595010b666f983fc87bb7819',
    '974adee790533adb273a1ac88f49027d2a1b8f0f2cf4905954a4791e79264e85', 4819, 'CC0'),
  pack('es_ES-davefx-medium', 'Davefx', 'es-ES',
    '6658b03b1a6c316ee4c265a9896abc1393353c2d9e1bca7d66c2c442e222a917',
    '0e0dda87c732f6f38771ff274a6380d9252f327dca77aa2963d5fbdf9ec54842', 4817, 'CC0'),
  supertonic('ja-JP', 'female'), supertonic('ja-JP', 'male'),
  supertonic('ko-KR', 'female'), supertonic('ko-KR', 'male'),
]);
export const packKey = (id) => `pack:${id}`;
export const packId = (key) => typeof key === 'string' && key.startsWith('pack:') ? key.slice(5) : '';
export const findVoicePack = (id) => VOICE_PACKS.find((item) => item.id === id);
export const packsForLanguage = (lang) => VOICE_PACKS.filter((item) => item.lang.split('-')[0] === lang.split('-')[0]);
export const voiceModelCard = (item) => item.modelCard || `${VOICE_HOSTS.official}${VOICE_REVISION}/${item.path.replace(/[^/]+$/, 'MODEL_CARD')}`;
export const voiceFileURL = (file, source) => `${source === 'mirror' ? 'https://hf-mirror.com' : 'https://huggingface.co'}/${file.repo}/resolve/${file.revision}/${file.path}`;
export const VOICE_RUNTIME_KEY = 'runtime:piper-1-ort-1.18';
const piper = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize';
export const VOICE_RUNTIME_FILES = Object.freeze([
  { key: 'phonemizer', url: `${piper}.wasm`, size: 635212,
    hash: 'b777cd107a91d2bcc6a1ea46f2c26a662a7407394fe84589198aeaa83dd7a9d6' },
  { key: 'data', url: `${piper}.data`, size: 18077249,
    hash: '29f1025eb23a5b5c192cd14a6efbce4509402ff265405072ee6f7d1a09b78f8c' },
  { key: 'onnx', url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort-wasm.wasm', size: 9758086,
    hash: 'ebe7ec327f83aabc07e3b58487522481ccff10941f24182ab0428d0123652ff2' },
]);
export const SUPERTONIC_SIMD_FILE = Object.freeze({ key: 'onnx',
  url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort-wasm-simd.wasm', size: 10595041,
  hash: 'f533b5f21790563d7556c611c3835ac65848ee326da2689aac54ed7d9cc8c6a4' });
