// Run only against a disposable local READY/0 demo session. Time commands below
// are explicit API test setup for /scenario; the Globe is a read/decision console.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { decisionActions } from '../src/sentry/decision.js';

const base = process.env.SENTRY_FRONTEND_URL || 'http://127.0.0.1:8781';
const sessionUrl = base + '/sentry-api/golden-demo/session';
const out = '.gev-logs/sentry-qa';
const timeout = 60000;
fs.mkdirSync(out, { recursive: true });

async function api(url, body) {
  const response = await fetch(url, {
    cache: 'no-store', signal: AbortSignal.timeout(timeout),
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  assert.equal(response.status, 200, result?.error?.message || url + ' must return HTTP 200');
  return result;
}
function sameSession(actual, expected) {
  for (const key of ['session_id', 'run_number', 'stage', 'elapsed_seconds', 'simulation_time_utc', 'step_id']) {
    assert.deepEqual(actual[key], expected[key], 'Stop: a concurrent presenter changed ' + key);
  }
}
async function assertDecisionControls(page) {
  const state = await page.evaluate(() => {
    const current = window.__godsEyeView.sentry.controller.getSnapshot();
    return { session: current.session, access: current.access, stale: current.stale, busy: current.busy,
      timeControls: document.querySelectorAll('#snt-reset, #snt-advance, #snt-next').length,
      buttons: [...document.querySelectorAll('button[data-decision-command]')].map(button => ({
        command: button.dataset.decisionCommand, hidden: button.hidden, disabled: button.disabled,
      })) };
  });
  assert.equal(state.timeControls, 0, 'Only /scenario may expose playback controls');
  assert.equal(state.buttons.length, 7, 'The complete controller workflow must be mounted');
  const available = decisionActions(state.session).map(action => action.command);
  assert.deepEqual(state.buttons.filter(button => !button.hidden).map(button => button.command).sort(), available.sort());
  for (const button of state.buttons.filter(button => !button.hidden)) {
    assert.equal(button.disabled, !state.access.canControl || state.stale || state.busy,
      button.command + ' must honor operator access and current evidence');
  }
}

const browser = await puppeteer.launch({ headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const before = await api(sessionUrl);
  assert.equal(before.stage, 'READY', 'Use a fresh/reset V2 demo session for this QA.');
  assert.equal(before.elapsed_seconds, 0, 'Use a fresh/reset V2 demo session for this QA.');
  assert.equal((await api(base + '/sentry-api/reference/access')).operator, true, 'Disposable QA requires operator access.');
  const scenario = await api(base + '/sentry-api/reference/scenario');
  const page = await browser.newPage();
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [], posts = [], external = [], setupCommands = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /^\/(?:sentry-api|api\/v1)(?:\/|$)/.test(path)) posts.push(request.url());
    if (request.url().startsWith('https:')) external.push(request.url());
  });
  await page.goto(base + '/?sentry=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.sentry?.controller.getSnapshot()?.session));
  await page.waitForFunction(() => document.querySelector('#loading-screen')?.classList.contains('hidden'));
  await page.waitForFunction(() => {
    const camera = window.__godsEyeView.viewer.camera.positionCartographic;
    return camera.longitude > 2.20 && camera.longitude < 2.25 && camera.height > 20000;
  }, { timeout: 15000 });
  await new Promise((resolve) => setTimeout(resolve, 7000));
  await assertDecisionControls(page);
  assert.equal(await page.evaluate(() => window.__godsEyeView.sentry.controller.getSnapshot().access.canControl), true);
  await page.screenshot({ path: out + '/overview.png' });
  assert.ok(external.some((url) => /arcgisonline|arcgis|reearth|mapterhorn/.test(url)), 'Original online map provider must remain active.');
  assert.equal(await page.$eval('#snt-contact-count', (e) => e.textContent), String(before.traffic_count));
  await page.click('.snt-contact');
  await page.click('#snt-follow');
  await page.waitForFunction(() => Boolean(window.__godsEyeView.sentry.layer.getSnapshot().followingId));
  await page.screenshot({ path: out + '/tracking.png' });
  await page.click('#snt-airport');
  assert.equal(await page.evaluate(() => window.__godsEyeView.sentry.layer.getSnapshot().followingId), null);
  assert.deepEqual(posts, []);
  sameSession(await api(sessionUrl), before);

  let expected = before;
  async function setupCommand(body) {
    // No retry/cleanup after ownership changes: another presenter may own this session.
    sameSession(await api(sessionUrl), expected);
    const result = await api(sessionUrl + '/commands', body);
    setupCommands.push(body.command);
    sameSession(await api(sessionUrl), result);
    expected = result;
    await page.waitForFunction(({ id, elapsed, stage }) => {
      const current = window.__godsEyeView.sentry.controller.getSnapshot().session;
      return current.session_id === id && current.elapsed_seconds === elapsed && current.stage === stage;
    }, { timeout, polling: 250 }, { id: result.session_id, elapsed: result.elapsed_seconds, stage: result.stage });
    await assertDecisionControls(page);
    return result;
  }
  // Reproduce /scenario's setup commands. No Globe time buttons or background clock exist.
  await setupCommand({ command: 'START' });
  const advanced = await setupCommand({ command: 'ADVANCE', seconds: 30 });
  assert.equal(advanced.elapsed_seconds, 30);
  await page.waitForFunction(() => window.__godsEyeView.viewer.dataSources.getByName('SENTRY DEMO')[0]
    .entities.values.some((entity) => entity.id.startsWith('sentry:prediction:')));
  const next = scenario.steps.filter(step => Number.isFinite(step.t_s) && step.t_s > 30)
    .sort((a, b) => a.t_s - b.t_s)[0];
  assert.ok(next, 'Disposable scenario must expose a future checkpoint');
  const nextResult = await setupCommand({ command: 'ADVANCE', seconds: Math.ceil(next.t_s - 30) });
  assert.ok(nextResult.elapsed_seconds >= next.t_s);
  await page.screenshot({ path: out + '/scenario.png' });
  await page.click('#snt-layer');
  await page.waitForFunction(() => !window.__godsEyeView.viewer.dataSources.getByName('SENTRY DEMO')[0].show);
  await page.click('#snt-layer');
  await page.waitForFunction(() => window.__godsEyeView.viewer.dataSources.getByName('SENTRY DEMO')[0].show);
  const reset = await setupCommand({ command: 'RESET' });
  assert.equal(reset.stage, 'READY');
  assert.equal(reset.elapsed_seconds, 0);
  assert.notEqual(reset.session_id, before.session_id);
  assert.equal(await page.evaluate(() => window.__godsEyeView.viewer.dataSources.getByName('SENTRY DEMO')[0]
    .entities.values.filter((entity) => entity.id.startsWith('sentry:trail:')).length), 0);

  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: out + '/mobile.png' });
  assert.ok(await page.$eval('#snt-panel', (e) => { const r=e.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth; }));
  await page.click('#snt-close');
  assert.equal(await page.$eval('#snt-panel', (e) => e.hidden), true);
  await page.click('#snt-launcher');
  assert.equal(await page.$eval('#snt-panel', (e) => e.hidden), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(posts, [], 'Globe reads/selection must never issue time commands');
  const after = await api(sessionUrl);
  sameSession(after, expected);
  assert.equal(after.elapsed_seconds, 0); assert.equal(after.traffic_count, before.traffic_count);
  console.log(JSON.stringify({ result: 'PASS', tests: ['original online globe', 'RKTU view', 'demo overlay',
    'selection/follow without runtime writes', 'no Globe time controls', 'decision availability/access',
    'scenario API setup synchronized', 'current CV', 'toggle', 'reset clears trails', 'mobile'],
    setupCommands, posts: posts.length, runtimeErrors: errors, externalMapRequests: external.length }));
} finally { await browser.close(); }
