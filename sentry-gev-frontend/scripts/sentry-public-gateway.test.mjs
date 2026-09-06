import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPublicGateway } from './sentry-public-gateway.mjs';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function request(base, pathname, { method = 'GET', body, headers = {} } = {}) {
  const address = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: address.hostname, port: address.port, path: pathname,
      method, headers: body ? { ...headers, 'content-length': Buffer.byteLength(body) } : headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}

async function fixture(t, options = {}) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(temporaryRoot, 'gev-public-gateway-'));
  const distRoot = path.join(folder, 'dist');
  await fs.mkdir(path.join(distRoot, 'assets'), { recursive: true });
  await fs.writeFile(path.join(distRoot, 'index.html'), '<html><head><title>Demo</title></head><body>GLOBE</body></html>');
  await fs.writeFile(path.join(distRoot, 'assets', 'built.js'), 'console.log("built")');
  await fs.writeFile(path.join(distRoot, 'assets', 'built.js.map'), 'not-public');
  await fs.writeFile(path.join(distRoot, '.env'), 'empty-test-fixture');
  await fs.mkdir(path.join(distRoot, 'src'));
  await fs.writeFile(path.join(distRoot, 'src', 'main.js'), 'not-public');
  await fs.writeFile(path.join(folder, 'outside.js'), 'outside-dist');
  const calls = [];
  const servers = [];
  t.after(async () => {
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    assert.equal(path.dirname(path.resolve(folder)), temporaryRoot);
    assert.ok(path.basename(folder).startsWith('gev-public-gateway-'));
    await fs.rm(folder, { recursive: true, force: true });
  });
  const upstream = (name) => http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ name, path: req.url, method: req.method, headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8') });
    if (req.url === '/api/v1/hang') return;
    res.setHeader('Content-Type', 'text/plain');
    if (req.url.startsWith('/scenario')) res.end('<html><a href="/">Console</a></html>');
    else res.end(`${name}:${req.url}`);
  });
  const backend = upstream('backend'), frontend = upstream('frontend');
  servers.push(backend, frontend);
  const backendUrl = await listen(backend), frontendUrl = await listen(frontend);
  const gateway = createPublicGateway({ distRoot, backendUrl, frontendUrl, ...options });
  servers.push(gateway);
  return { folder, distRoot, calls, backendUrl, frontendUrl, url: await listen(gateway) };
}

test('serves built files and inserts public configuration before application scripts', async (t) => {
  const f = await fixture(t);
  const home = await request(f.url, '/?sentry=1');
  assert.equal(home.status, 200);
  assert.match(home.body, /<head><script>globalThis\.__SENTRY_PUBLIC_CONFIG__=/);
  assert.match(home.body, /"consoleUrl":"\/console\/","scenarioUrl":"\/scenario","viewer":true/);
  assert.equal(home.headers['x-frame-options'], 'DENY');
  assert.equal(home.headers['x-content-type-options'], 'nosniff');
  assert.match(home.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(home.headers['cache-control'], 'no-store');
  assert.equal((await request(f.url, '/assets/built.js')).body, 'console.log("built")');
  const head = await request(f.url, '/assets/built.js', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.body, '');
  assert.equal(Number(head.headers['content-length']), Buffer.byteLength('console.log("built")'));
  assert.equal(f.calls.length, 0);
});

test('blocks traversal, dotfiles, source maps, dev sources and directory listing', async (t) => {
  const f = await fixture(t);
  for (const forbidden of ['/../outside.js', '/%2e%2e/outside.js', '/assets/%2e%2e/%2e%2e/outside.js',
    '/%252e%252e/outside.js', '/assets%5c..%5c..%5coutside.js', '/.env', '/%2eenv',
    '/assets/built.js.map', '/src/main.js', '/@vite/client', '/@fs/C:/private',
    '/node_modules/vite/package.json', '/assets/', '/%00.js', '/%zz']) {
    assert.equal((await request(f.url, forbidden)).status, 404, forbidden);
  }
  assert.equal(f.calls.length, 0);
});

test('rejects junction or symlink escapes from the dist real path', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.folder, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'leak.js'), 'not-public');
  await fs.symlink(outside, path.join(f.distRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await request(f.url, '/linked/leak.js')).status, 404);
  const hidden = path.join(f.distRoot, '.internal');
  await fs.mkdir(hidden);
  await fs.writeFile(path.join(hidden, 'private.json'), '{"test":true}');
  await fs.symlink(hidden, path.join(f.distRoot, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await request(f.url, '/alias/private.json')).status, 404);
});

test('routes the original console and scenario while preserving safe headers and links', async (t) => {
  const f = await fixture(t);
  const redirect = await request(f.url, '/console');
  assert.equal(redirect.status, 308); assert.equal(redirect.headers.location, '/console/');
  assert.equal((await request(f.url, '/console/')).body, 'backend:/');
  assert.equal((await request(f.url, '/assets/app.js')).body, 'backend:/assets/app.js');
  assert.equal((await request(f.url, '/scenario')).body, '<html><a href="/console/">Console</a></html>');
  assert.equal((await request(f.url, '/scenario.html')).body, '<html><a href="/console/">Console</a></html>');
  assert.equal((await request(f.url, '/scenario', { method: 'POST' })).status, 405);
  assert.equal((await request(f.url, '/console/anything')).status, 404);
});

test('maps SENTRY APIs and always marks forwarded requests without exposing cookies', async (t) => {
  const f = await fixture(t);
  const response = await request(f.url, '/sentry-api/golden-demo/session?x=1', {
    headers: { host: 'demo.trycloudflare.com', 'x-forwarded-for': '203.0.113.9',
      'cf-connecting-ip': '203.0.113.9', cookie: 'do-not-forward', authorization: 'do-not-forward' },
  });
  assert.equal(response.status, 200);
  const call = f.calls.at(-1);
  assert.equal(call.path, '/api/v1/golden-demo/session?x=1');
  assert.equal(call.headers['x-forwarded-for'], '203.0.113.9, public-gateway');
  assert.equal(call.headers['x-forwarded-host'], 'demo.trycloudflare.com');
  assert.equal(call.headers['cf-connecting-ip'], '203.0.113.9');
  assert.equal(call.headers.cookie, undefined); assert.equal(call.headers.authorization, undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal((await request(f.url, '/api/v1/prediction')).body, 'backend:/api/v1/prediction');
});

test('viewer gateway refuses backend commands before they reach the backend', async (t) => {
  const f = await fixture(t);
  for (const route of ['/api/v1/golden-demo/session/commands', '/sentry-api/golden-demo/session/commands']) {
    assert.equal((await request(f.url, route, { method: 'POST', body: '{}' })).status, 403);
  }
  assert.equal(f.calls.length, 0);
});

test('authorized control forwards only the existing session command endpoint', async (t) => {
  const f = await fixture(t, { control: 'any' });
  const command = '{"command":"START"}';
  assert.equal((await request(f.url, '/sentry-api/golden-demo/session/commands', {
    method: 'POST', body: command, headers: { 'content-type': 'application/json' },
  })).status, 200);
  assert.equal(f.calls.at(-1).body, command);
  assert.equal(f.calls.at(-1).headers['x-forwarded-for'], 'public-gateway');
  assert.equal(f.calls.at(-1).headers['content-type'], 'application/json');
  assert.match((await request(f.url, '/')).body, /"viewer":false/);
  assert.equal((await request(f.url, '/api/v1/arbitrary-write', { method: 'POST', body: '{}' })).status, 405);
  assert.equal((await request(f.url, '/api/v1/golden-demo/session/commands', { method: 'DELETE' })).status, 405);
  assert.equal(f.calls.length, 1);
});

test('allows only aircraft provider reads and rejects settings and paid API surfaces', async (t) => {
  const f = await fixture(t);
  for (const allowed of ['/api/opensky?lat=36.7&lon=127.4', '/api/adsblol/mil',
    '/api/opensky-track?icao24=abcdef', '/api/adsblol/trace?hex=abcdef',
    '/api/adsbdb/type/abcdef', '/api/adsbdb/route/KAL123', '/api/terrain/heights?points=127,36']) {
    assert.equal((await request(f.url, allowed)).body, `frontend:${allowed}`);
  }
  assert.equal(f.calls.length, 7);
  for (const forbidden of ['/api/setup/status', '/api/setup/keys', '/api/realtime/token',
    '/api/openai/hud-summary', '/api/google/text-search', '/api/adsblol/all',
    '/api/adsbdb/type/nothex', '/api/adsbdb/route/TOOLONG12345', '/api/unlisted']) {
    for (const method of ['GET', 'POST']) assert.equal((await request(f.url, forbidden, { method })).status, 404);
  }
  assert.equal((await request(f.url, '/api/opensky', { method: 'POST', body: '{}' })).status, 405);
  assert.equal(f.calls.length, 7);
});

test('times out stalled upstream requests instead of keeping the public request open', async (t) => {
  const f = await fixture(t, { requestTimeoutMs: 50 });
  assert.equal((await request(f.url, '/api/v1/hang')).status, 504);
});

test('rejects non-loopback upstreams, credentials and invalid control settings', async (t) => {
  const f = await fixture(t);
  for (const frontendUrl of ['https://127.0.0.1:8781', 'http://example.com', 'http://user:pass@localhost',
    'http://127.0.0.1:8781/path', 'http://127.0.0.1:8781/?key=secret']) {
    assert.throws(() => createPublicGateway({ distRoot: f.distRoot, frontendUrl }));
  }
  assert.throws(() => createPublicGateway({ distRoot: f.distRoot, control: 'unexpected' }));
});