import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const READ = new Set(['GET', 'HEAD']);
const BACKEND_ASSETS = new Set(['/scenario', '/scenario.html', '/assets/app.js',
  '/assets/app.css', '/assets/scenario.js', '/assets/scenario.css']);
const PROVIDERS = new Set(['/api/opensky', '/api/opensky-track', '/api/adsblol/mil',
  '/api/adsblol/trace', '/api/terrain/heights']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2', '.pbf': 'application/octet-stream',
  '.webm': 'video/webm', '.mp4': 'video/mp4' };

function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Upstreams must be plain HTTP loopback origins without credentials or paths.');
  }
  return url;
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  res.setHeader('Cache-Control', 'no-store');
}

function send(req, res, status, text, type = 'text/plain; charset=utf-8') {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(req.method === 'HEAD' ? undefined : text);
}

function requestPath(raw) {
  // Examine the raw target before URL normalization can erase dot segments.
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return null;
  const rawPath = raw.split('?')[0];
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { return null; }
  if (/[\\\u0000-\u001f\u007f:%]/.test(decoded) || decoded.startsWith('//')) return null;
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some((part) => part.startsWith('.'))) return null;
  if (/\.map$/i.test(decoded)) return null;
  return { pathname: decoded, query: raw.includes('?') ? raw.slice(raw.indexOf('?')) : '' };
}

function isProvider(pathname) {
  return PROVIDERS.has(pathname) || /^\/api\/adsbdb\/type\/[0-9a-f]{6}$/i.test(pathname)
    || /^\/api\/adsbdb\/route\/[a-z0-9]{2,8}$/i.test(pathname);
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative));
}

async function staticAsset(req, res, distRoot, pathname, control) {
  if (/^\/(?:src|scripts|node_modules|@vite|@id|@fs|__vite)(?:\/|$)/i.test(pathname)) {
    send(req, res, 404, 'Not found'); return;
  }
  const candidate = path.resolve(distRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!contained(distRoot, candidate)) { send(req, res, 404, 'Not found'); return; }
  let resolved, info;
  try {
    resolved = await fs.promises.realpath(candidate);
    info = await fs.promises.stat(resolved);
  } catch { send(req, res, 404, 'Not found'); return; }
  // Both lexical and real paths must remain within dist, including junctions.
  const hiddenTarget = path.relative(distRoot, resolved).split(path.sep).some((part) => part.startsWith('.'));
  if (!contained(distRoot, resolved) || hiddenTarget || !info.isFile()) { send(req, res, 404, 'Not found'); return; }
  const extension = path.extname(resolved).toLowerCase();
  const type = MIME[extension];
  if (!type || extension === '.map') { send(req, res, 404, 'Not found'); return; }
  if (pathname === '/' || pathname === '/index.html') {
    let html = await fs.promises.readFile(resolved, 'utf8');
    const config = JSON.stringify({ consoleUrl: '/console/', scenarioUrl: '/scenario', viewer: control !== 'any' });
    const script = `<script>globalThis.__SENTRY_PUBLIC_CONFIG__=${config};</script>`;
    html = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, (head) => head + script) : script + html;
    send(req, res, 200, html, type); return;
  }
  securityHeaders(res);
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', info.size);
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = fs.createReadStream(resolved);
  res.once('close', () => stream.destroy());
  stream.on('error', () => send(req, res, 500, 'Asset unavailable'));
  stream.pipe(res);
}

async function proxy(req, res, origin, targetPath, { rewriteScenario = false, timeoutMs }) {
  let body;
  if (req.method === 'POST') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) { send(req, res, 413, 'Command too large'); return; }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }
  if (req.aborted || res.destroyed) return;
  const headers = { host: origin.host, accept: req.headers.accept || '*/*', 'accept-encoding': 'identity',
    'x-forwarded-for': [req.headers['x-forwarded-for'], 'public-gateway'].filter(Boolean).join(', '),
    'x-forwarded-host': req.headers['x-forwarded-host'] || req.headers.host || 'public-gateway' };
  for (const name of ['forwarded', 'x-real-ip', 'cf-connecting-ip', 'x-forwarded-proto']) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  if (body) {
    headers['content-type'] = req.headers['content-type'] || 'application/json';
    headers['content-length'] = body.length;
  }
  const upstream = http.request({ hostname: origin.hostname.replace(/^\[|\]$/g, ''),
    port: origin.port || 80, path: targetPath, method: req.method, headers }, (incoming) => {
    if (res.destroyed) { incoming.destroy(); return; }
    securityHeaders(res);
    res.statusCode = incoming.statusCode || 502;
    for (const name of ['content-type', 'content-encoding', 'location']) {
      if (incoming.headers[name]) res.setHeader(name, incoming.headers[name]);
    }
    incoming.on('error', () => send(req, res, 502, 'Upstream response interrupted'));
    incoming.setTimeout(timeoutMs, () => incoming.destroy(new Error('Upstream response timeout')));
    if (rewriteScenario && req.method !== 'HEAD' && res.statusCode === 200) {
      const chunks = [];
      let size = 0;
      incoming.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) { incoming.destroy(new Error('Scenario response too large')); return; }
        chunks.push(chunk);
      });
      incoming.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8').replaceAll('href="/"', 'href="/console/"');
        res.removeHeader('content-encoding');
        send(req, res, 200, html, 'text/html; charset=utf-8');
      });
    } else {
      if (incoming.headers['content-length']) res.setHeader('Content-Length', incoming.headers['content-length']);
      incoming.pipe(res);
    }
  });
  upstream.setTimeout(timeoutMs, () => {
    const error = new Error('Upstream timeout'); error.code = 'ETIMEDOUT'; upstream.destroy(error);
  });
  upstream.on('error', (error) => send(req, res, error.code === 'ETIMEDOUT' ? 504 : 502, 'Upstream unavailable'));
  req.once('aborted', () => upstream.destroy());
  res.once('close', () => { if (!res.writableEnded) upstream.destroy(); });
  upstream.end(body);
}

export function createPublicGateway({ distRoot, frontendUrl = 'http://127.0.0.1:8781',
  backendUrl = 'http://127.0.0.1:8782', control = 'local', requestTimeoutMs = 15000 }) {
  if (!['local', 'any'].includes(control)) throw new Error('control must be local or any');
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error('Invalid timeout');
  const root = fs.realpathSync(distRoot);
  if (!fs.statSync(root).isDirectory()) throw new Error('distRoot must be a directory');
  const frontend = loopbackOrigin(frontendUrl), backend = loopbackOrigin(backendUrl);
  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    try {
      const route = requestPath(req.url);
      if (!route) { send(req, res, 404, 'Not found'); return; }
      const { pathname, query } = route;
      if (pathname === '/console') {
        if (!READ.has(req.method)) { send(req, res, 405, 'Method not allowed'); return; }
        res.setHeader('Location', '/console/'); send(req, res, 308, 'Use /console/'); return;
      }
      const api = pathname === '/api/v1' || pathname.startsWith('/api/v1/');
      const alias = pathname === '/sentry-api' || pathname.startsWith('/sentry-api/');
      if (api || alias) {
        const mapped = alias ? '/api/v1' + pathname.slice('/sentry-api'.length) : pathname;
        if (!READ.has(req.method)) {
          if (req.method !== 'POST' || mapped !== '/api/v1/golden-demo/session/commands') {
            send(req, res, 405, 'Method not allowed'); return;
          }
          if (control !== 'any') { send(req, res, 403, 'Viewer only'); return; }
        }
        await proxy(req, res, backend, mapped + query, { timeoutMs: requestTimeoutMs }); return;
      }
      if (pathname === '/console/' || BACKEND_ASSETS.has(pathname)) {
        if (!READ.has(req.method)) { send(req, res, 405, 'Method not allowed'); return; }
        await proxy(req, res, backend, (pathname === '/console/' ? '/' : pathname) + query,
          { rewriteScenario: pathname === '/scenario' || pathname === '/scenario.html', timeoutMs: requestTimeoutMs }); return;
      }
      if (isProvider(pathname)) {
        if (!READ.has(req.method)) { send(req, res, 405, 'Method not allowed'); return; }
        await proxy(req, res, frontend, pathname + query, { timeoutMs: requestTimeoutMs }); return;
      }
      if (pathname === '/api' || pathname.startsWith('/api/')) { send(req, res, 404, 'Not found'); return; }
      if (!READ.has(req.method)) { send(req, res, 405, 'Method not allowed'); return; }
      await staticAsset(req, res, root, pathname, control);
    } catch {
      send(req, res, 500, 'Gateway request failed');
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  return server;
}

function cliPort(value) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('Invalid port');
  return Number(value);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '8783' },
    'frontend-port': { type: 'string', default: '8781' }, 'backend-port': { type: 'string', default: '8782' },
    control: { type: 'string', default: 'local' }, dist: { type: 'string', default: fileURLToPath(new URL('../dist', import.meta.url)) } } });
  const server = createPublicGateway({ distRoot: path.resolve(values.dist), control: values.control,
    frontendUrl: `http://127.0.0.1:${cliPort(values['frontend-port'])}`,
    backendUrl: `http://127.0.0.1:${cliPort(values['backend-port'])}` });
  server.on('error', (error) => { console.error(`Gateway failed: ${error.message}`); process.exitCode = 1; });
  server.listen(cliPort(values.port), '127.0.0.1', () => {
    console.log(`SENTRY public gateway: http://127.0.0.1:${values.port}/?sentry=1 (${values.control})`);
  });
}