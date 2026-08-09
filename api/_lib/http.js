// Shared plumbing for the three endpoints.

import { configured, credentialReport } from './store.js';

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return safeParse(req.body);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  return safeParse(Buffer.concat(chunks).toString('utf8'));
}

function safeParse(s) {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

/** Wrap a handler so thrown errors come back as tidy JSON. */
export function handler(fn) {
  return async (req, res) => {
    if (!configured) {
      const report = credentialReport();
      return json(res, 503, {
        error: 'NO_REDIS',
        message: report.seen.length
          ? `Online play is not configured. This deployment can see ${report.seen.join(', ')}, `
            + 'but not a matching REST url + token pair. A store that only gives a redis:// '
            + 'connection string will not work — it needs the REST API credentials.'
          : 'Online play is not configured — this deployment cannot see any Redis credentials '
            + 'at all. Connect a store, then redeploy: variables only reach a new build.',
        // Names only. Never the values.
        variables: report.seen,
      });
    }
    try {
      await fn(req, res);
    } catch (err) {
      if (err && err.expose) return json(res, 400, { error: err.code, message: err.message });
      console.error(err);
      // Say what actually went wrong. This is a game, not a bank, and "something
      // broke" costs more in log-diving than the detail could ever cost in leaks.
      json(res, 500, {
        error: 'SERVER',
        message: err && err.message ? `Server error: ${err.message}` : 'Something broke on the server.',
      });
    }
  };
}
