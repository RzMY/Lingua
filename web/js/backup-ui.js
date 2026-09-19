import { exportBackup, parseBackup, importBackup, backupSummary } from './backup.js';
import { attachFiles, listTracks, missingFiles, matchFiles, AUDIO_ACCEPT, SUB_EXT } from './library.js';
import { openSheet, closeSheet } from './sheet.js';
import { button, buttonBar, group, infoRow, switchRow } from './rows.js';
import { el, isIOS, toast } from './util.js';
import { saveFile } from './native.js';

let importing = false;
const errorText = (err) => (err && err.message) || '操作失败';

function fileInput(label, accept = '', multiple = false) {
  const input = el('input');
  input.type = 'file';
  input.hidden = true;
  input.multiple = multiple;
  input.setAttribute('aria-label', label);
  if (!isIOS()) input.accept = accept;
  return input;
}

function feedback() {
  const note = el('p', 'transfer-status');
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');
  return note;
}

export function openBackupExport() {
  const body = el('div', 'pane transfer');
  const note = feedback();
  let includeCredentials = true;
  const credentials = switchRow('包含 API Key 与访问令牌', '明文写入备份文件',
    () => includeCredentials, (v) => { includeCredentials = !!v; });
  const save = button('导出 JSON', { main: true, glyph: 'i-doc', onPick: async () => {
    save.disabled = true;
    credentials.querySelector('button').disabled = true;
    note.textContent = '正在导出…';
    try {
      const backup = await exportBackup({ includeCredentials });
      await saveFile(new Blob([JSON.stringify(backup)], { type: 'application/json' }),
        'lingua-backup-' + backup.exportedAt.replace(/[:.]/g, '-') + '.json');
      const summary = backupSummary(backup);
      note.textContent = `已导出 ${summary.tracks} 条曲目、${summary.analyses} 份分析、${summary.llm} 条 LLM 产物`;
    } catch (err) { note.textContent = '导出失败: ' + errorText(err); }
    finally { save.disabled = false; credentials.querySelector('button').disabled = false; }
  } });
  body.append(group(
    infoRow('备份内容', '配置、分析结果、LLM 产物'),
    infoRow('音视频与字幕', '仅文件名'), credentials,
  ), buttonBar(save), note);
  openSheet('导出用户数据', body);
}

export function openBackupImport() {
  if (importing) { toast('数据正在导入'); return; }
  const body = el('div', 'pane transfer');
  const input = fileInput('选择用户数据备份', '.json,application/json');
  const note = feedback();
  const preview = el('div');
  const name = el('p', 'transfer-filename', '尚未选择备份');
  let backup = null, restoreConfig = true, selection = 0;
  const configRow = switchRow('使用备份中的全局配置', '替换当前模型、提示词与显示偏好',
    () => restoreConfig, (v) => { restoreConfig = !!v; });
  const choose = button('选择备份', { glyph: 'i-doc', onPick: () => input.click() });
  const restore = button('导入数据', { main: true, glyph: 'i-upload', onPick: async () => {
    if (!backup || importing) return;
    importing = true;
    restore.disabled = true;
    choose.disabled = true;
    configRow.querySelector('button').disabled = true;
    note.textContent = '正在写入…';
    try {
      await importBackup(backup, { restoreConfig });
      // All configuration modules reload from the committed snapshot on the next page load.
      location.hash = 'restore';
      location.reload();
    } catch (err) {
      note.textContent = '导入失败: ' + errorText(err);
      importing = false;
      restore.disabled = false;
      choose.disabled = false;
      configRow.querySelector('button').disabled = false;
    }
  } });
  restore.disabled = true;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const serial = ++selection;
    backup = null;
    restore.disabled = true;
    preview.textContent = '';
    name.textContent = file.name;
    note.textContent = '正在校验…';
    try {
      const parsed = parseBackup(await file.text());
      if (serial !== selection) return;
      const summary = backupSummary(parsed);
      const existing = new Set((await listTracks()).map((t) => t.id));
      if (serial !== selection) return;
      const copies = parsed.stores.tracks.filter((r) => existing.has(r.key)).length;
      backup = parsed;
      preview.append(group(
        infoRow('导出时间', new Date(parsed.exportedAt).toLocaleString()),
        infoRow('曲目 / 分析 / LLM 产物', `${summary.tracks} / ${summary.analyses} / ${summary.llm}`),
        infoRow('重复曲目', copies ? `${copies} 条保存为副本` : '无'),
        infoRow('待补充文件', `${summary.tracks} 个媒体、${parsed.stores.tracks.filter((r) => r.value.transcript).length} 个字幕`),
        infoRow('API Key 与访问令牌', parsed.includesCredentials ? '包含在备份中' : '保留本机凭据'),
      ));
      note.textContent = '';
      restore.disabled = false;
    } catch (err) {
      if (serial === selection) note.textContent = errorText(err);
    }
  });
  body.append(input, name, preview, group(configRow), buttonBar(choose, restore), note);
  openSheet('导入用户数据', body, { cls: 'sheet-tall' });
}

export async function openMissingFiles(options = {}) {
  try { openFileRepair(await listTracks(), options); }
  catch (err) { toast(errorText(err)); }
}

/** Shared by settings, track menus and the player when an imported audio is absent. */
export function openFileRepair(records, { onUpdate, onClose, imported = false } = {}) {
  records = [...records];
  const body = el('div', 'pane transfer');
  const list = el('div', 'transfer-files');
  const note = feedback();
  const count = el('p', 'transfer-status');
  const input = fileInput('批量选择待补充文件', '', true);
  const batch = button('批量选择文件', { main: true, glyph: 'i-upload', onPick: () => input.click() });
  const done = button('稍后补充', { onPick: closeSheet });
  let busy = false;

  function render() {
    const pending = missingFiles(records);
    const audios = pending.filter((f) => f.kind === 'audio').length;
    count.textContent = (imported ? '用户数据已导入\n' : '')
      + (pending.length ? `待补充 ${audios} 个媒体、${pending.length - audios} 个字幕` : '文件已补齐');
    done.lastElementChild.textContent = pending.length ? '稍后补充' : '完成';
    batch.disabled = busy || !pending.length;
    list.textContent = '';
    for (const record of records) {
      const wanted = pending.filter((f) => f.id === record.id);
      if (!wanted.length) continue;
      const section = el('section', 'transfer-track');
      section.append(el('h3', null, record.title || record.id));
      for (const item of wanted) {
        const label = item.kind === 'audio' ? '音频或视频' : '字幕';
        const row = el('div', 'transfer-file');
        const text = el('div', 'transfer-file-name');
        text.append(el('span', null, label), el('b', null, item.name));
        const pick = fileInput(record.id + ' ' + label,
          item.kind === 'audio' ? AUDIO_ACCEPT : SUB_EXT.map((e) => '.' + e).join(','));
        const choose = button('选择文件', { glyph: item.kind === 'audio' ? 'i-upload' : 'i-doc',
          onPick: () => pick.click() });
        choose.setAttribute('aria-label', '补充' + label + ' ' + item.name);
        choose.disabled = busy;
        pick.addEventListener('change', () => {
          const file = pick.files?.[0];
          pick.value = '';
          if (file) save([{ ...item, file }]);
        });
        row.append(text, choose, pick);
        section.append(row);
      }
      list.append(section);
    }
  }

  async function save(matches, extra = '') {
    if (busy) return;
    busy = true;
    render();
    note.textContent = '正在补充文件…';
    let saved = 0;
    const errors = [];
    for (const item of matches) {
      try {
        const updated = await attachFiles(item.id, { [item.kind]: item.file });
        records = records.map((t) => t.id === item.id ? updated : t);
        saved++;
        if (onUpdate) await onUpdate(updated);
      } catch (err) { errors.push(item.file.name + ': ' + errorText(err)); }
    }
    busy = false;
    render();
    note.textContent = [`已补充 ${saved} 个文件`, extra, ...errors].filter(Boolean).join('\n');
  }

  input.addEventListener('change', () => {
    const files = [...(input.files || [])];
    input.value = '';
    if (!files.length) return;
    const { matches, ambiguous, unmatched } = matchFiles(records, files);
    const extra = [ambiguous.length ? `${ambiguous.length} 个同名文件待逐项选择: ${ambiguous.join('、')}` : '',
      unmatched.length ? `${unmatched.length} 个文件名不匹配: ${unmatched.join('、')}` : ''].filter(Boolean).join('\n');
    if (matches.length) save(matches, extra);
    else note.textContent = extra || '没有待补充的文件';
  });
  body.append(count, input, buttonBar(batch, done), list, note);
  render();
  openSheet('补充媒体与字幕', body, { cls: 'sheet-tall', onClose });
}
