// Run only against a disposable local demo session. All commands below are
// explicit test actions; merely opening/selecting the map must remain read-only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const base = process.env.SENTRY_FRONTEND_URL || 'http://127.0.0.1:8781';
const sessionUrl = `${base}/sentry-api/golden-demo/session`;
const out = '.gev-logs/sentry-qa';
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const before = await fetch(sessionUrl).then((r) => r.json());
  assert.equal(before.elapsed_seconds, 0, 'Use a fresh/reset V2 demo session for this QA.');
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [], posts = [], external = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/sentry-api/')) posts.push(request.url());
    if (request.url().startsWith('https:')) external.push(request.url());
  });
  await page.goto(`${base}/?sentry=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__godsEyeView?.sentry?.layer.getSnapshot()?.session,
    { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#loading-screen')?.classList.contains('hidden'));
  await page.waitForFunction(() => {
    const camera = window.__godsEyeView.viewer.camera.positionCartographic;
    return camera.longitude > 2.20 && camera.longitude < 2.25 && camera.height > 20000;
  }, { timeout: 15000 });
  await new Promise((resolve) => setTimeout(resolve, 7000));
  await page.screenshot({ path: `${out}/overview.png` });
  assert.ok(external.some((url) => /arcgisonline|arcgis|reearth|mapterhorn/.test(url)), 'Original online map provider must remain active.');
  assert.equal(await page.$eval('#snt-contact-count', (e) => e.textContent), String(before.traffic_count));
  await page.click('.snt-contact');
  await page.click('#snt-follow');
  await page.waitForFunction(() => window.__godsEyeView.sentry.layer.getSnapshot().followingId);
  await page.screenshot({ path: `${out}/tracking.png` });
  await page.click('#snt-airport');
  assert.equal(await page.evaluate(() => window.__godsEyeView.sentry.layer.getSnapshot().followingId), null);
  assert.deepEqual(posts, []);
  assert.deepEqual(await fetch(sessionUrl).then((r) => r.json()), before);

  // Exercise the actual operator buttons, then restore the disposable session.
  await page.click('#snt-advance');
  await page.waitForFunction(() => document.querySelector('#snt-advance').textContent === '+30초');
  await page.click('#snt-advance');
  await page.waitForFunction(() => window.__godsEyeView.sentry.layer.getSnapshot().session.elapsed_seconds === 30);
  await page.waitForFunction(() => window.__godsEyeView.viewer.dataSources.getByName('SENTRY DEMO')[0]
    .entities.values.some((entity) => entity.id.startsWith('sentry:prediction:')));
  await page.click('#snt-next');
  await page.waitForFunction(() => window.__godsEyeView.sentry.layer.getSnapshot().session.elapsed_seconds >= 836);
  await page.screenshot({ path: `${out}/scenario.png` });
  await page.click('#snt-layer');
  await page.waitForFunction(() => !window.__godsEyeView.viewer.dataSources.getByName('SENTRY DEMO')[0].show);
  await page.click('#snt-layer');
  await page.waitForFunction(() => window.__godsEyeView.viewer.dataSources.getByName('SENTRY DEMO')[0].show);
  await page.click('#snt-reset');
  await page.waitForFunction(() => window.__godsEyeView.sentry.layer.getSnapshot().session.elapsed_seconds === 0);
  assert.equal(await page.evaluate(() => window.__godsEyeView.viewer.dataSources.getByName('SENTRY DEMO')[0]
    .entities.values.filter((entity) => entity.id.startsWith('sentry:trail:')).length), 0);

  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: `${out}/mobile.png` });
  assert.ok(await page.$eval('#snt-panel', (e) => { const r=e.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth; }));
  await page.click('#snt-close');
  assert.equal(await page.$eval('#snt-panel', (e) => e.hidden), true);
  await page.click('#snt-launcher');
  assert.equal(await page.$eval('#snt-panel', (e) => e.hidden), false);
  assert.deepEqual(errors, []);
  const after = await fetch(sessionUrl).then((r) => r.json());
  assert.equal(after.elapsed_seconds, 0); assert.equal(after.traffic_count, before.traffic_count);
  console.log(JSON.stringify({ result: 'PASS', tests: ['original online globe', 'RKTU view', 'demo overlay',
    'selection/follow without runtime writes', 'START/ADVANCE/next event', 'current CV', 'toggle', 'reset clears trails', 'mobile'],
    posts: posts.length, runtimeErrors: errors, externalMapRequests: external.length }));
} finally { await browser.close(); }
