// The room model: seats, the lobby, and the bridge between a seat's request
// and the rules engine. Everything here is a pure function of a room object —
// reading and writing rooms is store.js's job.

import { randomBytes } from 'node:crypto';
import { Game, PHASE, SPEED } from '../../js/engine.js';
import { goalForPlayers } from '../../js/cards.js';
import { botName, cleanName } from '../../js/names.js';

export const MIN_SEATS = 2;
export const MAX_SEATS = 6;

/** How long a seat can go quiet before the table plays on without them. */
export const AWAY_MS = 30000;

// No 0/O/1/I — these get read off a screen and typed by hand.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

export function newToken() {
  return randomBytes(16).toString('hex');
}

export function normaliseCode(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

// ------------------------------------------------------------------- seats

function names(room) {
  return room.seats.map((s) => s.name);
}

function botSeat(room) {
  return { kind: 'bot', name: botName(names(room)), token: null };
}

export function makeRoom({ code, name, speedKey = 'normal', seatCount = 3 }) {
  const count = clampSeats(seatCount);
  const token = newToken();
  const room = {
    code,
    v: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'lobby',
    speedKey: SPEED[speedKey] ? speedKey : 'normal',
    hostToken: token,
    seats: [{ kind: 'human', name: cleanName(name, 'Host'), token }],
    game: null,
    nextTickAt: 0,
  };
  while (room.seats.length < count) room.seats.push(botSeat(room));
  return { room, token };
}

export function clampSeats(n) {
  return Math.max(MIN_SEATS, Math.min(MAX_SEATS, Number(n) || MIN_SEATS));
}

export function seatOf(room, token) {
  if (!token) return null;
  const i = room.seats.findIndex((s) => s.token && s.token === token);
  return i === -1 ? null : i;
}

export function isHost(room, token) {
  return Boolean(token) && room.hostToken === token;
}

function humanSeats(room) {
  return room.seats.filter((s) => s.kind === 'human').length;
}

/** Promote somebody else to host when the host walks out. */
function rehost(room) {
  if (room.seats.some((s) => s.token === room.hostToken)) return;
  const next = room.seats.find((s) => s.kind === 'human');
  room.hostToken = next ? next.token : null;
}

// ------------------------------------------------------------------- lobby

export function setSeatCount(room, n) {
  const want = clampSeats(n);
  if (want === room.seats.length) return;
  while (room.seats.length < want) room.seats.push(botSeat(room));
  // Only bots can be squeezed out, and only from the end of the table.
  while (room.seats.length > want) {
    const last = room.seats.length - 1;
    const drop = room.seats[last].kind === 'bot'
      ? last
      : room.seats.map((s, i) => (s.kind === 'bot' ? i : -1)).filter((i) => i >= 0).pop();
    if (drop === undefined || drop < 0) break; // all humans — cannot shrink further
    room.seats.splice(drop, 1);
  }
}

/** Seat a new arrival in the lobby. Throws when the table is full. */
export function joinLobby(room, name) {
  const i = room.seats.findIndex((s) => s.kind === 'bot');
  if (i === -1) throw fail('FULL', 'That game is full.');
  const token = newToken();
  room.seats[i] = { kind: 'human', name: cleanName(name, `Player ${i + 1}`), token };
  return { seat: i, token };
}

/** Claim a bot's seat — and its hand — in a game already under way. */
export function takeSeat(room, seatIdx, name) {
  const seat = room.seats[seatIdx];
  if (!seat) throw fail('NO_SEAT', 'That seat does not exist.');
  if (seat.kind !== 'bot') throw fail('TAKEN', 'Somebody is already in that seat.');
  const token = newToken();
  const clean = cleanName(name, seat.name);
  room.seats[seatIdx] = { kind: 'human', name: clean, token };
  if (room.game) {
    const p = room.game.players[seatIdx];
    p.name = clean;
    p.isHuman = true;
    room.game.log.push({
      text: `${clean} took over ${seat.name}'s seat.`, tone: 'sys', n: room.game.log.length,
    });
    // A bot was about to move; give the human the normal away-grace instead.
    room.nextTickAt = Date.now() + AWAY_MS;
  }
  rehost(room);
  return { seat: seatIdx, token };
}

/** Hand a seat back to a bot. */
export function leaveSeat(room, seatIdx) {
  const seat = room.seats[seatIdx];
  if (!seat || seat.kind !== 'human') return false;
  const bot = botSeat(room);
  room.seats[seatIdx] = bot;
  if (room.game) {
    const p = room.game.players[seatIdx];
    p.isHuman = false;
    room.game.log.push({
      text: `${p.name} left — ${bot.name} is playing that hand.`, tone: 'sys', n: room.game.log.length,
    });
    p.name = bot.name;
    room.nextTickAt = Date.now(); // the bot can move immediately
  }
  rehost(room);
  if (room.status === 'lobby' && humanSeats(room) === 0) room.dead = true;
  return true;
}

/** Send everyone back to the lobby with their seats intact. */
export function resetToLobby(room) {
  room.status = 'lobby';
  room.game = null;
  room.nextTickAt = 0;
}

export function startGame(room) {
  if (room.status !== 'lobby') throw fail('STARTED', 'That game has already started.');
  const players = room.seats.map((s) => ({ name: s.name, isHuman: s.kind === 'human' }));
  const game = new Game({
    players,
    speed: SPEED[room.speedKey] || SPEED.normal,
    paced: false,
  });
  room.status = 'playing';
  room.game = game.snapshot();
  scheduleTick(room, game);
}

// -------------------------------------------------------------------- play

/** When should somebody next look at this game and nudge it along? */
function scheduleTick(room, game) {
  if (game.phase === PHASE.GAME_OVER) { room.nextTickAt = 0; return; }
  // Waiting on a bot: the pacing delay. Waiting on a human: the away timeout,
  // after which a poller checks whether they are still around.
  room.nextTickAt = Date.now() + (game.needsAuto() ? game.speed : AWAY_MS);
}

/**
 * Advance the game by one automatic step if one is due.
 * Returns 'changed' (rewrite the room), 'retick' (only the deadline moved),
 * or false (nothing to do).
 */
export function tick(room, seen = {}) {
  if (room.status !== 'playing' || !room.game) return false;
  const game = Game.hydrate(room.game);
  if (game.phase === PHASE.GAME_OVER) {
    if (!room.nextTickAt) return false;
    room.nextTickAt = 0;
    return 'retick';
  }
  const now = Date.now();
  if (now < (room.nextTickAt || 0)) return false;

  let force = false;
  if (!game.needsAuto()) {
    const who = game.waitingOn();
    if (!who) return false;
    if (now - (seen[who.id] || 0) < AWAY_MS) {
      room.nextTickAt = now + AWAY_MS; // still with us — check again later
      return 'retick';
    }
    force = true; // gone quiet: play their seat for them so nobody is stuck
  }

  game.autoStep(force);
  room.game = game.snapshot();
  scheduleTick(room, game);
  return 'changed';
}

/** Apply one thing a seat asked to do. Throws on anything illegal. */
export function applyAction(room, seat, msg) {
  if (room.status !== 'playing' || !room.game) throw fail('NOT_PLAYING', 'No game is running.');
  if (seat === null) throw fail('NO_SEAT', 'You are not seated at this table.');

  const game = Game.hydrate(room.game);
  if (game.phase === PHASE.GAME_OVER) throw fail('OVER', 'The game is over.');

  let ok = false;
  switch (msg.type) {
    case 'play':
      ok = game.playAction(seat, String(msg.uid), sanitiseTargets(msg.targets));
      break;
    case 'set':
      ok = game.playSet(seat, (msg.uids || []).map(String));
      break;
    case 'draw':
      ok = game.drawAndEnd(seat);
      break;
    case 'stop':
      ok = game.respondStop(seat, msg.uid ? String(msg.uid) : null);
      break;
    case 'seeSteal':
      ok = game.seeStealTake(String(msg.uid));
      break;
    default:
      throw fail('BAD_ACTION', 'Unknown action.');
  }
  // The engine parks in CHOOSE_TARGET when a play arrives half-finished. The
  // client is supposed to send complete targets, so treat it as a bad request.
  if (game.phase === PHASE.CHOOSE_TARGET) throw fail('BAD_TARGET', 'That card needs a target.');
  if (!ok) throw fail('ILLEGAL', 'You cannot do that right now.');

  room.game = game.snapshot();
  scheduleTick(room, game);
  return true;
}

function sanitiseTargets(t) {
  if (!t || typeof t !== 'object') return {};
  const out = {};
  for (const k of ['player', 'a', 'b']) {
    if (typeof t[k] === 'number' && Number.isInteger(t[k])) out[k] = t[k];
  }
  if (typeof t.kind === 'string') out.kind = t.kind;
  return out;
}

// ------------------------------------------------------------------- views

/** What one seat is allowed to know. Everything else stays on the server. */
export function viewFor(room, seat, seen = {}) {
  const now = Date.now();
  return {
    code: room.code,
    v: room.v,
    status: room.status,
    seat,
    isHost: seat !== null && room.seats[seat]?.token === room.hostToken,
    speedKey: room.speedKey,
    seatCount: room.seats.length,
    goal: goalForPlayers(room.seats.length),
    seats: room.seats.map((s, i) => ({
      i,
      name: s.name,
      bot: s.kind === 'bot',
      here: s.kind === 'bot' || now - (seen[i] || 0) < AWAY_MS,
      you: i === seat,
      host: Boolean(s.token) && s.token === room.hostToken,
    })),
    game: room.game ? gameView(room.game, seat) : null,
  };
}

function gameView(snap, seat) {
  const g = Game.hydrate(snap);
  const me = seat === null ? -1 : seat;
  const revealing = g.phase === PHASE.SEE_STEAL_PICK && g.pending && g.pending.actor === me;
  return {
    goal: g.goal,
    pointPile: g.pointPile,
    deckCount: g.deck.length,
    discardTop: g.discard[g.discard.length - 1] || null,
    phase: g.phase,
    current: g.current,
    winner: g.winner ? g.winner.id : null,
    players: g.players.map((p) => ({
      id: p.id,
      name: p.name,
      isHuman: p.isHuman,
      points: p.points,
      handCount: p.hand.length,
      hand: p.id === me ? p.hand : null,
    })),
    pending: g.pending
      ? {
        actor: g.pending.actor,
        kind: g.pending.kind,
        stops: g.pending.stops || 0,
        queue: g.pending.queue || [],
        targets: g.pending.targets || {},
      }
      : null,
    log: g.visibleLog(me).slice(-40),
    reveal: revealing
      ? { player: g.pending.targets.player, hand: g.player(g.pending.targets.player).hand }
      : null,
  };
}

// ------------------------------------------------------------------ errors

export function fail(code, message) {
  const e = new Error(message || code);
  e.expose = true;
  e.code = code;
  return e;
}
