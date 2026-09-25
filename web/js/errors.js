/** Translate platform exceptions at UI boundaries. Service responses are mapped by their clients. */
export function errorMessage(error, fallback = '操作失败，请重试') {
  const messages = {
    QuotaExceededError: '本地存储空间不足，请清理空间后重试',
    NotReadableError: '无法读取文件，请重新选择',
    NotFoundError: '文件不存在或已移除，请重新选择',
    SecurityError: '访问被阻止，请检查浏览器权限',
    NotAllowedError: '操作未获授权，请检查浏览器或系统权限',
    NetworkError: '网络连接失败，请检查网络后重试',
    TimeoutError: '请求超时，请稍后重试',
    AbortError: '操作已取消',
    PIP_BUSY: '字幕小窗正在切换，请稍后重试',
    PIP_UNSUPPORTED: '当前设备不支持字幕画中画',
    PIP_SOURCE_NOT_READY: '播放窗口尚未就绪，请稍后重试',
    PIP_NOT_READY: '字幕小窗尚未就绪，请稍后重试',
    PIP_AUDIO_SESSION: '音频暂时不可用，请恢复播放后重试',
    PIP_START_NO_CALLBACK: '字幕小窗启动超时，请重试',
    PIP_PRESENTATION_TIMEOUT: '字幕小窗显示超时，请重试',
    PIP_SOURCE_DETACHED: '播放窗口已关闭，请返回播放页重试',
    PIP_START_FAILED: '字幕小窗启动失败，请重试',
    OVERLAY_PERMISSION: '请在系统设置中允许 Lingua 显示在其他应用上层，然后重试字幕小窗',
    OVERLAY_SETTINGS: '无法打开悬浮窗设置，请到系统设置中允许 Lingua 显示在其他应用上层',
    AUDIO_STALE: '当前音频已切换，请重新播放',
  };
  if (Object.hasOwn(messages, error?.code)) return messages[error.code];
  if (Object.hasOwn(messages, error?.name)) return messages[error.name];
  const message = typeof error === 'string' ? error : error?.message;
  // Keep authored Chinese guidance; opaque browser, plugin and parser errors use the context's fallback.
  if (error?.name !== 'SyntaxError' && typeof message === 'string' && /[\u3400-\u9fff]/u.test(message)) {
    return message;
  }
  return fallback;
}
