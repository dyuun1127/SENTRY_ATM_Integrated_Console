// Public gateway QA. Default is read-only; --exercise requires an untouched READY/0 session.
// SENTRY_PUBLIC_URL=https://example.trycloudflare.com node scripts/qa-sentry-public.mjs [--exercise]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer';
import { decisionActions } from '../src/sentry/decision.js';

const { values } = parseArgs({ options: { exercise: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false } } });
if (values.help) {
  console.log('SENTRY_PUBLIC_URL=https://<public-host> node scripts/qa-sentry-public.mjs [--exercise]\n'
    + 'Default URL: http://127.0.0.1:8783. Default mode sends no commands.\n'
    + '--exercise: requires READY at 0 seconds, then START, ADVANCE 30, RESET; stops on any mismatch.');
  process.exit(0);
}
const base = new URL(process.env.SENTRY_PUBLIC_URL || 'http://127.0.0.1:8783');
assert.ok(base.protocol === 'https:' || base.origin === 'http://127.0.0.1:8783',
  'Use a public HTTPS origin or http://127.0.0.1:8783.');
assert.ok(!base.username && !base.password && base.pathname === '/' && !base.search && !base.hash,
  'SENTRY_PUBLIC_URL must be an origin without credentials, path, query, or fragment.');
const origin = base.origin, timeout = 60000, output = '.gev-logs/public-qa';
const sessionPath = '/api/v1/golden-demo/session';
const allowed = ['sentry-demo', 'flights', 'military'];
const registered = [...allowed, 'military-awareness'];
const report = { result: 'RUNNING', origin, mode: values.exercise ? 'exercise' : 'read-only',
  checks: [], commands: [], pageErrors: [], resourceErrors: [], browserWrites: [], ancillaryRequests: [] };
fs.mkdirSync(output, { recursive: true });
let browser, observing = true;
const pages = [], essentialFailures = [];

function cleanURL(value) {
  try { const url = new URL(value); return url.origin + url.pathname; } catch { return String(value); }
}
function cleanMessage(value) {
  return String(value).replace(/https?:\/\/[^\s"'<>]+/g, cleanURL).slice(0, 700);
}
function isLocal(value) {
  try { return new URL(value).origin === origin; } catch { return false; }
}
// Node's raw path preserves encoded dot segments; URL/fetch would normalize some before testing.
function request(rawPath, { body, discardBody = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = (base.protocol === 'https:' ? https : http).request({
      hostname: base.hostname, port: base.port || undefined, path: rawPath,
      method: payload === undefined ? 'GET' : 'POST',
      headers: { Accept: 'application/json', ...(payload === undefined ? {} : {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Origin: origin }) },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        if (discardBody) return;
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { res.destroy(new Error('QA response exceeds 4 MiB')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        text: discardBody ? '' : Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('Request timed out: ' + rawPath)));
    req.on('error', reject);
    req.end(payload);
  });
}
async function json(rawPath, body) {
  const response = await request(rawPath, { body });
  assert.equal(response.status, 200, rawPath + ' must return HTTP 200');
  assert.match(response.headers['content-type'] || '', /application\/json/, rawPath + ' must return JSON');
  return JSON.parse(response.text);
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), timeout);
    })]);
  } finally { clearTimeout(timer); }
}
async function openPage(name, pathname) {
  const page = await browser.newPage();
  pages.push(page);
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);
  await page.setViewport({ width: 1600, height: 1000 });
  await page.setCacheEnabled(false);
  const resources = new Map();
  page.on('pageerror', error => {
    if (observing) report.pageErrors.push({ page: name, message: cleanMessage(error.message) });
  });
  page.on('request', req => {
    if (observing && isLocal(req.url()) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
      const item = { page: name, method: req.method(), url: cleanURL(req.url()) };
      const runtimePath = /^\/(?:api\/v1|sentry-api)(?:\/|$)/.test(new URL(req.url()).pathname);
      (runtimePath ? report.browserWrites : report.ancillaryRequests).push(item);
    }
  });
  page.on('response', res => {
    if (!observing) return;
    const req = res.request(), type = req.resourceType();
    if (isLocal(res.url()) && ['script', 'stylesheet'].includes(type)) {
      resources.set(res.url(), res.status());
      if (res.status() !== 200) essentialFailures.push({ page: name, url: cleanURL(res.url()), status: res.status() });
    }
    if (res.status() >= 400) report.resourceErrors.push({ page: name, url: cleanURL(res.url()), status: res.status() });
  });
  page.on('requestfailed', req => {
    if (!observing) return;
    const failure = { page: name, url: cleanURL(req.url()), error: req.failure()?.errorText || 'request failed' };
    report.resourceErrors.push(failure);
    if (isLocal(req.url()) && ['script', 'stylesheet'].includes(req.resourceType())) essentialFailures.push(failure);
  });
  const response = await page.goto(origin + pathname, { waitUntil: 'load', timeout });
  assert.equal(response.status(), 200, name + ' document must return HTTP 200');
  assert.equal(new URL(page.url()).origin, origin, name + ' must remain on the public origin');
  return { page, resources };
}
function sameSession(actual, expected, label) {
  // Detect a concurrent presenter before issuing the next command. Never reset an unexpected run.
  for (const key of ['session_id', 'run_number', 'stage', 'elapsed_seconds', 'simulation_time_utc', 'step_id']) {
    assert.deepEqual(actual[key], expected[key], label + ': concurrent state change in ' + key);
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
  assert.equal(state.buttons.length, 7, 'The complete Globe controller workflow must be mounted');
  const available = decisionActions(state.session).map(action => action.command);
  assert.deepEqual(state.buttons.filter(button => !button.hidden).map(button => button.command).sort(), available.sort());
  for (const button of state.buttons.filter(button => !button.hidden)) {
    assert.equal(button.disabled, !state.access.canControl || state.stale || state.busy,
      button.command + ' must honor operator access and current evidence');
  }
}
function assertReady(session) {
  assert.equal(session.stage, 'READY', '--exercise needs READY; no automatic pre-test reset is issued');
  assert.equal(session.elapsed_seconds, 0, '--exercise needs 0 seconds');
  assert.equal(typeof session.session_id, 'string', 'Session must expose its run identity');
  assert.ok(Number.isFinite(Date.parse(session.simulation_time_utc)), 'Session must expose its UTC clock');
}

try {
  const access = await json('/api/v1/reference/access');
  assert.equal(access.operator, true, 'Public operator access must be enabled');
  const before = await json(sessionPath);
  if (values.exercise) assertReady(before);
  report.checks.push('operator access');

  const blocked = ['/api/setup/status', '/api/setup/keys', '/src/main.js', '/src%2fmain.js',
    '/@vite/client', '/@fs/C:/Windows/win.ini', '/.env', '/%2eenv', '/.git/config',
    '/vite.config.js', '/package.json', '/%2e%2e/.env', '/assets/%2e%2e/%2e%2e/.env',
    '/assets/%252e%252e/.env', '/assets/missing.js.map'];
  // An upstream edge may reject traversal before our gateway sees it.
  // Ordinary source/settings paths still must be hidden with HTTP 404.
  const traversal = new Set(['/%2e%2e/.env', '/assets/%2e%2e/%2e%2e/.env',
    '/assets/%252e%252e/.env']);
  report.blockedPaths = [];
  for (const pathname of blocked) {
    const response = await request(pathname, { discardBody: true });
    const expected = traversal.has(pathname) ? [400, 403, 404] : [404];
    assert.ok(expected.includes(response.status),
      pathname + ' must be denied with HTTP ' + expected.join('/') + '; received ' + response.status);
    report.blockedPaths.push({ path: pathname, status: response.status });
  }
  report.checks.push('source/settings denied: ' + blocked.length + ' raw paths');

  browser = await puppeteer.launch({ headless: true, timeout,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const { page: globe } = await openPage('globe', '/?sentry=1');
  await globe.waitForFunction(() => Boolean(window.__godsEyeView?.sentry?.ready));
  await bounded(globe.evaluate(() => window.__godsEyeView.sentry.ready), 'SENTRY ready');
  await globe.waitForFunction(() => document.querySelector('#loading-screen')?.classList.contains('hidden')
    && Boolean(window.__godsEyeView?.sentry?.controller.getSnapshot()?.session));
  const state = await globe.evaluate(() => {
    const app = window.__godsEyeView, canvas = app.viewer.scene.canvas;
    return { ids: app.dataManager.getAll().map(layer => layer.id),
      visibleIds: app.dataManager.getAll().filter(layer => layer.showInTogglePanel !== false).map(layer => layer.id),
      mode: app.viewer.scene.mode,
      canvas: [canvas.width, canvas.height], destroyed: app.viewer.isDestroyed(),
      config: window.__SENTRY_PUBLIC_CONFIG__, canControl: app.sentry.controller.getSnapshot().access.canControl,
      stage: app.sentry.controller.getSnapshot().session.stage,
      links: [...document.querySelectorAll('#snt-panel .snt-footer a')].map(a => a.href) };
  });
  assert.deepEqual(state.ids, registered);
  assert.deepEqual(state.visibleIds, allowed);
  assert.deepEqual(await globe.$$eval('#data-toggles .data-toggle-row', rows => rows.map(row => row.dataset.layerId)), allowed);
  assert.equal(state.mode, 3, 'Cesium must initialize in 3D mode');
  assert.ok(state.canvas.every(value => value > 0) && !state.destroyed, 'Cesium canvas must be active');
  assert.equal(state.config?.viewer, false, 'Public config must enable operator controls');
  assert.equal(await globe.$eval('#snt-console-link', a => a.href), origin + '/console/');
  const scenarioLink = state.links.find(link => new URL(link).pathname === '/scenario');
  assert.ok(scenarioLink, 'Globe must link to the separate scenario controller');
  const scenarioURL = new URL(scenarioLink);
  assert.equal(scenarioURL.origin, origin, 'Scenario link must use the same origin');
  assert.equal(scenarioURL.searchParams.get('globe'), origin + '/?sentry=1', 'Scenario must return to this Globe console');
  assert.equal(state.canControl, true, 'Operator access must reach the decision console');
  await assertDecisionControls(globe);
  await bounded(globe.evaluate(() => new Promise(resolve => {
    const scene = window.__godsEyeView.viewer.scene;
    const remove = scene.postRender.addEventListener(() => { remove(); resolve(); });
    scene.requestRender();
  })), '3D render');
  await globe.screenshot({ path: output + '/globe.png' });
  report.checks.push('3D render, three visible layers, same-origin links, no Globe playback, decision access');

  for (const [name, pathname, required] of [
    ['console', '/console/', ['/assets/app.js', '/assets/app.css']],
    ['scenario', scenarioURL.pathname + scenarioURL.search, ['/assets/scenario.js', '/assets/scenario.css']],
  ]) {
    const { page, resources } = await openPage(name, pathname);
    await page.waitForFunction(() => document.querySelector('#link')?.classList.contains('live'));
    assert.equal(await page.$eval('#viewer', element => element.hidden), true, name + ' must show operator mode');
    const assets = await page.$$eval('script[src], link[rel="stylesheet"][href]',
      nodes => nodes.map(node => node.src || node.href));
    for (const asset of required) assert.ok(assets.includes(origin + asset), name + ' must load ' + asset);
    for (const asset of assets) {
      assert.equal(new URL(asset).origin, origin, name + ' required assets must stay on public origin');
      assert.equal(resources.get(asset), 200, name + ' asset must return HTTP 200: ' + cleanURL(asset));
    }
    if (name === 'scenario') assert.equal(await page.$eval('[data-sentry-console-link]', a => a.href), origin + '/?sentry=1');
    await page.screenshot({ path: output + '/' + name + '.png' });
    report.checks.push(name + ': loaded, operator mode, JS/CSS HTTP 200');
  }
  assert.deepEqual(report.pageErrors, [], 'Pages must have no uncaught runtime errors');
  assert.deepEqual(essentialFailures, [], 'Required local scripts/styles must load without errors');
  assert.deepEqual(report.browserWrites, [], 'Opening all three pages must send no SENTRY runtime write requests');
  sameSession(await json(sessionPath), before, 'Read-only page checks');
  report.checks.push('page loads preserve session');

  if (values.exercise) {
    // Time advancement is explicit test setup for /scenario; the Globe only observes it.
    await globe.bringToFront();
    const baseline = await json(sessionPath);
    sameSession(baseline, before, 'Exercise entry');
    assertReady(baseline);
    let expected = baseline;
    for (const command of [{ command: 'START' }, { command: 'ADVANCE', seconds: 30 }, { command: 'RESET' }]) {
      sameSession(await json(sessionPath), expected, 'Before ' + command.command);
      // No retry and no cleanup RESET after a mismatch: a shared presenter may own the session.
      const result = await json(sessionPath + '/commands', command);
      report.commands.push(command.command);
      if (command.command === 'RESET') {
        assertReady(result);
        assert.notEqual(result.session_id, baseline.session_id, 'RESET must create a new run');
        assert.equal(Date.parse(result.simulation_time_utc), Date.parse(baseline.simulation_time_utc));
      } else {
        assert.equal(result.session_id, baseline.session_id);
        assert.equal(result.stage, 'MONITORING');
        const elapsed = command.command === 'ADVANCE' ? 30 : 0;
        assert.equal(result.elapsed_seconds, elapsed);
        assert.equal(Date.parse(result.simulation_time_utc), Date.parse(baseline.simulation_time_utc) + elapsed * 1000);
      }
      sameSession(await json(sessionPath), result, 'After ' + command.command);
      expected = result;
      await globe.waitForFunction(({ id, elapsed, stage }) => {
        const current = window.__godsEyeView.sentry.controller.getSnapshot().session;
        return current.session_id === id && current.elapsed_seconds === elapsed && current.stage === stage;
      }, { timeout, polling: 250 }, { id: result.session_id, elapsed: result.elapsed_seconds, stage: result.stage });
      await assertDecisionControls(globe);
    }
    await globe.screenshot({ path: output + '/globe-reset.png' });
    report.checks.push('scenario API setup: START, ADVANCE 30, RESET; Globe UTC synchronization');
  }
  assert.deepEqual(report.pageErrors, [], 'Pages must remain free of uncaught runtime errors');
  assert.deepEqual(essentialFailures, [], 'Required local scripts/styles must remain healthy');
  assert.deepEqual(report.browserWrites, [], 'The QA pages must not issue autonomous commands');
  report.result = 'PASS';
} catch (error) {
  report.result = 'FAIL';
  report.error = cleanMessage(error.message || error);
  process.exitCode = 1;
} finally {
  observing = false;
  if (browser) await browser.close();
  report.resourceErrors = [...new Map(report.resourceErrors.map(item => [JSON.stringify(item), item])).values()];
  fs.writeFileSync(output + '/report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ result: report.result, origin, mode: report.mode, checks: report.checks.length,
    commands: report.commands, pageErrors: report.pageErrors, resourceErrors: report.resourceErrors.length,
    ancillaryRequests: report.ancillaryRequests.length,
    ...(report.error ? { error: report.error } : {}), artifacts: output }));
}
