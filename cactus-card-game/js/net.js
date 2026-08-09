// The online half of the client: talks to /api, and turns the per-seat view it
// gets back into something shaped exactly like a Game so ui.js cannot tell the
// difference between a solo game and a networked one.

import { Game, PHASE } from './engine.js';

const HIDDEN = { kind: 'hidden' };

async function api(path, init) {
  const res = await fetch(path, init);
  let data = {};
  try { data = await res.json(); } catch { /* empty or HTML error page */ }
  if (!res.ok) {
    const err = new Error(data.message || `Request failed (${res.status})`);
    err.code = data.error || 'HTTP';
    throw err;
  }
  return data;
}

const post = (path, body) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const tokenKey = (code) => `cactus:token:${code}`;

function rememberToken(code, token) {
  try { localStorage.setItem(tokenKey(code), token); } catch { /* private mode */ }
}

function recallToken(code) {
  try { return localStorage.getItem(tokenKey(code)) || ''; } catch { return ''; }
}

export class Session {
  constructor({ onUpdate, onError }) {
    this.onUpdate = onUpdate;
    this.onError = onError || (() => {});
    this.code = null;
    this.token = '';
    this.view = null;
    this.busy = false;   // a move is in flight
    this.local = null;   // half-finished target picking, client-side only
    this.offline = false;
    // A poll opened before we had a seat answers as a spectator, and can land
    // after the one that seated us. Every identity change bumps `gen`, and a
    // reply from an older generation is dropped on arrival.
    this.gen = 0;
    this.loopGen = -1;
  }

  // ------------------------------------------------------------ lifecycle

  adopt(code, token, view) {
    this.code = code;
    if (token) rememberToken(code, token);
    this.token = token || recallToken(code);
    this.gen++;
    this.apply(view);
    this.startPolling();
  }

  apply(view) {
    // Room versions only ever climb, so an older one is a reply that overtook
    // a newer one on the way back.
    if (this.view && view.v < this.view.v) return;
    this.view = view;
    this.onUpdate(view);
  }

  /** Re-render from the view we already have (after a local-only change). */
  refresh() {
    if (this.view) this.onUpdate(this.view);
  }

  stop() {
    this.gen++;
    this.loopGen = -1;
    this.code = null;
    this.view = null;
    this.local = null;
    this.busy = false;
  }

  async startPolling() {
    if (this.loopGen === this.gen) return; // already watching, as who we are now
    const gen = this.gen;
    const mine = this.code;
    this.loopGen = gen;
    let fails = 0;
    while (this.gen === gen && this.code === mine) {
      try {
        const v = this.view ? this.view.v : 0;
        const data = await api(
          `/api/state?code=${mine}&token=${encodeURIComponent(this.token)}&v=${v}`
        );
        if (this.gen !== gen || this.code !== mine) return;
        if (data.view) this.apply(data.view);
        if (this.offline) { this.offline = false; this.onError(null); }
        fails = 0;
      } catch (err) {
        if (this.gen !== gen || this.code !== mine) return;
        if (err.code === 'NO_ROOM') { this.gen++; return this.onError(err, true); }
        // A dropped connection is normal on a phone; keep quietly retrying.
        fails++;
        this.offline = true;
        if (fails === 2) this.onError(new Error('Reconnecting…'));
        await new Promise((r) => setTimeout(r, Math.min(6000, 400 * 2 ** fails)));
      }
    }
  }

  // --------------------------------------------------------------- lobby

  async create({ name, speedKey, seats }) {
    const out = await post('/api/room', { action: 'create', name, speedKey, seats });
    this.adopt(out.view.code, out.token, out.view);
  }

  async peek(code) {
    const out = await post('/api/room', { action: 'peek', code, token: recallToken(code) });
    return out.view;
  }

  /** Take a seat: in a lobby any free one, mid-game a specific bot's. */
  async sit(code, name, seat) {
    const out = await post('/api/room', {
      action: seat === undefined ? 'join' : 'take',
      code,
      name,
      seat,
      token: recallToken(code),
    });
    this.adopt(code, out.token, out.view);
  }

  async host(action, extra) {
    const out = await post('/api/room', { action, code: this.code, token: this.token, ...extra });
    this.apply(out.view);
  }

  async leave() {
    const { code, token } = this;
    this.stop();
    if (code) await post('/api/room', { action: 'leave', code, token }).catch(() => {});
  }

  // ---------------------------------------------------------------- play

  async send(msg) {
    if (this.busy) return;
    this.busy = true;
    this.local = null;
    this.refresh();
    try {
      const out = await post('/api/action', { code: this.code, token: this.token, ...msg });
      this.busy = false;
      this.apply(out.view);
    } catch (err) {
      this.busy = false;
      this.onError(err);
      this.refresh();
    }
  }

  /** A Game-shaped object for ui.js, built fresh from the latest view. */
  table() {
    if (!this.view || !this.view.game) return null;
    const g = hydrateView(this.view.game, this.view.seat);
    g.busy = this.busy;
    g.code = this.view.code;
    for (const s of this.view.seats) {
      if (g.players[s.i]) g.players[s.i].away = !s.here;
    }
    wire(g, this);
    return g;
  }
}

// ------------------------------------------------------------- view → game

function hydrateView(v, seat) {
  const g = Object.create(Game.prototype);
  g.paced = false;
  g.meId = seat;
  g.speed = 0;
  g.goal = v.goal;
  g.pointPile = v.pointPile;
  g.deck = new Array(v.deckCount).fill(HIDDEN);
  g.discard = v.discardTop ? [v.discardTop] : [];
  g.log = v.log;
  g.phase = v.phase;
  g.current = v.current;
  g.pending = v.pending;
  g.reveal = v.reveal;
  g.flash = null;
  g.timer = null;
  g.onChange = null;
  g.players = v.players.map((p) => ({
    id: p.id,
    name: p.name,
    isHuman: p.isHuman,
    points: p.points,
    // Other hands are face down, but the engine only ever counts them.
    hand: p.hand || Array.from({ length: p.handCount }, (_, i) => ({
      uid: `hidden:${p.id}:${i}`, kind: 'hidden',
    })),
  }));
  g.winner = v.winner === null || v.winner === undefined ? null : g.players[v.winner];
  return g;
}

/**
 * Replace the engine's mutators with ones that send instead. Target picking
 * stays on this side — the server only ever sees a finished play, so a player
 * halfway through choosing does not hold up the table.
 */
function wire(g, session) {
  const seat = g.meId;

  g.playAction = (playerId, uid, targets) => {
    if (playerId !== seat || g.phase !== PHASE.TURN || g.current !== seat) return false;
    const card = g.players[seat].hand.find((c) => c.uid === uid);
    if (!card) return false;
    const spec = g.targetSpec(card.kind, seat);
    if (!spec) return false;
    const t = { ...(targets || {}) };
    if (spec.need !== 'none' && !g.targetsComplete(spec, t)) {
      session.local = { actor: seat, uid, kind: card.kind, targets: t, spec, stops: 0, queue: [] };
      session.refresh();
      return true;
    }
    session.send({ type: 'play', uid, targets: t });
    return true;
  };

  g.provideTarget = (patch) => {
    const local = session.local;
    if (!local) return false;
    Object.assign(local.targets, patch);
    if (!g.targetsComplete(local.spec, local.targets)) { session.refresh(); return true; }
    session.send({ type: 'play', uid: local.uid, targets: local.targets });
    return true;
  };

  g.cancelTarget = () => { session.local = null; session.refresh(); };
  g.playSet = (playerId, uids) => { session.send({ type: 'set', uids }); return true; };
  g.drawAndEnd = () => { session.send({ type: 'draw' }); return true; };
  g.respondStop = (playerId, uid) => { session.send({ type: 'stop', uid }); return true; };
  g.seeStealTake = (uid) => { session.send({ type: 'seeSteal', uid }); return true; };
  g.changed = () => {};
  g.arm = () => {};
  g.destroy = () => {};

  // Overlay the half-finished play so the target sheet stays open across polls.
  if (session.local && g.phase === PHASE.TURN && g.current === seat) {
    g.phase = PHASE.CHOOSE_TARGET;
    g.pending = session.local;
  } else if (session.local) {
    session.local = null;
  }
}
