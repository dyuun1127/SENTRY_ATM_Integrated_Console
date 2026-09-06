import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../../../sentry-gev-v2/src/sentry_atm/infrastructure/http/static/scenario.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../../../sentry-gev-v2/src/sentry_atm/infrastructure/http/static/scenario.html', import.meta.url), 'utf8');
const start = script.indexOf('function scenarioGlobeUrl(');
const end = script.indexOf('const API =', start);
assert.ok(start >= 0 && end > start, 'production scenario navigation helpers must be available');
const navigationSource = script.slice(start, end);

function productionNavigation({ page = 'http://127.0.0.1:8782/scenario', config, links = [] } = {}) {
  return vm.runInNewContext(navigationSource + '; ({ scenarioGlobeUrl, configureConsoleLinks })', {
    URL, window: { location: { href: page } }, __SENTRY_PUBLIC_CONFIG__: config,
    document: { querySelectorAll(selector) { assert.equal(selector, '[data-sentry-console-link]'); return links; } },
  });
}
function fromGlobe(target, page = 'https://demo.example/scenario') {
  const result = new URL(page);
  result.searchParams.set('globe', target);
  return result.href;
}
const { scenarioGlobeUrl } = productionNavigation();

test('the scenario link returns to its originating public Globe without changing its route or query', () => {
  const target = 'https://demo.example/?sentry=1#v=2';
  assert.equal(scenarioGlobeUrl(fromGlobe(target)), target);
  assert.equal(scenarioGlobeUrl(fromGlobe('/?sentry=1')), 'https://demo.example/?sentry=1');
});

test('separate custom frontend/backend ports are allowed only when both hosts are loopback', () => {
  for (const [page, target] of [
    ['http://127.0.0.1:9082/scenario', 'http://127.0.0.1:9081/?sentry=1'],
    ['http://localhost:9082/scenario', 'http://127.0.0.1:9081/?sentry=1'],
    ['http://[::1]:9082/scenario', 'http://localhost:9081/?sentry=1'],
  ]) assert.equal(scenarioGlobeUrl(fromGlobe(target, page)), target);
});

test('external, executable, credential-bearing and non-loopback destinations cannot replace the console link', () => {
  for (const target of [
    'javascript:alert(1)', 'data:text/html,unsafe', 'file:///C:/Windows/win.ini',
    'https://other.example/?sentry=1', '//other.example/',
    'http://demo.example/?sentry=1', 'https://demo.example:9443/?sentry=1',
    'https://user:password@demo.example/', 'http://127.0.0.1:8781/',
  ]) assert.equal(scenarioGlobeUrl(fromGlobe(target)), null, target);
  assert.equal(scenarioGlobeUrl(fromGlobe('http://127.0.0.1.evil.example:8781/', 'http://localhost:8782/scenario')), null);
  assert.equal(scenarioGlobeUrl(fromGlobe('https://demo.example/', 'http://127.0.0.1:8782/scenario')), null);
  assert.equal(scenarioGlobeUrl('not a URL'), null);
});

test('direct public pages use injected same-origin Globe config while direct local pages retain the legacy link', () => {
  assert.equal(scenarioGlobeUrl('https://demo.example/scenario', { viewer: false }), 'https://demo.example/?sentry=1');
  assert.equal(scenarioGlobeUrl('https://demo.example/scenario', { viewer: true }), 'https://demo.example/?sentry=1');
  assert.equal(scenarioGlobeUrl('http://127.0.0.1:8782/scenario'), null);
  assert.equal(scenarioGlobeUrl('https://demo.example/scenario'), null);
  assert.equal(scenarioGlobeUrl(fromGlobe('javascript:alert(1)'), { viewer: false }), 'https://demo.example/?sentry=1');
});

test('production boot wiring changes only marked links and keeps the fallback when navigation is rejected', () => {
  const link = { href: '/console/' };
  productionNavigation({ page: fromGlobe('https://demo.example/?sentry=1'), links: [link] }).configureConsoleLinks();
  assert.equal(link.href, 'https://demo.example/?sentry=1');
  const fallback = { href: '/console/' };
  productionNavigation({ page: fromGlobe('https://other.example/'), links: [fallback] }).configureConsoleLinks();
  assert.equal(fallback.href, '/console/');
  assert.match(html, /href="\/" data-sentry-console-link/);
  assert.match(script, /async function boot\(\) \{\s*configureConsoleLinks\(\);\s*buildControls\(\);/);
});
