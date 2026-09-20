// Platform-independent update policy; native plugin owns atomic extraction and rollback.
export const NATIVE_REVISION = 3;

export function validateManifest(data, manifestUrl, bundleUrl) {
  const base = new URL(manifestUrl);
  if (base.protocol !== 'https:' || base.username || base.password) throw Error('更新清单地址无效');
  if (data?.schema !== 1 || data.appId !== 'app.linguatrack.mobile'
      || data.nativeRevision !== NATIVE_REVISION) throw Error('此更新需要新版安装包，或目标不是兼容的 Lingua 站点');
  if (!/^[a-f0-9]{64}$/.test(data.version) || !/^[a-f0-9]{64}$/.test(data.checksum)
      || !Number.isSafeInteger(data.size) || data.size < 1 || data.size > 100 * 1024 * 1024
      || data.bundle !== `bundle-${data.version}.zip`) throw Error('更新清单无效');
  const url = new URL(bundleUrl || data.bundle, base);
  if (url.origin !== base.origin || url.username || url.password
      || url.pathname !== new URL(data.bundle, base).pathname) throw Error('更新包与清单位置不匹配');
  return { ...data, url: url.href };
}

export class UpdateManager {
  constructor({ updater, fetchManifest, save, state, currentVersion }) {
    Object.assign(this, { updater, fetchManifest, save, state, currentVersion });
    this.busy = null;
  }
  check() {
    if (!this.busy) this.busy = this.inspect().finally(() => { this.busy = null; });
    return this.busy;
  }
  async inspect() {
    this.available = null;
    const { data, manifestUrl, bundleUrl } = await this.fetchManifest(this.state.source);
    const manifest = validateManifest(data, manifestUrl, bundleUrl);
    if (manifest.version === this.currentVersion) {
      // A maintainer may roll a channel back while a newer bundle is still pending locally.
      if (this.state.pending) {
        const next = { ...this.state, pending: null };
        await this.save(next); this.state = next;
      }
      return null;
    }
    const { bundles } = await this.updater.list();
    if (bundles.some((b) => b.version === manifest.version && b.status === 'error')) {
      throw Error('此版本曾启动失败，已保留可用版本；请等待站点发布修复');
    }
    this.available = manifest;
    return manifest;
  }
  download(manifest = this.available) {
    if (this.busy) return Promise.reject(Error('请等待当前更新操作完成'));
    if (!manifest || manifest !== this.available) return Promise.reject(Error('请重新检查更新'));
    this.busy = this.stage(manifest).finally(() => { this.busy = null; });
    return this.busy;
  }
  async stage(manifest) {
    const { bundles } = await this.updater.list();
    if (bundles.some((b) => b.version === manifest.version && b.status === 'error')) {
      throw Error('此版本曾启动失败，请等待修复');
    }
    const pending = this.state.pending;
    if (pending?.version === manifest.version && pending.checksum === manifest.checksum
        && bundles.some((b) => b.id === pending.id && b.status !== 'error')) return pending;
    // A page navigation can interrupt JS after native download finishes but before Preferences commits.
    const bundle = bundles.find((b) => b.version === manifest.version && b.checksum === manifest.checksum
      && ['pending', 'success'].includes(b.status))
      || await this.updater.download({ url: manifest.url, version: manifest.version, checksum: manifest.checksum });
    if (bundle.status === 'error' || bundle.version !== manifest.version
        || bundle.checksum !== manifest.checksum) throw Error('本地更新包校验失败');
    const next = { ...this.state, pending: { id: bundle.id, version: manifest.version, checksum: manifest.checksum } };
    await this.save(next);
    this.state = next;
    // Never call next(): that API activates on background, interrupting media playback.
    return next.pending;
  }
  async apply() {
    if (this.busy) throw Error('请等待当前更新检查完成');
    const pending = this.state.pending;
    if (!pending) throw Error('没有待应用的更新');
    const { bundles } = await this.updater.list();
    if (!bundles.some((b) => b.id === pending.id && b.version === pending.version
        && b.checksum === pending.checksum && ['pending', 'success'].includes(b.status))) throw Error('更新包已失效，请重新检查');
    await this.save({ ...this.state, pending: null });
    try { await this.updater.set({ id: pending.id }); }
    catch (error) { await this.save(this.state); throw error; }
  }
}
