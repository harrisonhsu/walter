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

const URL_BASE =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.REDIS_REST_URL;

const TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.REDIS_REST_TOKEN;

export const configured = Boolean(URL_BASE && TOKEN);

export const TTL = 6 * 60 * 60; // rooms evaporate after six hours

const roomKey = (code) => `cactus:${code}`;
const metaKey = (code) => `cactus:${code}:v`;
const seenKey = (code) => `cactus:${code}:seen`;

async function call(path, body) {
  if (!configured) throw new Error('NO_REDIS');
  const res = await fetch(`${URL_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`redis ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function cmd(args) {
  const out = await call('', args);
  if (out.error) throw new Error(out.error);
  return out.result;
}

async function pipeline(cmds) {
  const out = await call('/pipeline', cmds);
  const bad = out.find((r) => r.error);
  if (bad) throw new Error(bad.error);
  return out.map((r) => r.result);
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
