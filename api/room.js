// Everything that happens around a game rather than inside one: opening a
// room, taking a seat, sizing the table, and starting the deal.

import { handler, json, readBody } from './_lib/http.js';
import { createRoom, presence, readRoom, update } from './_lib/store.js';
import {
  joinLobby, leaveSeat, makeRoom, newCode, normaliseCode, resetToLobby, seatOf,
  setSeatCount, startGame, takeSeat, viewFor, isHost, fail,
} from './_lib/rooms.js';
import { SPEED } from '../js/engine.js';

export default handler(async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'METHOD' });
  const body = await readBody(req);
  const action = String(body.action || '');

  if (action === 'create') return create(res, body);

  const code = normaliseCode(body.code);
  if (code.length !== 4) throw fail('BAD_CODE', 'That room code does not look right.');

  switch (action) {
    case 'peek': return peek(res, code, body);
    case 'join': return seatMe(res, code, body, 'join');
    case 'take': return seatMe(res, code, body, 'take');
    case 'leave': return leave(res, code, body);
    case 'seats':
    case 'speed':
    case 'start':
    case 'again': return hostAction(res, code, action, body);
    default: throw fail('BAD_ACTION', 'Unknown action.');
  }
});

async function create(res, body) {
  for (let i = 0; i < 6; i++) {
    const code = newCode();
    const { room, token } = makeRoom({
      code,
      name: body.name,
      speedKey: body.speedKey,
      seatCount: body.seats,
    });
    if (await createRoom(code, room)) {
      return json(res, 200, { token, view: viewFor(room, 0, { 0: Date.now() }) });
    }
  }
  throw fail('BUSY', 'Could not find a free room code — try again.');
}

/** Look at a room without committing to a seat — this is what a link opens. */
async function peek(res, code, body) {
  const hit = await readRoom(code);
  if (!hit) throw fail('NO_ROOM', 'That game has finished or expired.');
  const seat = seatOf(hit.room, body.token);
  return respond(res, code, hit.room, seat);
}

/**
 * `join` only ever seats you in a lobby; `take` also claims a named bot seat
 * mid-game. Both are idempotent: a reload with the same token gets its seat
 * back rather than a second one.
 */
async function seatMe(res, code, body, mode) {
  let issued = null;
  const out = await update(code, (room) => {
    const already = seatOf(room, body.token);
    if (already !== null) { issued = { seat: already, token: body.token }; return false; }
    if (room.status === 'lobby') { issued = joinLobby(room, body.name); return; }
    if (mode === 'join') throw fail('PLAYING', 'That game is already under way.');
    issued = takeSeat(room, Number(body.seat), body.name);
  });
  if (out.error) throw roomError(out.error);
  return respond(res, code, out.room, issued.seat, issued.token);
}

async function leave(res, code, body) {
  const out = await update(code, (room) => {
    const seat = seatOf(room, body.token);
    if (seat === null) return false;
    leaveSeat(room, seat);
  });
  if (out.error) throw roomError(out.error);
  return json(res, 200, { ok: true });
}

async function hostAction(res, code, action, body) {
  const out = await update(code, (room) => {
    if (!isHost(room, body.token)) throw fail('NOT_HOST', 'Only the host can change that.');
    if (action === 'seats') {
      if (room.status !== 'lobby') throw fail('STARTED', 'The table is set once the game begins.');
      setSeatCount(room, body.seats);
    } else if (action === 'speed') {
      if (room.status !== 'lobby') throw fail('STARTED', 'The table is set once the game begins.');
      if (!SPEED[body.speedKey]) throw fail('BAD_SPEED', 'Unknown speed.');
      room.speedKey = body.speedKey;
    } else if (action === 'again') {
      resetToLobby(room);
    } else {
      startGame(room);
    }
  });
  if (out.error) throw roomError(out.error);
  return respond(res, code, out.room, seatOf(out.room, body.token));
}

async function respond(res, code, room, seat, token) {
  const seen = await presence(code);
  if (seat !== null && seat !== undefined) seen[seat] = Date.now();
  return json(res, 200, { token, view: viewFor(room, seat ?? null, seen) });
}

function roomError(code) {
  return fail(code, code === 'NO_ROOM'
    ? 'That game has finished or expired.'
    : 'The table is busy — try that again.');
}
