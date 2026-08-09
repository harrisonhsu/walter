// Open /api/health in a browser to find out whether online play will work,
// and if not, exactly which part is unhappy. Names of environment variables
// appear here; values never do.

import { json } from './_lib/http.js';
import { configured, credentialReport, ping } from './_lib/store.js';

export default async function handler(req, res) {
  const report = credentialReport();

  if (report.problem) {
    return json(res, 503, { ok: false, step: 'credentials', detail: report.problem, ...report });
  }
  if (!configured) {
    return json(res, 503, {
      ok: false,
      step: 'credentials',
      detail: report.seen.length
        ? 'Found Redis-ish variables, but no matching REST url + token pair.'
        : 'No Redis credentials visible. If you have just added them, redeploy — '
          + 'variables only reach a new build.',
      ...report,
    });
  }
  try {
    await ping();
    return json(res, 200, { ok: true, step: 'ready', using: report.using, host: report.host });
  } catch (err) {
    return json(res, 502, {
      ok: false,
      step: 'redis',
      detail: err.message,
      using: report.using,
      host: report.host,
      tokenLength: report.tokenLength,
      tokenLooksTruncated: report.tokenLooksTruncated,
    });
  }
}
