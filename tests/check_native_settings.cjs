/** Native dialogs in real layout engines, with only the platform APIs mocked.
 * node tests/check_native_settings.cjs [playwright-module]
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { build } = require('esbuild');
const { chromium, webkit } = require(process.argv[2] || 'playwright');
const root = path.resolve(__dirname, '..');

(async () => {
  const output = path.join(root, '.cache/native-settings-current'); await fs.mkdir(output, { recursive: true });
  const bundled = await build({ entryPoints: [path.join(root, 'mobile/src/runtime.js')], bundle: true, write: false, format: 'esm',
    plugins: [{ name: 'native-mock', setup(b) {
      b.onResolve({ filter: /^@(capacitor|capgo)\// }, (args) => ({ path: args.path, namespace: 'mock' }));
      b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `export const { Capacitor, CapacitorHttp,
        registerPlugin, SystemBars, SystemBarType, Preferences, CapacitorUpdater, App, SplashScreen, Filesystem, Directory, Share } = window.adapters;` }));
    } }],
  });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/native.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundled.outputFiles[0].text); return; }
      if (url.pathname === '/native-bundle.json') { res.end(JSON.stringify({ version: 'a'.repeat(64) })); return; }
      if (url.pathname.startsWith('/api/')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ languages: [], version: 'test' })); return; }
      const file = path.resolve(root, 'web', '.' + decodeURIComponent(url.pathname));
      if (!file.startsWith(path.join(root, 'web') + path.sep)) { res.writeHead(403); res.end(); return; }
      let bytes = await fs.readFile(file);
      if (file.endsWith('.html')) bytes = Buffer.from(bytes.toString().replace('<script type="module" src="js/home.js"></script>',
        '<script type="module">import {ready} from "./native.js"; await ready; await import("./js/home.js");</script>'));
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
      res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
      const browser = await engine.launch({ headless: true });
      try {
        for (const [width, height] of [[320, 640], [390, 844], [844, 390], [1280, 800]]) {
          for (const theme of ['light', 'dark']) {
            const page = await browser.newPage({ viewport: { width, height } });
            const errors = []; page.on('pageerror', (error) => errors.push(error.message));
            await page.addInitScript(({ theme }) => {
              localStorage.setItem('linguatrack.settings.v1', JSON.stringify({ theme }));
              const source = { channel: 'own', ownUrl: 'https://site.example/', developmentUrl: '' };
              const values = new Map([['lingua.channel', 'own'], ['lingua.own-url', source.ownUrl], ['lingua.native.state', JSON.stringify({ source, pending: null })]]);
              const version = 'b'.repeat(64), checksum = 'c'.repeat(64), bundles = [];
              window.nativeQA = { checks: 0, downloads: 0, activated: 0, fail: false };
              window.adapters = {
                Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
                CapacitorHttp: { get: async () => { window.nativeQA.checks++; return { status: 200, data: {
                  schema: 1, appId: 'app.linguatrack.mobile', nativeRevision: 3, version, checksum, bundle: `bundle-${version}.zip`, size: 100,
                } }; } },
                registerPlugin: () => ({ setPresentation: async () => {}, addListener: async () => {} }),
                SystemBars: { hide: async () => {}, show: async () => {} }, SystemBarType: { NavigationBar: 'NavigationBar' },
                Preferences: { get: async ({ key }) => ({ value: values.get(key) ?? null }), set: async ({ key, value }) => values.set(key, value) },
                CapacitorUpdater: { current: async () => ({ bundle: { id: 'builtin' } }), list: async () => ({ bundles }),
                  notifyAppReady: async () => {}, reset: async () => {},
                  download: async () => { window.nativeQA.downloads++; await new Promise((resolve) => { window.nativeQA.finish = resolve; });
                    if (window.nativeQA.fail) throw Error('网络连接中断，请重试');
                    const bundle = { id: 'test', version, checksum, status: 'pending' }; bundles.push(bundle); return bundle;
                  }, set: async () => { window.nativeQA.activated++; },
                },
                App: { addListener: async () => {} }, SplashScreen: { hide: async () => {} }, Filesystem: {}, Directory: {}, Share: {},
              };
            }, { theme });
            await page.goto(base + '/index.html');
            const dialog = page.locator('#native-update'); await dialog.waitFor();
            assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
            const screenshot = async (state) => page.screenshot({ path: path.join(output, `${name}-${width}-${theme}-${state}.png`) });
            const layout = async () => {
              const result = await page.evaluate(() => [...document.querySelectorAll('dialog[open]')].map((d) => {
                const r = d.getBoundingClientRect();
                return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, overflow: d.scrollWidth > d.clientWidth + 1 };
              }));
              for (const rect of result) {
                assert.ok(rect.left >= 0 && rect.right <= width + 1 && rect.top >= 0 && rect.bottom <= height + 1, JSON.stringify(rect));
                assert.equal(rect.overflow, false);
              }
            };
            assert.equal(await page.evaluate(() => window.nativeQA.downloads), 0);
            await layout(); await screenshot('startup');
            await dialog.getByRole('button', { name: '稍后', exact: true }).click();
            await page.evaluate(() => window.LinguaNative.settings());
            const settings = page.locator('.native-settings');
            await settings.locator('select').selectOption('development');
            await settings.locator('input').fill('http://192.168.1.10:5173/');
            await layout(); await screenshot('settings');
            assert.equal(await settings.locator('p').innerText(), '');
            await settings.getByRole('button', { name: '检查更新', exact: true }).click();
            await dialog.getByRole('button', { name: '立即更新' }).click();
            await page.waitForFunction(() => !!window.nativeQA.finish);
            await layout(); await screenshot('downloading');
            await page.evaluate(() => { window.nativeQA.fail = true; window.nativeQA.finish(); });
            await dialog.getByRole('button', { name: '重试', exact: true }).waitFor();
            await layout(); await screenshot('failed');
            await dialog.getByRole('button', { name: '重试', exact: true }).click();
            await page.waitForFunction(() => window.nativeQA.downloads === 2);
            await page.evaluate(() => { window.nativeQA.fail = false; window.nativeQA.finish(); });
            await page.waitForFunction(() => window.nativeQA.activated === 1);
            assert.deepEqual(errors, []);
            await page.close(); console.log(`${name} ${width}×${height} ${theme}: passed`);
          }
        }
        // Run the actual injected native scripts against the project's real CSS.
        for (const [platform, sourceFile, marker] of [
          ['android', 'android/app/src/main/java/app/linguatrack/mobile/DevelopmentActivity.java', 'PRESENTATION_SCRIPT ='],
          ['ios', 'ios/App/App/AppDelegate.swift', 'presentationScript ='],
        ]) {
          const source = await fs.readFile(path.join(root, sourceFile), 'utf8');
          const script = source.slice(source.indexOf(marker)).match(/"""([\s\S]*?)"""/)[1];
          const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
          await page.setContent('<html><head></head><body><main class="app"><header class="topbar"><button id="control" class="tb-btn">返回</button></header></main></body></html>');
          for (const css of ['base', 'player']) await page.addStyleTag({ content: await fs.readFile(path.join(root, `web/css/${css}.css`), 'utf8') });
          await page.evaluate(() => {
            window.__linguaInsets = [47, 0, 34, 0]; window.presentationEvents = [];
            window.LinguaPresentation = { postMessage: (s) => window.presentationEvents.push(JSON.parse(s)) };
            window.webkit = { messageHandlers: { linguaPresentation: { postMessage: (s) => window.presentationEvents.push(s) } } };
          });
          await page.evaluate(script);
          assert.ok(await page.locator('#control').evaluate((b) => b.getBoundingClientRect().top >= 47));
          assert.equal(await page.locator('.app').evaluate((b) => b.getBoundingClientRect().top), 0, 'background must reach the physical top edge');
          await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.classList.add('video-immersive'); });
          await page.waitForFunction(() => window.presentationEvents.at(-1)?.immersive);
          assert.deepEqual(await page.evaluate(() => window.presentationEvents.at(-1)), { dark: true, immersive: true });
          await page.evaluate(() => {
            document.body.classList.add('video-rotated');
            window.__linguaInsets = [47, 3, 34, 5]; window.__linguaApplyInsets();
          });
          assert.deepEqual(await page.evaluate(() => ['t', 'r', 'b', 'l'].map((side) => getComputedStyle(document.body).getPropertyValue('--safe-' + side).trim())), ['3px', '34px', '5px', '47px']);
          await page.evaluate(() => {
            document.body.classList.remove('video-rotated'); document.documentElement.classList.remove('video-immersive');
            window.__linguaInsets = [0, 47, 21, 47]; window.__linguaApplyInsets();
          });
          assert.deepEqual(await page.evaluate(() => ['t', 'r', 'b', 'l'].map((side) => getComputedStyle(document.body).getPropertyValue('--safe-' + side).trim())), ['0px', '47px', '21px', '47px']);
          await page.close(); console.log(`${name} ${platform} native inset and theme scripts: passed`);
        }
      } finally { await browser.close(); }
    }
  } finally { server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
