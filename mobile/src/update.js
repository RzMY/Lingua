// Platform-independent update policy; native plugin owns atomic extraction and rollback.
// Revision 4 requires installed-binary build checks. Legacy updaters must ask for a reinstall.
export const NATIVE_REVISION = 4;
export const CHECK_TIMEOUT_MS = 45000;

export class NativeUpdateRequiredError extends Error {
  constructor() {
    super('请到仓库下载最新版应用');
    this.name = 'NativeUpdateRequiredError';
  }
}

export function validateManifest(data, manifestUrl, bundleUrl) {
  const base = new URL(manifestUrl);
  if (base.protocol !== 'https:' || base.username || base.password) throw Error('更新清单地址无效');
  if (data?.schema !== 1 || data.appId !== 'app.linguatrack.mobile'
      || !Number.isSafeInteger(data.nativeRevision) || data.nativeRevision < 1) throw Error('更新清单无效');
  if (!/^[a-f0-9]{64}$/.test(data.version) || !/^[a-f0-9]{64}$/.test(data.checksum)
      || !Number.isSafeInteger(data.size) || data.size < 1 || data.size > 100 * 1024 * 1024
      || data.bundle !== `bundle-${data.version}.zip`) throw Error('更新清单无效');
  if (data.minimumNativeBuilds !== undefined && !validNativeBuilds(data.minimumNativeBuilds)) throw Error('更新清单无效');
  if (data.nativeRevision === NATIVE_REVISION && !validNativeBuilds(data.minimumNativeBuilds)) throw Error('更新清单无效');
  const url = new URL(bundleUrl || data.bundle, base);
  if (url.origin !== base.origin || url.username || url.password
      || url.pathname !== new URL(data.bundle, base).pathname) throw Error('更新包与清单位置不匹配');
  if (data.nativeRevision !== NATIVE_REVISION) throw new NativeUpdateRequiredError();
  return { ...data, url: url.href };
}

function validNativeBuilds(builds) {
  return builds && ['android', 'ios'].every((platform) => Number.isSafeInteger(builds[platform]) && builds[platform] > 0);
}

export function validateNativeBuild(manifest, { platform, build } = {}) {
  // App.getInfo() reads versionCode / CFBundleVersion from the installed binary,
  // whereas native-bundle.json and JS constants can both be replaced by an OTA.
  const installed = typeof build === 'string' && /^[1-9]\d*$/.test(build) ? Number(build) : NaN;
  if (!['android', 'ios'].includes(platform) || !Number.isSafeInteger(installed)) throw Error('无法读取应用版本，请重新检查更新');
  if (!validNativeBuilds(manifest.minimumNativeBuilds)) throw Error('请重新检查更新');
  if (manifest.nativeRevision !== NATIVE_REVISION || installed < manifest.minimumNativeBuilds[platform]) {
    throw new NativeUpdateRequiredError();
  }
}

export class UpdateManager {
  constructor({ updater, fetchManifest, getNativeInfo, save, state, currentVersion }) {
    Object.assign(this, { updater, fetchManifest, getNativeInfo, save, state, currentVersion });
    this.busy = null;
  }
  check() {
    if (this.busy) return this.busy;
    const controller = new AbortController();
    const check = { controller, timer: setTimeout(() => this.cancelCheck(
      Error('检查更新超时，请检查网络后重试')), CHECK_TIMEOUT_MS) };
    this.checking = check;
    const cancelled = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    const task = Promise.race([this.inspect(check), cancelled]).finally(() => {
      this.finishCheck(check);
      // A cancelled native request may finish after a new operation has started.
      if (this.busy === task) this.busy = null;
    });
    this.busy = task;
    return this.busy;
  }
  finishCheck(check) {
    clearTimeout(check.timer);
    if (this.checking === check) this.checking = null;
  }
  cancelCheck(reason = new DOMException('检查更新已取消', 'AbortError')) {
    const check = this.checking;
    if (!check) return false;
    this.finishCheck(check);
    this.available = null;
    this.busy = null;
    check.controller.abort(reason);
    return true;
  }
  async inspect(check) {
    const signal = check.controller.signal;
    this.available = null;
    const { data, manifestUrl, bundleUrl } = await this.fetchManifest(this.state.source, signal);
    if (signal.aborted) throw signal.reason;
    const manifest = validateManifest(data, manifestUrl, bundleUrl);
    const nativeInfo = await this.getNativeInfo();
    if (signal.aborted) throw signal.reason;
    validateNativeBuild(manifest, nativeInfo);
    if (manifest.version === this.currentVersion) {
      // A maintainer may roll a channel back while a newer bundle is still pending locally.
      if (this.state.pending) {
        const next = { ...this.state, pending: null };
        // Preferences writes cannot be cancelled safely. Keep the busy lock until commit.
        this.finishCheck(check);
        await this.save(next); this.state = next;
      }
      return null;
    }
    const { bundles } = await this.updater.list();
    if (signal.aborted) throw signal.reason;
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
        && pending.nativeRevision === manifest.nativeRevision
        && ['android', 'ios'].every((platform) => pending.minimumNativeBuilds?.[platform] === manifest.minimumNativeBuilds[platform])
        && bundles.some((b) => b.id === pending.id && b.status !== 'error')) return pending;
    // A page navigation can interrupt JS after native download finishes but before Preferences commits.
    const bundle = bundles.find((b) => b.version === manifest.version && b.checksum === manifest.checksum
      && ['pending', 'success'].includes(b.status))
      || await this.updater.download({ url: manifest.url, version: manifest.version, checksum: manifest.checksum });
    if (bundle.status === 'error' || bundle.version !== manifest.version
        || bundle.checksum !== manifest.checksum) throw Error('本地更新包校验失败');
    const next = { ...this.state, pending: { id: bundle.id, version: manifest.version, checksum: manifest.checksum,
      nativeRevision: manifest.nativeRevision, minimumNativeBuilds: manifest.minimumNativeBuilds } };
    await this.save(next);
    this.state = next;
    // Never call next(): that API activates on background, interrupting media playback.
    return next.pending;
  }
  async apply() {
    if (this.busy) throw Error('请等待当前更新检查完成');
    const pending = this.state.pending;
    if (!pending) throw Error('没有待应用的更新');
    validateNativeBuild(pending, await this.getNativeInfo());
    const { bundles } = await this.updater.list();
    if (!bundles.some((b) => b.id === pending.id && b.version === pending.version
        && b.checksum === pending.checksum && ['pending', 'success'].includes(b.status))) throw Error('更新包已失效，请重新检查');
    await this.save({ ...this.state, pending: null });
    try { await this.updater.set({ id: pending.id }); }
    catch (error) { await this.save(this.state); throw error; }
  }
}
