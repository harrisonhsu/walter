// One move, from one seat.

import { handler, json, readBody } from './_lib/http.js';
import { presence, touch, update } from './_lib/store.js';
import { applyAction, normaliseCode, seatOf, viewFor, fail } from './_lib/rooms.js';

export default handler(async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'METHOD' });
  const body = await readBody(req);
  const code = normaliseCode(body.code);
  if (code.length !== 4) throw fail('BAD_CODE', 'That room code does not look right.');

  let seat = null;
  const out = await update(code, (room) => {
    seat = seatOf(room, body.token);
    if (seat === null) throw fail('NO_SEAT', 'You are not seated at this table.');
    applyAction(room, seat, body);
  });
  if (out.error) {
    throw fail(out.error, out.error === 'NO_ROOM'
      ? 'That game has finished or expired.'
      : 'Somebody moved at the same time — try again.');
  }

  await touch(code, seat);
  const seen = await presence(code);
  return json(res, 200, { view: viewFor(out.room, seat, seen) });
});
