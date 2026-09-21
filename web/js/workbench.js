import { config, setConfig } from './config.js';
import { el, icon, fmtSize, fmtTime } from './util.js';
import { sectionTitle, inputField, textField, button, buttonBar, switchRow, group, segRow } from './rows.js';
import { extractMedia, convertMedia, transcribe, parseExtraParams } from './workbench-media.js';
import { createPreparedTrack, savePreparedTranscript, saveAnalysis, patchTrack, listTracks } from './library.js';
import { openSheet, closeSheet } from './sheet.js';
import { analyze } from './api.js';
import { sourceLangs } from './langs.js';
import { saveFile } from './native.js';

/** Mount once per enabled session so switching tabs preserves in-progress work. */
export function mountWorkbench(root, { onImport = () => {} } = {}) {
  let disposed = false;
  let conversion = null, request = null, converted = null, audioFile = null, result = null;
  let master = null, saving = false, imported = null, optionsOpen = false;
  let targetsRevision = 0;
  let targetTracks = [], targetOpen = false;
  const temporary = new Set();
  const keepMedia = (output) => { if (output.release) temporary.add(output); return output; };
  const savedTargets = new Set();
  let importLang = config.importLang || 'ja';
  let analyzeImport = false;
  let previewUrl = '', prompt = typeof config.asrPrompt === 'string' ? config.asrPrompt : '';
  let wordTimestamps = !!config.asrWordTimestamps;
  const savedParams = Array.isArray(config.asrExtraParams) ? config.asrExtraParams.filter((p) =>
    p && typeof p.key === 'string' && typeof p.value === 'string') : [];
  const extraParams = [];
  let extraError = '';
  const urls = new Set();
  const urlFor = (blob) => { const url = URL.createObjectURL(blob); urls.add(url); return url; };
  const download = (file) => {
    saveFile(file, file.name).catch((error) => alert('导出失败：' + error.message));
  };
  const status = () => {
    const node = el('p', 'pane-note');
    node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite');
    return node;
  };
  const picker = (label, accept) => {
    const field = el('div', 'workbench-file');
    const input = el('input'); input.type = 'file'; input.accept = accept; input.hidden = true;
    input.setAttribute('aria-label', label);
    const trigger = el('button', 'workbench-file-pick'); trigger.type = 'button';
    trigger.setAttribute('aria-label', label);
    const glyph = el('span', 'workbench-file-icon'); glyph.append(icon('i-upload'));
    const copy = el('span', 'workbench-file-copy');
    const name = el('b', null, label), hint = el('span', null, '点击选择或拖放文件');
    copy.append(name, hint);
    trigger.append(glyph, copy, icon('i-plus', 'ic ic-sm'));
    trigger.addEventListener('click', () => input.click());
    field.showFile = (file, referenced = false) => {
      name.textContent = file?.name || label;
      name.title = file?.name || '';
      hint.textContent = file ? `${fmtSize(file.size)}${referenced ? ' · 已引用' : ''}` : '点击选择或拖放文件';
      field.classList.toggle('has-file', !!file);
    };
    field.setDisabled = (disabled) => { input.disabled = trigger.disabled = disabled; };
    input.addEventListener('change', () => field.showFile(input.files[0]));
    trigger.addEventListener('dragover', (event) => {
      event.preventDefault(); if (!input.disabled) field.classList.add('is-dragging');
    });
    trigger.addEventListener('dragleave', () => field.classList.remove('is-dragging'));
    trigger.addEventListener('drop', (event) => {
      event.preventDefault(); field.classList.remove('is-dragging');
      if (input.disabled || !event.dataTransfer?.files.length) return;
      const transfer = new DataTransfer(); transfer.items.add(event.dataTransfer.files[0]);
      input.files = transfer.files; input.dispatchEvent(new Event('change'));
    });
    field.input = input; field.append(input, trigger);
    return field;
  };
  const card = (title) => {
    const node = el('section', 'workbench-card');
    const [step, label] = title.split(' / ');
    const heading = el('div', 'workbench-heading');
    heading.append(el('span', 'workbench-step', step), sectionTitle(label)); node.append(heading); return node;
  };
  const pairedButtons = (...buttons) => {
    const bar = buttonBar(...buttons); bar.classList.add('workbench-actions'); return bar;
  };
  const videoCard = card('01 / 提取无损聆听音频');
  const video = picker('选择视频或音频', 'video/*,audio/*,.mp4,.webm,.mov,.mkv,.wav,.mp3,.m4a,.flac');
  const conversionNote = status();
  const preview = el('audio', 'workbench-audio'); preview.controls = true; preview.hidden = true; preview.preload = 'none';
  const saveAudio = button('下载音频', { onPick: () => master && download(master.file) });
  saveAudio.title = '可选：下载无损聆听音频';
  const proxyCard = card('02 / 生成 ASR 音频');
  const proxyNote = status();
  const useAudio = button('生成 16 kHz 音频', { main: true, onPick: async () => {
    if (!master || conversion || request || saving) return;
    const controller = new AbortController(); conversion = controller; update();
    try {
      const output = await convertMedia(master, { signal: controller.signal,
        onStage: (text) => { if (!disposed) proxyNote.textContent = text; } });
      if (disposed || controller.signal.aborted) { await output.release?.(); return; }
      converted = keepMedia(output);
      audioFile = converted.file; audio.input.value = ''; clearResult();
      audio.showFile(audioFile, true);
      proxyNote.textContent = `已生成 · 16 kHz MP3 · ${converted.bitrate} kbps · ${converted.channels} 声道 · ${fmtSize(audioFile.size)}`;
      audioNote.textContent = '';
    } catch (err) { if (!disposed) proxyNote.textContent = controller.signal.aborted ? '已取消' : err.message; }
    finally { conversion = null; if (!disposed) update(); }
  } });
  const proxyDownload = button('下载 MP3', { onPick: () => converted && download(converted.file) });
  proxyDownload.title = '可选：下载 16 kHz ASR 音频';
  proxyCard.append(proxyNote, pairedButtons(useAudio, proxyDownload));
  const convert = button('提取聆听音频', { main: true, onPick: async () => {
    if (conversion || !video.input.files[0]) return;
    const controller = new AbortController(); conversion = controller; update();
    try {
      const output = await extractMedia(video.input.files[0], { signal: controller.signal,
        onStage: (text) => { if (!disposed) conversionNote.textContent = text; } });
      if (disposed || controller.signal.aborted) { await output.release?.(); return; }
      master = keepMedia(output);
      saveAudio.textContent = /\.m4a$/i.test(output.file.name) ? '下载 M4A' : '下载 WAV';
      if (previewUrl) { URL.revokeObjectURL(previewUrl); urls.delete(previewUrl); }
      preview.src = previewUrl = urlFor(output.file); preview.hidden = false;
      conversionNote.textContent = `聆听音频已就绪 · ${output.sampleRate / 1000} kHz · ${output.channels} 声道 · ${fmtTime(output.duration)} · ${fmtSize(output.file.size)}`;
      chooseAudio(master.file);
    } catch (err) {
      if (!disposed) conversionNote.textContent = controller.signal.aborted ? '已取消转换' : err.message;
    } finally { conversion = null; if (!disposed) update(); }
  } });
  video.input.addEventListener('change', () => {
    for (const output of temporary) output.release?.();
    temporary.clear();
    master = converted = audioFile = imported = null; clearResult();
    audioImportNote.textContent = ''; target.value = '';
    saveAudio.textContent = '下载音频';
    audio.input.value = ''; audioNote.textContent = '';
    audio.showFile(null);
    proxyNote.textContent = '';
    preview.pause(); preview.removeAttribute('src'); preview.load(); preview.hidden = true;
    if (previewUrl) { URL.revokeObjectURL(previewUrl); urls.delete(previewUrl); previewUrl = ''; }
    conversionNote.textContent = '';
    update();
  });

  const asrCard = card('03 / 语音转录');
  const options = el('div', 'pane workbench-options');
  const optionsButton = button('', { onPick: () => {
    openSheet('转录接口配置', options, { cls: 'sheet-tall', onClose: () => {
      optionsOpen = false; optionsButton.setAttribute('aria-expanded', 'false');
      if (!disposed) { update(); optionsButton.focus(); }
    } });
    optionsOpen = true; optionsButton.setAttribute('aria-expanded', 'true');
  } });
  optionsButton.className = 'workbench-entry'; optionsButton.setAttribute('aria-label', '转录接口配置');
  const settingsCopy = el('span', 'workbench-entry-copy');
  const settingsHint = el('span', null, '接口、模型与输出格式');
  settingsCopy.append(el('b', null, '转录接口配置'), settingsHint);
  const settingsGlyph = el('span', 'workbench-entry-icon'); settingsGlyph.append(icon('i-tune'));
  optionsButton.append(settingsGlyph, settingsCopy, icon('i-chev', 'ic ic-sm'));
  optionsButton.setAttribute('aria-haspopup', 'dialog'); optionsButton.setAttribute('aria-expanded', 'false');
  const fields = [
    ['接口地址', 'asrBaseUrl', { placeholder: 'https://api.example.com/v1', hint: '支持服务根地址、/v1 或完整 /audio/transcriptions 地址' }],
    ['API Key', 'asrApiKey', { secret: true, hint: '保存在当前浏览器，仅发送给上面的转录接口；无鉴权服务可留空' }],
    ['模型', 'asrModel', { placeholder: 'whisper-1' }],
    ['语言', 'asrLanguage', { placeholder: '自动识别', hint: '可选，例如 ja、en、zh' }],
    ['超时（秒）', 'asrTimeout', { type: 'number' }],
  ];
  for (const [label, key, attrs] of fields) {
    const field = inputField(label, { ...attrs, value: config[key],
      onInput: (v) => setConfig({ [key]: key === 'asrTimeout' ? Number(v) : v }) });
    if (key === 'asrTimeout') { field.input.min = 1; field.input.max = 3600; }
    options.append(field);
  }
  const formatField = segRow('结果格式', '同步字幕请选择详细 JSON、SRT 或 VTT', () => config.asrFormat,
    (v) => { setConfig({ asrFormat: v }); update(); },
    [['verbose_json', '详细 JSON'], ['json', 'JSON'], ['srt', 'SRT'], ['vtt', 'VTT'], ['text', '纯文本']], { wrap: true });
  formatField.classList.add('workbench-choice');
  const wordRow = switchRow('词级时间戳', '仅详细 JSON 可选，需要模型支持',
    () => wordTimestamps, (v) => { wordTimestamps = !!v; setConfig({ asrWordTimestamps: wordTimestamps }); });
  wordRow.classList.add('workbench-toggle');
  const extraStatus = el('p', 'workbench-error'); extraStatus.hidden = true;
  extraStatus.id = 'workbenchExtraError'; extraStatus.setAttribute('role', 'status');
  const custom = el('div', 'workbench-custom');
  const paramList = el('div', 'workbench-params');
  const paramControls = new Map();
  function validateParams(persist = true) {
    if (persist) setConfig({ asrExtraParams: extraParams.map((param) => ({ ...param })) });
    try {
      parseExtraParams(extraParams);
      for (const [param, controls] of paramControls) {
        controls.value.disabled = !!request || !param.enabled;
        if (param.enabled && controls.value.type === 'number' &&
            (!controls.value.value || !controls.value.checkValidity())) {
          throw new Error(`自定义参数 ${param.key} 请填写有效数值`);
        }
      }
      extraError = '';
    } catch (err) { extraError = err.message; }
    extraStatus.textContent = extraError; extraStatus.hidden = !extraError; update();
  }
  function addParam(key = '', value = '', hint = '', attrs = {}, saved = null, initializing = false) {
    const preset = !!hint;
    if (preset) saved = savedParams.find((p) => p.preset === true && p.key === key);
    const param = { key, value: saved ? saved.value : String(value), enabled: saved ? !!saved.enabled : !preset, preset };
    extraParams.push(param);
    const row = el('div', 'workbench-param');
    const toggle = switchRow(preset ? `启用 ${key}` : '启用自定义参数', hint,
      () => param.enabled, (v) => { param.enabled = !!v; validateParams(); });
    const inputs = el('div', 'workbench-param-inputs');
    const keyField = inputField('参数名', { value: key, placeholder: '例如 hotwords', onInput: (v) => {
      param.key = v; validateParams();
    } });
    keyField.input.readOnly = preset;
    const valueField = inputField('参数值', { value: param.value, type: typeof value === 'number' ? 'number' : 'text',
      placeholder: '填写参数值', onInput: (v) => { param.value = v; validateParams(); } });
    for (const [name, setting] of Object.entries(attrs)) valueField.input.setAttribute(name, setting);
    for (const input of [keyField.input, valueField.input]) input.setAttribute('aria-describedby', extraStatus.id);
    inputs.append(keyField, valueField);
    if (!preset) inputs.append(button('删除', { onPick: () => {
      extraParams.splice(extraParams.indexOf(param), 1); paramControls.delete(param); row.remove();
      validateParams(); addParamButton.focus();
    } }));
    row.append(toggle, inputs); paramList.append(row);
    paramControls.set(param, { key: keyField.input, value: valueField.input });
    if (!preset && !initializing) { validateParams(); keyField.input.focus(); }
  }
  addParam('batch_size', 24, '批处理大小', { min: 1, step: 1 });
  addParam('vad_method', 'pyannote_v3', '语音活动检测方法');
  addParam('vad_filter', true, '过滤非语音片段');
  addParam('condition_on_previous_text', false, '使用前文作为转录上下文');
  addParam('beam_size', 5, '束搜索大小', { min: 1, step: 1 });
  addParam('temperature', 0, '采样温度', { min: 0, max: 1, step: 'any' });
  addParam('no_speech_threshold', 0.5, '无语音概率阈值', { min: 0, max: 1, step: 'any' });
  for (const saved of savedParams.filter((p) => !p.preset)) addParam(saved.key, saved.value, '', {}, saved, true);
  const addParamButton = button('新增键值对', { glyph: 'i-plus', onPick: () => addParam() });
  custom.append(sectionTitle('高级与自定义参数'),
    el('p', 'field-hint', '打开开关后才会发送该参数。配置自动保存在当前浏览器，请按接口支持情况启用；参数名无需填写 --。'),
    paramList, extraStatus, buttonBar(addParamButton));
  options.append(formatField, wordRow, textField('提示词（可选）', { rows: 3, value: prompt,
    hint: '专有名词或上下文，自动保存在当前浏览器',
    onInput: (v) => { prompt = v; setConfig({ asrPrompt: v }); } }), custom);
  const audio = picker('选择待转录音频', 'audio/*,.wav,.mp3,.m4a,.flac,.ogg,.webm,.mp4');
  const audioNote = status();
  function chooseAudio(file) {
    if (!file) return;
    audioFile = file; audio.input.value = ''; clearResult();
    audio.showFile(file, true);
    audioNote.textContent = '';
    target.value = imported?.id || ''; update();
  }
  const useMaster = button('聆听原音频', { onPick: () => chooseAudio(master?.file) });
  const useProxy = button('16 kHz 副本', { onPick: () => chooseAudio(converted?.file) });
  const sourceChoice = el('div', 'workbench-source-choice');
  sourceChoice.append(el('span', null, '引用已有音频'), pairedButtons(useMaster, useProxy));
  audio.input.addEventListener('change', () => {
    audioFile = audio.input.files[0] || null; clearResult();
    target.value = '';
    audioNote.textContent = ''; update();
  });
  const start = button('开始转录', { main: true, onPick: async () => {
    if (request || !audioFile || extraError) return;
    const controller = new AbortController(); request = controller;
    clearResult();
    audioNote.textContent = '正在上传音频并等待转录结果…'; update();
    try {
      const output = await transcribe(audioFile, { ...config, prompt, wordTimestamps, extraParams }, { signal: controller.signal });
      if (disposed || controller.signal.aborted) return;
      result = output;
      resultField.input.value = output.content;
      audioNote.replaceChildren(el('span', null, '转录完成 · '));
      const resultName = el('span', 'workbench-filename', output.file.name);
      resultName.title = output.file.name; audioNote.append(resultName);
      await refreshTargets(audioFile === converted?.file || audioFile === master?.file ? imported?.id : target.value);
      if (disposed) return;
      importNote.textContent = hasSubtitle() ? '可将字幕导入下方对应音频；已有字幕将被替换。'
        : '当前结果没有可导入的时间戳，请改用详细 JSON、SRT 或 VTT 重新转录。';
    } catch (err) {
      if (!disposed) audioNote.textContent = controller.signal.aborted ? '已取消转录' : err.message;
    } finally { request = null; if (!disposed) update(); }
  } });
  const resultField = textField('转录结果', { rows: 10 }); resultField.input.readOnly = true;
  const saveTranscript = button('下载转录结果', { onPick: () => result && download(result.file) });
  asrCard.append(el('p', 'field-hint', '开始转录后，音频将发送至你配置的服务。'),
    optionsButton, sourceChoice, audio, audioNote, buttonBar(start), resultField, buttonBar(saveTranscript));

  const importNote = status();
  const audioImportNote = status();
  const addAudio = button('添加音频到首页', { onPick: async () => {
    if (!master || imported || saving || conversion || request) return;
    saving = true; update();
    try {
      audioImportNote.textContent = '正在保存聆听音频…';
      imported = await createPreparedTrack(master.file, null, {
        title: master.file.name.replace(/(?:\.lossless)?\.[^.]+$/, ''),
        lang: importLang, duration: master.duration,
        onStage: (text) => { if (!disposed) audioImportNote.textContent = text; } });
      await onImport();
      if (disposed) return;
      audioImportNote.textContent = '聆听音频已添加到首页。';
      await refreshTargets(imported.id);
    } catch (err) { if (!disposed) audioImportNote.textContent = '添加失败：' + err.message; }
    finally { saving = false; if (!disposed) update(); }
  } });
  const languageRow = group(segRow('字幕源语言', '', () => importLang,
    (v) => { importLang = v; }, sourceLangs().map((l) => [l.code, l.name]), { wrap: true }));
  languageRow.classList.add('workbench-languages');
  const extractActions = pairedButtons(convert, addAudio, saveAudio);
  extractActions.classList.add('workbench-extract-actions');
  videoCard.append(video, extractActions, conversionNote, preview, audioImportNote);
  const targetField = el('div', 'field workbench-target-field');
  targetField.append(el('span', 'field-label', '对应的首页音频'));
  const target = button('', { onPick: async () => {
    if (targetOpen) return;
    const list = el('div', 'workbench-track-list');
    list.append(el('p', 'pane-note', '正在读取音频列表…'));
    openSheet('选择对应音频', list, { cls: 'sheet-tall', onClose: () => {
      targetOpen = false; if (!disposed) target.focus();
    } }); targetOpen = true;
    const loaded = await refreshTargets(target.value);
    if (disposed || !targetOpen || !list.isConnected) return;
    list.replaceChildren();
    if (!loaded) {
      list.append(el('p', 'pane-note', '读取音频列表失败，请关闭后重新展开。'));
      return;
    }
    if (!targetTracks.length) list.append(el('p', 'pane-note', '首页还没有音频，请先在第一步添加。'));
    for (const track of targetTracks) {
      const row = button('', { onPick: () => { target.value = track.id; closeSheet(); update(); } });
      row.className = 'workbench-track-option'; row.setAttribute('aria-pressed', String(target.value === track.id));
      const copy = el('span', 'workbench-entry-copy');
      const trackTitle = el('b', null, track.title), filename = el('span', null, track.audio?.name || track.id);
      trackTitle.title = track.title; filename.title = filename.textContent;
      copy.append(trackTitle, filename);
      row.append(icon('i-wave'), copy, icon(target.value === track.id ? 'i-check' : 'i-plus', 'ic ic-sm'));
      list.append(row);
    }
  } });
  target.value = ''; target.className = 'workbench-target';
  target.setAttribute('aria-label', '对应的首页音频'); target.setAttribute('aria-haspopup', 'dialog');
  const targetCopy = el('span', 'workbench-entry-copy'), targetName = el('b', null, '选择首页音频');
  const targetHint = el('span', null, '将字幕保存到已有音频');
  targetCopy.append(targetName, targetHint); target.append(icon('i-wave'), targetCopy, icon('i-chev-d', 'ic ic-sm'));
  const targetBar = el('div', 'workbench-target-bar'); targetBar.append(target);
  targetField.append(targetBar, el('p', 'field-hint', '导入将替换已有字幕。'));
  async function refreshTargets(preferred = target.value) {
    const revision = ++targetsRevision;
    try {
      const tracks = await listTracks();
      if (disposed || revision !== targetsRevision) return;
      targetTracks = tracks;
      target.value = tracks.some((track) => track.id === preferred) ? preferred : '';
      update();
      return true;
    } catch (err) { if (!disposed) importNote.textContent = '读取音频列表失败：' + err.message; }
  }
  const add = button('导入字幕到对应音频', { main: true, onPick: async () => {
    if (saving || request || conversion || !target.value || savedTargets.has(target.value) || !hasSubtitle()) return;
    saving = true; update();
    const id = target.value, subtitle = result.file, lang = importLang;
    try {
      importNote.textContent = '正在保存字幕…';
      const record = await savePreparedTranscript(id, subtitle, lang);
      savedTargets.add(id); await onImport();
      if (disposed) return;
      if (!analyzeImport) {
        importNote.textContent = '字幕已导入，可直接播放；需要时可在播放页分析。';
        return;
      }
      importNote.textContent = '字幕已保存，正在分析…';
      const controller = new AbortController(); request = controller;
      try {
        const response = await analyze(subtitle, { id: record.id, title: record.title, lang,
          duration: record.duration, split: true, merge: true, estimate: false }, { signal: controller.signal });
        if (!response.track || !Array.isArray(response.track.sentences)) throw new Error('后端没有返回分析结果');
        await saveAnalysis(record.id, response.track, { transcriptName: subtitle.name, transcriptFile: subtitle });
        if (!disposed) importNote.textContent = '字幕已导入对应音频，分析完成，可以开始聆听。';
      } catch (err) {
        await patchTrack(record.id, { error: err.message });
        if (!disposed) importNote.textContent = '字幕已保存到对应音频。字幕分析未完成：' + err.message
          + '。打开音频后可直接重试，无需上传文件。';
      }
      await onImport();
    } catch (err) { if (!disposed) importNote.textContent = '导入失败：' + err.message; }
    finally { saving = false; request = null; if (!disposed) update(); }
  } });
  const subtitleImport = el('div', 'workbench-subtitle-import');
  subtitleImport.append(targetField, languageRow,
    group(switchRow('导入后分析字幕', '可选：生成分词、注音等学习内容',
      () => analyzeImport ? 1 : 0, (v) => { analyzeImport = !!v; })), importNote, buttonBar(add));
  asrCard.append(subtitleImport);

  function clearResult() {
    result = null; savedTargets.clear();
    resultField.input.value = ''; saveTranscript.disabled = true;
    importNote.textContent = '';
  }
  function hasSubtitle() {
    if (!result) return false;
    if (/\.(srt|vtt)$/i.test(result.file.name)) return /\d{2}:\d{2}[.,]\d{3}\s+-->/.test(result.content);
    if (!/\.json$/i.test(result.file.name)) return false;
    try {
      const data = JSON.parse(result.content);
      return [data.segments, data.words].some((list) => Array.isArray(list) && list.some((s) =>
        Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && (s.text || s.word)));
    } catch { return false; }
  }

  function update() {
    const busy = !!conversion || !!request || saving;
    useMaster.disabled = busy || !master; useProxy.disabled = busy || !converted;
    useMaster.setAttribute('aria-pressed', String(!!master && audioFile === master.file));
    useProxy.setAttribute('aria-pressed', String(!!converted && audioFile === converted.file));
    settingsHint.textContent = config.asrBaseUrl ? `${config.asrModel || '未选择模型'} · ${{ verbose_json: '详细 JSON', json: 'JSON', text: '纯文本', srt: 'SRT', vtt: 'VTT' }[config.asrFormat] || '详细 JSON'}` : '设置接口、模型与输出格式';
    const selected = targetTracks.find((track) => track.id === target.value);
    targetName.textContent = selected?.title || '选择首页音频';
    targetName.title = selected?.title || '';
    targetHint.textContent = selected ? `${fmtTime(selected.duration)} · ${selected.transcript ? '已有字幕' : '待导入字幕'}` : '将字幕保存到已有音频';
    video.setDisabled(busy); convert.disabled = busy || !video.input.files[0] || !!master;
    saveAudio.disabled = !master; useAudio.disabled = !master || busy;
    proxyDownload.disabled = !converted;
    audio.setDisabled(busy); start.disabled = busy || !audioFile || !!extraError;
    saveTranscript.disabled = !result;
    wordRow.hidden = config.asrFormat !== 'verbose_json';
    for (const input of options.querySelectorAll('input, select, textarea, button')) input.disabled = !!request;
    for (const [param, controls] of paramControls) {
      controls.key.disabled = controls.value.disabled = !!request || !param.enabled;
    }
    addAudio.disabled = busy || !master || !!imported;
    add.disabled = busy || !target.value || savedTargets.has(target.value) || !hasSubtitle();
    target.disabled = busy;
    for (const b of languageRow.querySelectorAll('button')) b.disabled = busy;
  }
  root.replaceChildren(videoCard, proxyCard, asrCard);
  validateParams(false);
  refreshTargets();
  return { dispose() {
    disposed = true; conversion?.abort(); request?.abort(); preview.pause(); preview.removeAttribute('src'); preview.load();
    if (optionsOpen || targetOpen) closeSheet();
    options.remove();
    for (const output of temporary) output.release?.();
    temporary.clear();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear(); master = converted = audioFile = result = imported = null; root.replaceChildren();
  } };
}
