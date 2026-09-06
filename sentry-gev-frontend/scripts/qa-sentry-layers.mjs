// Read-only UI regression: no SENTRY clock or controller commands are issued.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { createDefaultLayerState, encodeLayerStateParams, serializeStoredLayerState,
  LAYER_STATE_STORAGE_KEY } from '../src/data/layerState.js';

const base = process.env.SENTRY_FRONTEND_URL || 'http://127.0.0.1:8781';
const allowed = ['sentry-demo', 'flights', 'military'];
const registered = [...allowed, 'military-awareness'];
const output = '.gev-logs/sentry-layer-qa';
fs.mkdirSync(output, { recursive: true });
const legacy = createDefaultLayerState();
legacy.enabledLayerIds = ['sentry-demo', 'flights', 'military', 'cctv', 'satellites', 'earthquakes'];
const stored = serializeStoredLayerState(legacy);
const share = new URLSearchParams({ v: '2', lat: '36.2164', lon: '127.4992',
  alt: '145000', heading: '0', pitch: '-65', roll: '0', style: 'normal', map: 'esri-imagery', ui: 'v.c.0' });
encodeLayerStateParams(share, legacy);
const before = await fetch(`${base}/sentry-api/golden-demo/session`).then(r => r.json());
const browser = await puppeteer.launch({ headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [], writes = [], retiredRequests = [];
try {
  for (const kind of ['fresh', 'local', 'share']) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    page.on('pageerror', error => errors.push(`${kind}: ${error.message}`));
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().includes('/sentry-api/')) writes.push(request.url());
      if (/\/api\/(cctv|earthquakes|satellites)(\/|\?|$)/.test(request.url())) retiredRequests.push(request.url());
    });
    if (kind === 'local') await page.evaluateOnNewDocument((key, value) => {
      localStorage.setItem(key, value);
    }, LAYER_STATE_STORAGE_KEY, stored);
    await page.goto(`${base}/?sentry=1${kind === 'share' ? `#${share}` : ''}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('#loading-screen')?.classList.contains('hidden'), { timeout: 60000 });
    await page.evaluate(() => window.__godsEyeView.sentry.ready);
    assert.deepEqual(await page.evaluate(() => window.__godsEyeView.dataManager.getAll().map(layer => layer.id)), registered);
    assert.deepEqual(await page.$$eval('#data-toggles .data-toggle-row', rows => rows.map(row => row.dataset.layerId)), allowed);
    assert.equal(await page.$('#cctv-panel'), null);
    assert.equal(await page.$('#cctv-sync-chip'), null);
    const restore = await page.evaluate(() => window.__godsEyeView.styleManager._layerStateCoordinator.lastRestoreResults);
    assert.ok(restore.every(result => registered.includes(result.layerId)), `${kind}: only available layers can restore`);
    assert.ok(restore.every(result => result.errorClass !== 'UnknownLayer'), `${kind}: retired state is not a loading error`);
    if (kind === 'local') assert.equal(await page.evaluate(key => localStorage.getItem(key), LAYER_STATE_STORAGE_KEY), stored);
    if (kind !== 'fresh') {
      assert.deepEqual(await page.evaluate(() => window.__godsEyeView.styleManager._layerStateCoordinator
        .getDurableState().enabledLayerIds), ['flights', 'military', 'sentry-demo']);
    }
    await page.evaluate(() => window.__godsEyeView.styleManager.setPanelCollapsed('data-panel', false));
    await page.click('#snt-close');
    await page.screenshot({ path: `${output}/${kind}.png` });
    if (kind === 'fresh') {
      await page.setViewport({ width: 390, height: 844 });
      await page.screenshot({ path: `${output}/mobile.png` });
      assert.equal(await page.$('#cctv-panel'), null);
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, []);
  assert.deepEqual(retiredRequests, []);
  assert.deepEqual(await fetch(`${base}/sentry-api/golden-demo/session`).then(r => r.json()), before);
  console.log(JSON.stringify({ result: 'PASS', layers: allowed, views: ['fresh', 'legacy local', 'legacy share', 'mobile'],
    cctvPanel: 'removed', backendWrites: writes.length, retiredFeedRequests: retiredRequests.length, runtimeErrors: errors }));
} finally { await browser.close(); }
