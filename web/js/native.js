// Browser builds remain dependency-free. The native shell initializes this bridge before imports.
export const nativeApp = () => globalThis.window?.LinguaNative;
export const nativeReady = () => nativeApp()?.markReady().catch((error) => console.warn('Native ready', error));
export async function saveFile(blob, name) {
  if (nativeApp()) return nativeApp().exportFile(blob, name);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
