// The local world for one browser run: the real xslop server on PGlite, and a TLS proxy that answers for
// x.com, twitter.com, mobile.x.com and x-slop.com. The release packages stay unmodified. No request
// leaves this machine: the API host goes to the local server, the X hosts to fixtures, and every other
// host is refused and recorded.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { createServer as createHttp, request as httpRequest } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { connect } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

export const CT0 = 'browserlane0csrf0token0value';
const AUTH_TOKEN = 'browserlane0session0cookie';
const API_HOST = 'x-slop.com';
const X_HOSTS = ['x.com', 'twitter.com', 'mobile.x.com'];
export const X_IDS = { slopbot: '1001', human_dev: '1002', quoter: '1003', photoguy: '1004', flaggedone: '1005', bob: '1006', alice: '1007', globalslop: '1008' };
const MUTE_PATH = /^\/i\/api\/1\.1\/mutes\/users\/(create|destroy|ids)\.json$/;
const NONCE = 'browserlaneNonce0';
// The directives of X's real policy (read from https://x.com/home) that can touch a content script.
const CSP = [
  "default-src 'self'", `script-src 'self' 'nonce-${NONCE}' 'unsafe-inline' 'report-sample'`, "script-src-attr 'none' 'report-sample'",
  "style-src 'self' 'unsafe-inline'", "style-src-elem 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "connect-src 'self' blob:",
  "font-src 'self' data:", "object-src 'none'",
].join(';');

/** Compiles the real server, the server's PGlite helper and the fixture menu script into one module under `work`. */
export async function prepareServer(repo, work) {
  const dir = join(work, 'server');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  for (const name of ['node_modules', 'migrations', 'config']) {
    if (!existsSync(join(dir, name))) symlinkSync(join(repo, 'server', name), join(dir, name));
  }
  await build({
    stdin: {
      resolveDir: repo,
      loader: 'ts',
      contents: `
        export { buildApp } from './server/src/app.ts';
        export { openTestDb } from './server/test/helpers/db.ts';
        export { importSeed } from './server/src/scripts/import-seed.ts';
        export { runScoreJob } from './server/src/jobs/score-job.ts';
        export { computeScores } from './server/src/scoring/index.ts';
        export { X_MENU_SCRIPT } from './extension/test/mock-server.ts';`,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'external',
    outfile: join(dir, 'dist', 'world.mjs'),
    logLevel: 'error',
  });
  const [key, cert] = [join(work, 'tls.key'), join(work, 'tls.crt')];
  if (!existsSync(key)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-keyout', key, '-out', cert, '-subj', '/CN=xslop-browser-test',
      '-addext', `subjectAltName=${[...X_HOSTS, API_HOST].map((h) => `DNS:${h}`).join(',')}`], { stdio: 'pipe' });
  }
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** Starts a fresh server and proxy. `powBits` is the difficulty that the real server asks for. */
export async function startWorld({ repo, work, powBits }) {
  const mod = await import(pathToFileURL(join(work, 'server/dist/world.mjs')).href);
  const tdb = await mod.openTestDb('pglite');
  await mod.importSeed(tdb.db, [join(repo, 'seed/ai-slop-list.json')]);
  await tdb.db.query("insert into accounts (handle, override) values ('globalslop', 'confirm')");
  await mod.runScoreJob(tdb.db, mod.computeScores);
  const app = await mod.buildApp({
    db: tdb.db,
    logger: false,
    config: {
      secret: randomBytes(32), ipSalt: randomBytes(32), powBits, siteOrigin: `https://${API_HOST}`,
      staticRoot: join(work, 'no-static-root'), configFile: join(repo, 'server/config/extension-config.json'), admin: null,
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const apiPort = app.server.address().port;

  const pages = {
    '/alice/status/100': readFileSync(join(repo, 'extension/test/fixtures/status.html'), 'utf8'),
    '/home': readFileSync(join(repo, 'extension/test/fixtures/home.html'), 'utf8'),
  };
  for (const p of Object.keys(pages)) pages[p] = pages[p].replace('</body>', `<script nonce="${NONCE}">${mod.X_MENU_SCRIPT}</script></body>`);

  const world = { api: [], x: [], refused: [], xAnswers: [], listSize: 0, sql: (text, params) => tdb.db.query(text, params).then((r) => r.rows) };
  world.listSize = (await world.sql("select count(*)::int as n from accounts where tier > 0"))[0].n;

  function forwardApi(req, res) {
    const entry = { method: req.method, path: req.url, status: 0, at: Date.now() };
    world.api.push(entry);
    if (req.url === '/api/v1/observations') {
      entry.body = [];
      req.on('data', (c) => entry.body.push(c));
    }
    const up = httpRequest({ host: '127.0.0.1', port: apiPort, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-for': '198.51.100.7' } }, (r) => {
      entry.status = r.statusCode;
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  }

  function answerX(op, form) {
    if (op === 'ids') return [200, { ids: [], next_cursor: 0, next_cursor_str: '0', previous_cursor_str: '0' }];
    const forced = world.xAnswers.shift();
    if (forced) return [forced.status, forced.json];
    if (op === 'destroy') return [200, { id_str: form.get('user_id') ?? '' }];
    const name = form.get('screen_name') ?? '';
    return [200, { id_str: X_IDS[name] ?? '1999', screen_name: name }];
  }

  function fixtureX(req, res, host) {
    const url = new URL(req.url, `https://${host}`);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const op = MUTE_PATH.exec(url.pathname)?.[1];
      if (op) {
        const body = Buffer.concat(chunks).toString('utf8');
        world.x.push({ host, method: req.method, path: url.pathname, query: url.search, op, headers: req.headers, body, at: Date.now() });
        const [status, json] = answerX(op, new URLSearchParams(body));
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
        return;
      }
      const page = pages[url.pathname];
      if (!page) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not routed');
        return;
      }
      const domain = host === 'twitter.com' ? 'twitter.com' : 'x.com';
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': CSP,
        'cross-origin-opener-policy': 'same-origin-allow-popups',
        'set-cookie': [`ct0=${CT0}; Path=/; Domain=.${domain}; Secure; SameSite=Lax`, `auth_token=${AUTH_TOKEN}; Path=/; Domain=.${domain}; Secure; HttpOnly; SameSite=None`],
      });
      res.end(page);
    });
  }

  const tls = createHttps({ key: readFileSync(join(work, 'tls.key')), cert: readFileSync(join(work, 'tls.crt')) }, (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    if (host === API_HOST) forwardApi(req, res);
    else if (X_HOSTS.includes(host)) fixtureX(req, res, host);
    else res.writeHead(421).end();
  });
  const tlsPort = await listen(tls);

  const tunnels = new Set();
  const proxy = createHttp((req, res) => {
    world.refused.push(req.headers.host ?? req.url);
    res.writeHead(403).end();
  });
  proxy.on('connect', (req, socket, head) => {
    socket.on('error', () => undefined); // a browser can reset a refused or finished tunnel at any time
    const [host, port] = (req.url ?? '').split(':');
    if (port !== '443' || (host !== API_HOST && !X_HOSTS.includes(host))) {
      world.refused.push(req.url);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const up = connect(tlsPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    tunnels.add(socket).add(up);
    up.on('error', () => socket.destroy());
    socket.on('close', () => up.destroy());
    up.on('close', () => tunnels.delete(up));
    socket.on('close', () => tunnels.delete(socket));
  });
  world.proxyPort = await listen(proxy);

  world.close = async () => {
    const closing = (server) => new Promise((r) => server.close(r));
    const shut = [closing(proxy), closing(tls)];
    for (const s of tunnels) s.destroy();
    proxy.closeAllConnections();
    tls.closeAllConnections();
    await Promise.all(shut);
    app.server.closeAllConnections();
    await app.close();
    await tdb.close();
  };
  return world;
}
