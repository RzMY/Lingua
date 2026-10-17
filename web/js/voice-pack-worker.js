/* Concatenated after local runtime and model helpers in a same-origin Blob worker. */
onmessage = async ({ data: { text, config, model, runtime, engine, lang, assets, shared } }) => {
  let session, onnxURL;
  try {
    // Single-thread WASM needs neither cross-origin isolation nor SharedArrayBuffer.
    ort.env.wasm.numThreads = 1; ort.env.wasm.simd = runtime.simd === true; ort.env.wasm.proxy = false;
    // ORT 1.18 accepts wasmPaths, not env.wasm.wasmBinary.
    onnxURL = URL.createObjectURL(new Blob([runtime.onnx], { type: 'application/wasm' }));
    ort.env.wasm.wasmPaths = { [runtime.simd ? 'ort-wasm-simd.wasm' : 'ort-wasm.wasm']: onnxURL };
    if (engine === 'supertonic') {
      const output = await supertonicSpeech(text, lang, assets, shared);
      postMessage(output, [output.samples.buffer]); return;
    }
    const ids = [];
    const phonemizer = await createPiperPhonemize({
      wasmBinary: new Uint8Array(runtime.phonemizer), getPreloadedPackage: () => runtime.data,
      print: (line) => ids.push(...JSON.parse(line).phoneme_ids),
      printErr: () => {},
    });
    phonemizer.callMain(['-l', config.espeak.voice, '--input', JSON.stringify([{ text: text.trim() }]), '--espeak_data', '/espeak-ng-data']);
    if (!ids.length || ids.length > 16000) throw Error('语音包无法解析发音文本');
    session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
    const inputs = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.of(BigInt(ids.length)), [1]),
      scales: new ort.Tensor('float32', Float32Array.of(config.inference.noise_scale, config.inference.length_scale, config.inference.noise_w), [3]),
    };
    if (session.inputNames.includes('sid')) inputs.sid = new ort.Tensor('int64', BigInt64Array.of(0n), [1]);
    const output = await session.run(inputs);
    const samples = output.output?.data, sampleRate = config.audio.sample_rate;
    if (!(samples instanceof Float32Array) || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000
      || !samples.length || samples.length > sampleRate * 30) throw Error('语音包合成音频格式无效或超过 30 秒');
    postMessage({ samples, sampleRate }, [samples.buffer]);
  } catch (error) { postMessage({ error: error?.message || '语音包合成失败' }); }
  finally { await session?.release(); if (onnxURL) URL.revokeObjectURL(onnxURL); }
};
