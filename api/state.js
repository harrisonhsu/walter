// The client's only read path: a long poll that also acts as the table's
// clock. While a browser is waiting here for something to change, it is also
// the thing that nudges the bots along — no cron, no background worker, and
// nothing to keep warm.

import { handler, json } from './_lib/http.js';
import {
  bumpTick, parseMeta, presence, readMeta, readRoom, touch, writeRoom,
} from './_lib/store.js';
import { normaliseCode, seatOf, tick, viewFor, fail } from './_lib/rooms.js';

const DEADLINE = 8000; // stay under the platform's function timeout
const STEP = 700;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default handler(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const code = normaliseCode(url.searchParams.get('code'));
  const token = url.searchParams.get('token') || '';
  const since = Number(url.searchParams.get('v') || 0);
  if (code.length !== 4) throw fail('BAD_CODE', 'That room code does not look right.');

  const first = await readRoom(code);
  if (!first) throw fail('NO_ROOM', 'That game has finished or expired.');

  const seat = seatOf(first.room, token);
  await touch(code, seat);
  if (first.room.v !== since) return send(res, code, first.room, seat);

  const until = Date.now() + DEADLINE;
  while (Date.now() < until) {
    const meta = await readMeta(code);
    if (!meta) throw fail('NO_ROOM', 'That game has finished or expired.');
    const { v, nextTickAt } = parseMeta(meta);

    if (v !== since) {
      const hit = await readRoom(code);
      if (!hit) throw fail('NO_ROOM', 'That game has finished or expired.');
      return send(res, code, hit.room, seat);
    }
    if (nextTickAt && Date.now() >= nextTickAt && (await runTick(code))) continue;

    await sleep(STEP + Math.floor(Math.random() * 120));
  }
  return json(res, 200, { v: since, unchanged: true });
});

/** Let the game take one step on its own. True when it was worth re-reading. */
async function runTick(code) {
  const hit = await readRoom(code);
  if (!hit) return false;
  const seen = await presence(code);
  const result = tick(hit.room, seen);
  if (result === 'changed') return Boolean(await writeRoom(code, hit.room, hit.meta));
  if (result === 'retick') return bumpTick(code, hit.meta, hit.room.nextTickAt);
  return false;
}

async function send(res, code, room, seat) {
  const seen = await presence(code);
  if (seat !== null) seen[seat] = Date.now();
  return json(res, 200, { view: viewFor(room, seat, seen) });
}
