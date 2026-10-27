import { el } from './util.js';
import { errorMessage } from './errors.js';
import { openSheet, closeSheet } from './sheet.js';
import { button, buttonBar, group, switchRow, textField } from './rows.js';

export function openSubtitleEditor(defaults, { onSave, onClose } = {}) {
  const values = { ...defaults };
  const body = el('div', 'subtitle-editor');
  const fields = el('fieldset', 'setup-fields');
  let requestedAnalysis = !!values.reanalyze;
  const analysis = switchRow('重新分析', '', () => values.reanalyze,
    (on) => { requestedAnalysis = !!on; syncAnalysis(); });
  const retranslation = switchRow('重新翻译', '', () => values.retranslate,
    (on) => { values.retranslate = !!on; });
  function syncAnalysis() {
    const required = !!defaults.hasAnalysis && values.text.trim() !== defaults.text;
    values.reanalyze = required || requestedAnalysis;
    analysis.querySelector('button').disabled = required;
    analysis.refresh();
  }
  function syncTranslation() {
    const sourceChanged = values.text.trim() !== defaults.text;
    const translationChanged = values.translation.trim() !== (defaults.translation || '').trim();
    values.retranslate = sourceChanged && !translationChanged;
    retranslation.refresh();
  }
  syncAnalysis();
  const source = textField('字幕原文', { value: values.text, rows: 4,
    onInput: (text) => { values.text = text; syncAnalysis(); syncTranslation(); } });
  const translation = textField('译文', { value: values.translation, rows: 3,
    onInput: (text) => { values.translation = text; syncTranslation(); } });
  fields.append(source, translation, group(analysis, retranslation));
  const status = el('p', 'field-hint');
  status.setAttribute('role', 'status');
  const cancel = button('取消', { onPick: closeSheet });
  const save = button('保存', { main: true, onPick: submit });
  body.append(fields, status);
  let busy = false, closed = false, committing = false, closeReason;
  let ctl;
  async function submit() {
    if (busy) return;
    if (!values.text.trim()) { status.textContent = '字幕原文不能为空'; source.input.focus(); return; }
    busy = true;
    fields.disabled = save.disabled = true;
    body.setAttribute('aria-busy', 'true');
    ctl = new AbortController();
    try {
      await onSave(values, { signal: ctl.signal,
        onStage: (message) => { status.textContent = message; },
        onCommit: () => { committing = true; status.textContent = '正在保存…'; },
      });
      if (!closed) closeSheet();
    } catch (error) {
      if (!closed) status.textContent = errorMessage(error, '保存失败，请重试');
    } finally {
      busy = false;
      committing = false;
      fields.disabled = save.disabled = false;
      body.removeAttribute('aria-busy');
      if (closed) onClose?.(closeReason);
    }
  }
  openSheet('修改字幕', body, { cls: 'sheet-sentence', footer: buttonBar(cancel, save), onClose: (reason) => {
    closed = true;
    closeReason = reason;
    if (!committing) ctl?.abort();
    if (!busy) onClose?.(closeReason);
  } });
}
