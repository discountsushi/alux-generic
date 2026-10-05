// HTTP layer: the pods API, the event stream, and static files from public/.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { podsStore } from './db.js';
import { createPods } from './pods/pods.js';
import { PodError } from './pods/protocol.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const MAX_BODY = 1024 * 1024;

// lib/pods errors by code -> HTTP status.
const POD_STATUS = { bad_request: 400, not_connected: 409, busy: 409, timeout: 504, unavailable: 503 };

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(payload);
}

export function createApp({ db, publicDir, lanUrls = () => [], version = '0.1.0', pods = null }) {
  const root = path.resolve(publicDir);
  pods ??= createPods({ store: podsStore(db) });
  const mode = 'pods';

  const routes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true, app: 'adaptalux-pods', version, mode })],
    ['GET', /^\/api\/bootstrap$/, () => ({ lan: lanUrls(), version, mode, pods: pods.snapshot() })],
    ['GET', /^\/api\/pods$/, () => pods.snapshot()],
    ['PUT', /^\/api\/pods\/config$/, ({ body }) => pods.setConfig(body || {})],
    ['POST', /^\/api\/pods\/connect$/, async ({ body }) => ({ problems: await pods.connect({ sim: Boolean(body?.sim) }), ...pods.snapshot() })],
    ['POST', /^\/api\/pods\/disconnect$/, async () => (await pods.disconnect(), pods.snapshot())],
    ['POST', /^\/api\/pods\/scan$/, async ({ body }) => ({ found: await pods.scan(Math.min(30000, Math.max(1000, Number(body?.ms) || 6000))) })],
    ['POST', /^\/api\/pods\/set$/, async ({ body }) => ({ set: await pods.setLevels(body?.levels || {}, { full: Boolean(body?.full), confirm: body?.confirm !== false }) })],
    ['POST', /^\/api\/pods\/all$/, async ({ body }) => ({ set: await pods.all(body?.pct ?? 100, { confirm: body?.confirm !== false }) })],
    ['PUT', /^\/api\/pods\/arms\/([\w-]+)\/label$/, ({ m, body }) => ({ label: pods.setLabel(m[1], body?.label ?? '') })],
    ['GET', /^\/api\/pods\/looks$/, () => pods.snapshot().looks],
    ['POST', /^\/api\/pods\/looks$/, ({ body }) => ({ name: body?.name, levels: pods.saveLook(body?.name, body?.levels ?? null) })],
    ['DELETE', /^\/api\/pods\/looks\/([^/]+)$/, ({ m }) => ({ deleted: pods.deleteLook(decodeURIComponent(m[1])) })],
    ['POST', /^\/api\/pods\/looks\/([^/]+)\/apply$/, async ({ m }) => ({ set: await pods.applyLook(decodeURIComponent(m[1])) })],
    [
      'POST',
      /^\/api\/pods\/rave$/,
      async ({ body }) => {
        if (body?.on === false) {
          await pods.stopRave({ restore: body?.restore !== false });
          return { rave: null };
        }
        return { rave: { bpm: await pods.startRave(body?.bpm ?? 128) } };
      },
    ],
  ];

  async function serveStatic(req, res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return send(res, 400, 'Bad path', 'text/plain');
    }
    if (rel.endsWith('/')) rel += 'index.html';
    if (rel === '/pods.html') rel = '/index.html';
    const file = path.resolve(root, `.${rel}`);
    if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      send(res, 404, 'Not found', 'text/plain');
    }
  }

  // Server-sent events: the pods' state whenever it changes, for every open page.
  function podEvents(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = (snap) => res.write(`event: pods\ndata: ${JSON.stringify(snap)}\n\n`);
    write(pods.snapshot());
    const unsubscribe = pods.subscribe(write);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/pods/events' && req.method === 'GET') return podEvents(req, res);
      if (url.pathname.startsWith('/api/')) {
        for (const [method, re, fn] of routes) {
          if (method !== req.method) continue;
          const m = re.exec(url.pathname);
          if (!m) continue;
          const body = method === 'POST' || method === 'PUT' ? await readBody(req) : undefined;
          return send(res, 200, await fn({ m, body, url, req }));
        }
        throw new HttpError(404, `No route for ${req.method} ${url.pathname}`);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return await serveStatic(req, res, url.pathname);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof PodError ? POD_STATUS[err.code] || 500 : 500;
      if (status === 500) console.error(err);
      return send(res, status, { error: status === 500 ? 'Server error' : err.message, ...(err instanceof PodError ? { code: err.code } : {}) });
    }
  }

  handler.pods = pods;
  return handler;
}
