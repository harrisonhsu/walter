// Room storage on Upstash Redis, over its REST API so the project keeps its
// "no dependencies, no build step" property.
//
// Two keys per room:
//   cactus:CODE     the room JSON
//   cactus:CODE:v   a tiny "<version>:<nextTickAt>" string
//
// Pollers only ever read the small key, which is what keeps the free tier
// happy: the big one is fetched exactly when something has actually changed.
// Writes are compare-and-set on the small key, so two players acting at the
// same instant can never interleave into a corrupt state — the loser re-reads
// and tries again.

// Which variables hold the credentials depends on how the store was attached:
// Vercel's own KV naming, Upstash's, and any prefix you chose when connecting
// (CACTUS_KV_REST_API_URL and friends) all turn up in the wild. Rather than
// guess, find any *_URL we recognise that has a matching *_TOKEN beside it.
const URL_SUFFIXES = ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'REDIS_REST_URL'];

function findCredentials(env) {
  for (const suffix of URL_SUFFIXES) {
    for (const key of Object.keys(env)) {
      if (key !== suffix && !key.endsWith(`_${suffix}`)) continue;
      const tokenKey = key.replace(/_URL$/, '_TOKEN');
      // Pasted values pick up stray whitespace and quotes remarkably often,
      // and an untrimmed url fails deep inside fetch() as "Invalid URL".
      const url = clean(env[key]);
      const token = clean(env[tokenKey]);
      if (url && token) return { url: url.replace(/\/+$/, ''), token, via: key };
    }
  }
  return null;
}

function clean(v) {
  // Trim, unwrap a quoted paste, then trim again — the spaces are often inside
  // the quotes rather than outside them.
  return String(v ?? '').trim().replace(/^["']|["']$/g, '').trim();
}

const creds = findCredentials(process.env);
const URL_BASE = creds && creds.url;
const TOKEN = creds && creds.token;

/** The url has to be the REST endpoint, not a redis:// connection string. */
export const credentialProblem = !creds
  ? null
  : /^https?:\/\//i.test(URL_BASE)
    ? null
    : `${creds.via} is "${URL_BASE.slice(0, 12)}…", which is not an https REST endpoint. `
      + 'Upstash shows two sets of credentials — this needs the REST API pair, not the '
      + 'redis:// connection string.';

export const configured = Boolean(URL_BASE && TOKEN && !credentialProblem);

/**
 * Variable names only — never values. Lets a deployment say what it can
 * actually see when the credentials are not where they were expected.
 */
export function credentialReport() {
  const seen = Object.keys(process.env)
    .filter((k) => /REDIS|KV_REST|UPSTASH/i.test(k))
    .sort();
  const report = { using: creds ? creds.via : null, seen, problem: credentialProblem };
  if (creds) {
    // The host is not a secret and identifies the database. The token's length
    // is the giveaway for the commonest mistake of all: copying a masked or
    // half-selected value. Upstash REST tokens are long.
    report.host = safeHost(URL_BASE);
    report.tokenLength = TOKEN.length;
    if (TOKEN.length < 40) report.tokenLooksTruncated = true;
  }
  return report;
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return null; }
}

/** One round trip, so a deployment can prove the store works. */
export async function ping() {
  const stamp = String(Date.now());
  await cmd(['SET', 'cactus:ping', stamp, 'EX', '60']);
  const back = await cmd(['GET', 'cactus:ping']);
  if (back !== stamp) throw new Error(`wrote ${stamp} but read back ${back}`);
  // The compare-and-set script is the one thing a plain GET/SET will not prove.
  const script = await cmd(['EVAL', "return redis.call('GET', KEYS[1])", '1', 'cactus:ping']);
  if (script !== stamp) throw new Error('Redis ran the script but returned the wrong value');
  return true;
}

export const TTL = 6 * 60 * 60; // rooms evaporate after six hours

const roomKey = (code) => `cactus:${code}`;
const metaKey = (code) => `cactus:${code}:v`;
const seenKey = (code) => `cactus:${code}:seen`;

async function call(path, body) {
  if (!configured) throw new Error('NO_REDIS');
  let res;
  try {
    res = await fetch(`${URL_BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`could not reach the Redis REST endpoint (${err.message})`);
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    // Upstash says why in the body — read-only token, wrong database, expired.
    // Passing it straight through beats any guess this code could make.
    throw new Error(
      `Redis rejected the token (${res.status}${text.trim() ? `: ${text.trim().slice(0, 160)}` : ''}). `
      + 'The url and token must come from the same database, and the token must be the '
      + 'full-access REST one, not the read-only variant.'
    );
  }
  if (!res.ok) throw new Error(`Redis returned ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Redis sent back something that is not JSON: ${text.slice(0, 120)}`);
  }
}

async function cmd(args) {
  const out = await call('', args);
  if (out && out.error) throw new Error(`Redis: ${out.error}`);
  return out ? out.result : null;
}

async function pipeline(cmds) {
  const out = await call('/pipeline', cmds);
  // A whole-pipeline failure comes back as a bare object, not a list.
  if (!Array.isArray(out)) throw new Error(`Redis: ${(out && out.error) || 'unexpected reply'}`);
  const bad = out.find((r) => r && r.error);
  if (bad) throw new Error(`Redis: ${bad.error}`);
  return out.map((r) => (r ? r.result : null));
}

/** The CAS token for a room — cheap to poll, and it doubles as the tick clock. */
export function metaOf(room) {
  return `${room.v}:${room.nextTickAt || 0}`;
}

export function parseMeta(meta) {
  const [v, tick] = String(meta || '0:0').split(':');
  return { v: Number(v) || 0, nextTickAt: Number(tick) || 0 };
}

export function readMeta(code) {
  return cmd(['GET', metaKey(code)]);
}

export async function readRoom(code) {
  const [meta, raw] = await pipeline([['GET', metaKey(code)], ['GET', roomKey(code)]]);
  if (!meta || !raw) return null;
  const room = JSON.parse(raw);
  // The meta key is the authority — a tick deadline can move without the room
  // being rewritten, so re-sync before anyone computes a new meta from it.
  Object.assign(room, parseMeta(meta));
  return { meta, room };
}

const RETICK = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1`;

/** Move a room's tick deadline without bumping its version. */
export async function bumpTick(code, expected, nextTickAt) {
  const { v } = parseMeta(expected);
  const ok = await cmd([
    'EVAL', RETICK, '1', metaKey(code), expected, `${v}:${nextTickAt}`, String(TTL),
  ]);
  return ok === 1;
}

/** Claim a code. Returns false if somebody else already has it. */
export async function createRoom(code, room) {
  const ok = await cmd(['SET', metaKey(code), metaOf(room), 'NX', 'EX', String(TTL)]);
  if (ok === null) return false;
  await cmd(['SET', roomKey(code), JSON.stringify(room), 'EX', String(TTL)]);
  return true;
}

const CAS = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[4]))
redis.call('SET', KEYS[2], ARGV[3], 'EX', tonumber(ARGV[4]))
return 1`;

/**
 * Bump the version and write, but only if nobody has written since `expected`.
 * Returns the new meta string, or null when we lost the race.
 */
export async function writeRoom(code, room, expected) {
  room.v = (room.v || 0) + 1;
  room.updatedAt = Date.now();
  const meta = metaOf(room);
  const ok = await cmd([
    'EVAL', CAS, '2', metaKey(code), roomKey(code),
    expected, meta, JSON.stringify(room), String(TTL),
  ]);
  return ok === 1 ? meta : null;
}

/**
 * Read → mutate → write, retrying when another request beat us to it.
 * `mutate` returns false to abandon the write, or throws {code, message}.
 */
export async function update(code, mutate, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const hit = await readRoom(code);
    if (!hit) return { error: 'NO_ROOM' };
    const result = mutate(hit.room);
    if (result === false) return { room: hit.room, meta: hit.meta, wrote: false };
    const meta = await writeRoom(code, hit.room, hit.meta);
    if (meta) return { room: hit.room, meta, wrote: true, extra: result };
  }
  return { error: 'BUSY' };
}

/** Presence lives outside the room so a heartbeat never bumps the version. */
export async function touch(code, seat) {
  if (seat === null || seat === undefined) return;
  await pipeline([
    ['HSET', seenKey(code), String(seat), String(Date.now())],
    ['EXPIRE', seenKey(code), String(TTL)],
  ]);
}

export async function presence(code) {
  const flat = await cmd(['HGETALL', seenKey(code)]);
  const out = {};
  if (Array.isArray(flat)) {
    for (let i = 0; i < flat.length; i += 2) out[Number(flat[i])] = Number(flat[i + 1]);
  } else if (flat && typeof flat === 'object') {
    for (const [k, val] of Object.entries(flat)) out[Number(k)] = Number(val);
  }
  return out;
}
