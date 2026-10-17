/* Local Supertonic 3 adapter, based on Supertone's MIT web/helper.js at
 * 1e9799e964ea4c0dad7cde993b65c3c813a7b373. Uses flat typed arrays, bounded
 * durations and no fetch in the worker. See vendor/supertonic/NOTICE.md.
 */
async function supertonicSpeech(text, lang, assets, shared) {
  const decode = (bytes) => JSON.parse(new TextDecoder().decode(bytes));
  const config = decode(shared.config), indexer = decode(shared.indexer), voice = decode(assets.style);
  const sessions = [];
  const tensor = (type, data, dims) => new ort.Tensor(type, data, dims);
  try {
    for (const key of ['duration', 'encoder', 'vector', 'vocoder']) {
      sessions.push(await ort.InferenceSession.create(shared[key], { executionProviders: ['wasm'] }));
    }
    const [durationModel, encoder, vector, vocoder] = sessions;
    const styleTTL = tensor('float32', Float32Array.from(voice.style_ttl.data.flat(Infinity)), voice.style_ttl.dims);
    const styleDP = tensor('float32', Float32Array.from(voice.style_dp.data.flat(Infinity)), voice.style_dp.dims);
    const rate = config.ae.sample_rate, chunks = [], steps = 5;
    const chunkSize = config.ae.base_chunk_size * config.ttl.chunk_compress_factor;
    const latentDim = config.ttl.latent_dim * config.ttl.chunk_compress_factor;
    if (!Number.isFinite(rate) || rate < 8000 || rate > 192000 || !Number.isInteger(latentDim) || latentDim <= 0
      || latentDim > 1024 || !Number.isInteger(chunkSize) || chunkSize <= 0) throw Error('语音包模型配置无效');
    let frames = 0;
    for (const textChunk of supertonicChunks(text)) {
      const ids = supertonicIds(textChunk, lang, indexer), length = ids.length;
      const textIds = tensor('int64', ids, [1, length]);
      const textMask = tensor('float32', new Float32Array(length).fill(1), [1, 1, length]);
      const prediction = await durationModel.run({ text_ids: textIds, style_dp: styleDP, text_mask: textMask });
      const seconds = prediction.duration.data[0];
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 30 || frames + Math.floor(seconds * rate) > rate * 30) {
        throw Error('语音包预计音频超过 30 秒，请缩短发音文本');
      }
      const encoded = await encoder.run({ text_ids: textIds, style_ttl: styleTTL, text_mask: textMask });
      const latentLen = Math.ceil(Math.floor(seconds * rate) / chunkSize);
      let latent = new Float32Array(latentDim * latentLen);
      for (let i = 0; i < latent.length; i++) {
        latent[i] = Math.sqrt(-2 * Math.log(Math.max(.0001, Math.random()))) * Math.cos(2 * Math.PI * Math.random());
      }
      const latentMask = tensor('float32', new Float32Array(latentLen).fill(1), [1, 1, latentLen]);
      const totalStep = tensor('float32', Float32Array.of(steps), [1]);
      for (let step = 0; step < steps; step++) {
        const output = await vector.run({ noisy_latent: tensor('float32', latent, [1, latentDim, latentLen]),
          text_emb: encoded.text_emb, style_ttl: styleTTL, latent_mask: latentMask, text_mask: textMask,
          current_step: tensor('float32', Float32Array.of(step), [1]), total_step: totalStep });
        latent = output.denoised_latent.data;
      }
      const generated = await vocoder.run({ latent: tensor('float32', latent, [1, latentDim, latentLen]) });
      // Vocoder pads to complete latent chunks. Crop to the predicted speech duration.
      const count = Math.floor(seconds * rate);
      if (!(generated.wav_tts.data instanceof Float32Array) || generated.wav_tts.data.length < count) throw Error('语音包输出音频不完整');
      if (chunks.length) { const silence = new Float32Array(Math.floor(rate * .15)); chunks.push(silence); frames += silence.length; }
      const pcm = generated.wav_tts.data.slice(0, count);
      chunks.push(pcm); frames += pcm.length;
      if (frames > rate * 30) throw Error('语音包音频超过 30 秒，请缩短文本');
    }
    const samples = new Float32Array(frames); let at = 0;
    for (const chunk of chunks) { samples.set(chunk, at); at += chunk.length; }
    return { samples, sampleRate: rate };
  } finally { for (const session of sessions) await session.release(); }
}
