// Local dev server: serves the static game, runs the /api functions in
// process, and stands in for Upstash with an in-memory store. Lets you play a
// real online game across two browser tabs with no cloud account.
//
//   node scripts/dev-server.mjs
//
// The Redis shim understands only the handful of commands store.js uses, and
// recognises its two Lua scripts by name rather than running them — the real
// thing is what runs in production.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const PORT = Number(process.env.PORT || 3000);

// ------------------------------------------------------------- redis shim

const store = new Map(); // key -> { value, expires }

function live(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expires && hit.expires < Date.now()) { store.delete(key); return null; }
  return hit;
}

function run(args) {
  const [rawCmd, ...rest] = args;
  const cmd = String(rawCmd).toUpperCase();

  if (cmd === 'GET') {
    const hit = live(rest[0]);
    return hit ? hit.value : null;
  }
  if (cmd === 'SET') {
    const [key, value, ...opts] = rest;
    const flags = opts.map((o) => String(o).toUpperCase());
    if (flags.includes('NX') && live(key)) return null;
    const exAt = flags.indexOf('EX');
    const expires = exAt === -1 ? 0 : Date.now() + Number(opts[exAt + 1]) * 1000;
    store.set(key, { value: String(value), expires });
    return 'OK';
  }
  if (cmd === 'HSET') {
    const [key, field, value] = rest;
    const hit = live(key) || { value: {}, expires: 0 };
    hit.value[field] = String(value);
    store.set(key, hit);
    return 1;
  }
  if (cmd === 'HGETALL') {
    const hit = live(rest[0]);
    if (!hit) return [];
    return Object.entries(hit.value).flat();
  }
  if (cmd === 'EXPIRE') {
    const hit = live(rest[0]);
    if (hit) hit.expires = Date.now() + Number(rest[1]) * 1000;
    return hit ? 1 : 0;
  }
  if (cmd === 'EVAL') {
    const [script, nKeys, ...tail] = rest;
    const keys = tail.slice(0, Number(nKeys));
    const argv = tail.slice(Number(nKeys));
    if (!argv.length) return run(['GET', keys[0]]); // the health check's probe
    const current = live(keys[0]);
    if (!current || current.value !== argv[0]) return 0;
    const ttl = script.includes('KEYS[2]') ? argv[3] : argv[2];
    run(['SET', keys[0], argv[1], 'EX', ttl]);
    if (script.includes('KEYS[2]')) run(['SET', keys[1], argv[2], 'EX', ttl]);
    return 1;
  }
  throw new Error(`dev redis: unsupported command ${cmd}`);
}

process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}/__redis`;
process.env.KV_REST_API_TOKEN = 'dev';

// The API modules read the env above at import time, so they load after it.
const routes = {
  '/api/room': (await import('../api/room.js')).default,
  '/api/action': (await import('../api/action.js')).default,
  '/api/state': (await import('../api/state.js')).default,
  '/api/health': (await import('../api/health.js')).default,
};

// ---------------------------------------------------------------- statics

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/__redis')) {
    const payload = JSON.parse((await body(req)) || '[]');
    const single = (args) => {
      try { return { result: run(args) }; } catch (e) { return { error: e.message }; }
    };
    const out = url.pathname.endsWith('/pipeline') ? payload.map(single) : single(payload);
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(out));
  }

  const route = routes[url.pathname];
  if (route) return route(req, res);

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const path = normalize(join(ROOT, rel));
  if (!path.startsWith(ROOT + sep)) { res.statusCode = 403; return res.end('nope'); }
  try {
    const file = await readFile(path);
    res.setHeader('Content-Type', TYPES[extname(path)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(file);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`cactus dev server  →  http://localhost:${PORT}`);
  console.log('online play uses an in-memory store; restarting drops every room');
});
