// Rule engine for The Cactus Card Game.
//
// In paced mode (the browser's solo game) the engine owns its own clock: after
// every state change it schedules the next automatic step (an AI turn, an AI
// stop response, the next player's turn) and simply stops when it needs input
// from a human.
//
// In unpaced mode it keeps no timers and never calls back — the online server
// hydrates a game, applies exactly one thing, and serialises it again. Both
// modes run this same file, so the rules only exist in one place.

import {
  KINDS, buildDeck, evaluateSet, goalForPlayers, POINT_PILE_SIZE,
} from './cards.js';
import { aiChooseTurn, aiWantsStop, aiPickFromHand } from './ai.js';

export const PHASE = {
  TURN: 'turn',
  CHOOSE_TARGET: 'choose-target',
  STOP_WINDOW: 'stop-window',
  SEE_STEAL_PICK: 'see-steal-pick',
  GAME_OVER: 'game-over',
};

export const SPEED = { fast: 380, normal: 750, slow: 1200 };

function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export class Game {
  constructor({ players, speed = SPEED.normal, paced = true }) {
    this.speed = speed;
    this.paced = paced;
    this.players = players.map((p, i) => ({
      id: i,
      name: p.name,
      isHuman: !!p.isHuman,
      hand: [],
      points: 0,
      wins: p.wins || 0, // carried between games at the same table
    }));
    this.goal = goalForPlayers(this.players.length);
    this.pointPile = POINT_PILE_SIZE;
    this.deck = shuffle(buildDeck());
    this.discard = [];
    this.log = [];
    this.pending = null;
    this.winner = null;
    this.timer = null;
    this.onChange = null;
    this.meId = null;   // which seat is looking; null = "the only human"
    this.flash = null;  // transient banner, cleared on next change

    for (let i = 0; i < 5; i++) {
      for (const p of this.players) p.hand.push(this.deck.pop());
    }

    // Nobody deals themselves the first turn — toss for it.
    this.current = Math.floor(Math.random() * this.players.length);
    this.firstPlayer = this.current;
    this.phase = PHASE.TURN;
    this.say(`Goal: first to ${this.goal} point${this.goal === 1 ? '' : 's'}.`, 'sys');
    this.say(`${this.cur().name} won the toss and goes first.`, 'sys');
    this.beginTurn();
  }

  // ------------------------------------------------------------ persistence

  /** Everything needed to rebuild this game verbatim. */
  snapshot() {
    return {
      speed: this.speed,
      goal: this.goal,
      pointPile: this.pointPile,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, isHuman: p.isHuman, hand: p.hand, points: p.points, wins: p.wins || 0,
      })),
      firstPlayer: this.firstPlayer,
      deck: this.deck,
      discard: this.discard,
      log: this.log,
      pending: this.pending,
      current: this.current,
      phase: this.phase,
      emptyTurns: this.emptyTurns || 0,
      winner: this.winner ? this.winner.id : null,
    };
  }

  /** Rebuild from a snapshot without dealing a new game. */
  static hydrate(s, { paced = false, meId = null } = {}) {
    const g = Object.create(Game.prototype);
    Object.assign(g, s, {
      players: s.players.map((p) => ({ ...p, hand: [...p.hand] })),
      paced,
      meId,
      timer: null,
      onChange: null,
      flash: null,
    });
    // `winner` is a reference, so it has to point at our own player object.
    g.winner = s.winner === null || s.winner === undefined ? null : g.players[s.winner];
    return g;
  }

  // ---------------------------------------------------------------- helpers

  cur() { return this.players[this.current]; }
  /** The seat this copy of the game is being viewed from. */
  human() {
    return this.meId === null || this.meId === undefined
      ? this.players.find((p) => p.isHuman)
      : this.players[this.meId];
  }
  player(id) { return this.players[id]; }

  /**
   * `priv` marks a line that some seats see differently:
   * `{ alt: 'the version with the secret in it', only: [playerId, …] }`.
   */
  say(text, tone = 'info', priv = null) {
    const entry = { text, tone, n: this.log.length };
    if (priv) { entry.alt = priv.alt; entry.only = priv.only; }
    this.log.push(entry);
    if (this.log.length > 120) this.log.shift();
  }

  /** Ranked table: points, then games won, then name. */
  standings() {
    return [...this.players].sort(
      (a, b) => b.points - a.points || (b.wins || 0) - (a.wins || 0) || a.name.localeCompare(b.name)
    );
  }

  /** The log as the seat we are looking from should read it. */
  logView() {
    const me = this.human();
    return this.visibleLog(me ? me.id : -1);
  }

  /** The log as one seat should read it. */
  visibleLog(seatId) {
    return this.log.map((l) => ({
      text: l.only && l.only.includes(seatId) ? l.alt : l.text,
      tone: l.tone,
      n: l.n,
    }));
  }

  changed(flash) {
    if (flash !== undefined) this.flash = flash;
    this.onChange?.(this);
    this.arm();
  }

  destroy() {
    clearTimeout(this.timer);
    this.timer = null;
    this.onChange = null;
  }

  /** Who, if anyone, are we blocked on? Returns a player or null. */
  waitingOn() {
    switch (this.phase) {
      case PHASE.TURN:
      case PHASE.CHOOSE_TARGET:
      case PHASE.SEE_STEAL_PICK:
        return this.phase === PHASE.TURN ? this.cur() : this.player(this.pending.actor);
      case PHASE.STOP_WINDOW: {
        const id = this.pending.queue[0];
        return id === undefined ? null : this.player(id);
      }
      default:
        return null;
    }
  }

  arm() {
    if (!this.paced || this.timer || this.phase === PHASE.GAME_OVER) return;
    const who = this.waitingOn();
    if (who && who.isHuman) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.autoStep();
    }, this.speed);
  }

  /** Is there a move the engine can make on its own right now? */
  needsAuto() {
    if (this.phase === PHASE.GAME_OVER) return false;
    const who = this.waitingOn();
    return !who || !who.isHuman;
  }

  /**
   * Take one automatic step. `force` plays a human's seat for them, which the
   * server uses when somebody has walked away from the table.
   */
  autoStep(force = false) {
    if (this.phase === PHASE.GAME_OVER) return;
    const who = this.waitingOn();
    if (!who) {
      if (this.phase === PHASE.STOP_WINDOW) this.resolvePending();
      return;
    }
    if (who.isHuman && !force) return;

    if (this.phase === PHASE.STOP_WINDOW) {
      const stopCard = who.hand.find((c) => c.kind === 'stop');
      if (stopCard && aiWantsStop(this, who)) this.respondStop(who.id, stopCard.uid);
      else this.respondStop(who.id, null);
      return;
    }
    if (this.phase === PHASE.TURN) {
      aiChooseTurn(this, who);
      return;
    }
    if (this.phase === PHASE.SEE_STEAL_PICK) {
      const victim = this.player(this.pending.targets.player);
      this.seeStealTake(aiPickFromHand(this, who, victim));
      return;
    }
    // A bot always supplies its targets up front and the online client only
    // sends complete ones, so CHOOSE_TARGET here means something went wrong.
    // Fail safe by ending the turn.
    this.endTurn();
  }

  // ------------------------------------------------------------------ cards

  drawOne(player) {
    if (!this.deck.length) this.reshuffle();
    if (!this.deck.length) return null;
    const card = this.deck.pop();
    player.hand.push(card);
    return card;
  }

  drawMany(player, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const c = this.drawOne(player);
      if (c) out.push(c);
    }
    return out;
  }

  reshuffle() {
    if (this.discard.length <= 1) return;
    const top = this.discard.pop();
    this.deck = shuffle(this.discard);
    this.discard = [top];
    this.say('Draw pile empty — the discard pile is shuffled back in.', 'sys');
  }

  toDiscard(card) { this.discard.push(card); }

  take(player, uid) {
    const i = player.hand.findIndex((c) => c.uid === uid);
    return i === -1 ? null : player.hand.splice(i, 1)[0];
  }

  gainPoints(player, n, reason) {
    let got = 0;
    for (let i = 0; i < n && this.pointPile > 0; i++) { this.pointPile--; got++; }
    player.points += got;
    this.say(`${player.name} ${reason} — ${got} point${got === 1 ? '' : 's'} (now ${player.points}).`, 'point');
    this.checkWin(player);
    return got;
  }

  movePoint(from, to) {
    if (from.points <= 0) return false;
    from.points--;
    to.points++;
    this.say(`${to.name} stole a point from ${from.name}.`, 'point');
    this.checkWin(to);
    return true;
  }

  checkWin(player) {
    if (player.points >= this.goal && !this.winner) {
      this.win(player, `${player.name} wins with ${player.points} points!`);
    }
  }

  /** Only ever runs once per game, so it is safe to tally the win here. */
  win(player, message) {
    this.winner = player;
    player.wins = (player.wins || 0) + 1;
    this.phase = PHASE.GAME_OVER;
    this.say(message, 'win');
  }

  // ------------------------------------------------------------------ turns

  beginTurn() {
    if (this.phase === PHASE.GAME_OVER) return;
    const p = this.cur();
    this.pending = null;
    this.phase = PHASE.TURN;
    if (p.hand.length === 0) {
      const drawn = this.drawMany(p, 3);
      this.say(
        drawn.length
          ? `${p.name} starts with no cards — draws 3 and ends their turn.`
          : `${p.name} has no cards and nothing to draw.`,
        'sys'
      );
      // If nobody can draw any more we would loop forever; call it on points.
      this.emptyTurns = drawn.length ? 0 : (this.emptyTurns || 0) + 1;
      if (this.emptyTurns > this.players.length) {
        const best = [...this.players].sort((a, b) => b.points - a.points)[0];
        this.win(best, `No cards left anywhere — ${best.name} wins on points.`);
        return;
      }
      this.endTurn();
      return;
    }
    this.emptyTurns = 0;
  }

  endTurn() {
    if (this.phase === PHASE.GAME_OVER) return;
    this.pending = null;
    this.current = (this.current + 1) % this.players.length;
    this.beginTurn();
  }

  /**
   * Emptying your hand ends your turn on the spot — there is nothing left to
   * play and drawing a single card to end would rob you of the pick-up. You
   * come back next turn to draw 3 (see beginTurn).
   * Returns true if the turn was ended.
   */
  checkOutOfCards() {
    if (this.phase !== PHASE.TURN) return false;
    const p = this.cur();
    if (p.hand.length) return false;
    this.say(`${p.name} is out of cards — they pick up 3 next turn.`, 'sys');
    this.endTurn();
    return true;
  }

  /** Voluntarily end the turn by drawing a card. */
  drawAndEnd(playerId) {
    if (this.phase !== PHASE.TURN || playerId !== this.current) return false;
    const p = this.cur();
    const c = this.drawOne(p);
    this.say(`${p.name} drew a card to end their turn.`, 'draw');
    this.endTurn();
    this.changed(c ? null : 'No cards left to draw.');
    return true;
  }

  // ------------------------------------------------------------- playing

  /** What a card needs before it can be played, or null if unplayable now. */
  targetSpec(kindId, actorId) {
    const k = KINDS[kindId];
    if (!k.target) return { need: 'none' };
    const others = this.players.filter((p) => p.id !== actorId);
    if (k.target === 'player') {
      const opts = others.filter((p) => p.points > 0);
      return opts.length ? { need: 'player', options: opts.map((p) => p.id) } : null;
    }
    if (k.target === 'playerWithCards') {
      const opts = others.filter((p) => p.hand.length > 0);
      return opts.length ? { need: 'player', options: opts.map((p) => p.id) } : null;
    }
    if (k.target === 'playerAndKind') {
      const opts = others.filter((p) => p.hand.length > 0);
      return opts.length ? { need: 'playerAndKind', options: opts.map((p) => p.id) } : null;
    }
    if (k.target === 'twoPlayers') {
      return this.players.length >= 2
        ? { need: 'twoPlayers', options: this.players.map((p) => p.id) }
        : null;
    }
    return { need: 'none' };
  }

  canPlayAction(kindId, actorId) {
    const k = KINDS[kindId];
    if (!k || (k.type !== 'action')) return false;
    return this.targetSpec(kindId, actorId) !== null;
  }

  /**
   * Play an action card. `targets` may be omitted for the human — the engine
   * parks in CHOOSE_TARGET and the UI fills it in via provideTarget().
   */
  playAction(playerId, uid, targets) {
    if (this.phase !== PHASE.TURN || playerId !== this.current) return false;
    const p = this.cur();
    const card = p.hand.find((c) => c.uid === uid);
    if (!card) return false;
    const k = KINDS[card.kind];
    if (k.type !== 'action') return false;

    const spec = this.targetSpec(card.kind, playerId);
    if (!spec) return false;

    this.pending = { actor: playerId, uid, kind: card.kind, targets: targets || {}, stops: 0, queue: [] };

    if (spec.need !== 'none' && !this.targetsComplete(spec, this.pending.targets)) {
      this.pending.spec = spec;
      this.phase = PHASE.CHOOSE_TARGET;
      this.changed();
      return true;
    }
    this.commitPending();
    return true;
  }

  targetsComplete(spec, t) {
    if (spec.need === 'none') return true;
    if (spec.need === 'player') return typeof t.player === 'number';
    if (spec.need === 'playerAndKind') return typeof t.player === 'number' && !!t.kind;
    if (spec.need === 'twoPlayers') return typeof t.a === 'number' && typeof t.b === 'number' && t.a !== t.b;
    return true;
  }

  provideTarget(targets) {
    if (this.phase !== PHASE.CHOOSE_TARGET) return false;
    Object.assign(this.pending.targets, targets);
    if (!this.targetsComplete(this.pending.spec, this.pending.targets)) {
      this.changed();
      return true;
    }
    this.commitPending();
    return true;
  }

  cancelTarget() {
    if (this.phase !== PHASE.CHOOSE_TARGET) return;
    this.pending = null;
    this.phase = PHASE.TURN;
    this.changed();
  }

  /** Card leaves the hand, goes on the discard pile, and the STOP window opens. */
  commitPending() {
    const pend = this.pending;
    const actor = this.player(pend.actor);
    const card = this.take(actor, pend.uid);
    if (!card) { this.pending = null; this.phase = PHASE.TURN; return this.changed(); }
    this.toDiscard(card);
    this.say(`${actor.name} played ${KINDS[card.kind].name}${this.describeTarget(pend)}.`, 'play');
    this.openStopWindow(pend.actor);
  }

  describeTarget(pend) {
    const t = pend.targets || {};
    if (typeof t.player === 'number') {
      const who = this.player(t.player).name;
      return t.kind ? ` — asking ${who} for ${KINDS[t.kind].name}` : ` on ${who}`;
    }
    if (typeof t.a === 'number') return ` — ${this.player(t.a).name} ↔ ${this.player(t.b).name}`;
    return '';
  }

  openStopWindow(lastPlayerId) {
    const queue = [];
    const n = this.players.length;
    for (let i = 1; i < n; i++) {
      const id = (lastPlayerId + i) % n;
      if (this.players[id].hand.some((c) => c.kind === 'stop')) queue.push(id);
    }
    this.pending.queue = queue;
    this.pending.lastPlayer = lastPlayerId;
    if (!queue.length) return this.resolvePending();
    this.phase = PHASE.STOP_WINDOW;
    this.changed();
  }

  respondStop(playerId, uid) {
    if (this.phase !== PHASE.STOP_WINDOW) return false;
    if (this.pending.queue[0] !== playerId) return false;
    const p = this.player(playerId);
    if (uid) {
      const card = this.take(p, uid);
      if (!card || card.kind !== 'stop') return false;
      this.toDiscard(card);
      this.pending.stops++;
      this.say(`${p.name} played STOP!`, 'stop');
      this.openStopWindow(playerId);
      return true;
    }
    this.pending.queue.shift();
    if (!this.pending.queue.length) this.resolvePending();
    else this.changed();
    return true;
  }

  resolvePending() {
    const pend = this.pending;
    if (!pend) return;
    const actor = this.player(pend.actor);
    const k = KINDS[pend.kind];
    const stopped = pend.stops % 2 === 1;

    this.phase = PHASE.TURN;

    if (stopped) {
      this.say(`${k.name} was STOPPED. ${actor.name}'s turn continues.`, 'stop');
      this.pending = null;
      this.checkOutOfCards(); // unless that card was their last one
      this.changed(`${k.name} stopped!`);
      return;
    }
    if (pend.stops > 0) {
      this.say(`The STOPs cancel out — ${k.name} goes through.`, 'stop');
    }
    this.applyEffect(pend);
  }

  applyEffect(pend) {
    const actor = this.player(pend.actor);
    const t = pend.targets || {};
    let ends = !!KINDS[pend.kind].endsTurn;
    this.pending = null;

    switch (pend.kind) {
      case 'freePoint':
        this.gainPoints(actor, 1, 'took a free point');
        break;

      case 'stealPoint': {
        const victim = this.player(t.player);
        if (!this.movePoint(victim, actor)) {
          this.say(`${victim.name} had no points to take.`, 'info');
          ends = false;
        }
        break;
      }

      case 'draw3': {
        const got = this.drawMany(actor, 3);
        this.say(`${actor.name} drew ${got.length} cards.`, 'draw');
        break;
      }

      case 'swapHands': {
        const a = this.player(t.a);
        const b = this.player(t.b);
        const tmp = a.hand; a.hand = b.hand; b.hand = tmp;
        this.say(`${a.name} and ${b.name} swapped hands.`, 'swap');
        break;
      }

      case 'stealCard': {
        const victim = this.player(t.player);
        if (victim.hand.length) {
          const idx = Math.floor(Math.random() * victim.hand.length);
          const card = victim.hand.splice(idx, 1)[0];
          actor.hand.push(card);
          // The table sees a card move; only the two of them see which one.
          this.say(`${actor.name} took a card from ${victim.name}.`, 'steal', {
            alt: `${actor.name} took ${KINDS[card.kind].name} from ${victim.name}.`,
            only: [actor.id, victim.id],
          });
        } else {
          this.say(`${victim.name} had no cards.`, 'info');
        }
        break;
      }

      case 'request': {
        const victim = this.player(t.player);
        const i = victim.hand.findIndex((c) => c.kind === t.kind);
        if (i >= 0) {
          const card = victim.hand.splice(i, 1)[0];
          actor.hand.push(card);
          this.say(`${victim.name} handed over a ${KINDS[t.kind].name}.`, 'steal');
        } else {
          this.say(`${victim.name} had no ${KINDS[t.kind].name}. Nothing happens.`, 'info');
        }
        break;
      }

      case 'seeSteal': {
        const victim = this.player(t.player);
        if (!victim.hand.length) {
          this.say(`${victim.name} had no cards.`, 'info');
          break;
        }
        if (actor.isHuman) {
          this.pending = { actor: actor.id, kind: 'seeSteal', targets: t };
          this.phase = PHASE.SEE_STEAL_PICK;
          this.changed();
          return;
        }
        const uid = aiPickFromHand(this, actor, victim);
        const card = this.take(victim, uid);
        actor.hand.push(card);
        this.say(`${actor.name} looked at ${victim.name}'s hand and took a card.`, 'steal', {
          alt: `${actor.name} looked at ${victim.name}'s hand and took ${KINDS[card.kind].name}.`,
          only: [actor.id, victim.id],
        });
        break;
      }
      default:
        break;
    }

    if (this.phase === PHASE.GAME_OVER) { this.changed(); return; }
    if (ends) { this.endTurn(); this.changed(); return; }
    this.phase = PHASE.TURN;
    this.checkOutOfCards();
    this.changed();
  }

  /** Human finishing a SEE AND STEAL. */
  seeStealTake(uid) {
    if (this.phase !== PHASE.SEE_STEAL_PICK) return false;
    const actor = this.player(this.pending.actor);
    const victim = this.player(this.pending.targets.player);
    const card = this.take(victim, uid);
    if (!card) return false;
    actor.hand.push(card);
    this.say(`${actor.name} took a card from ${victim.name}.`, 'steal', {
      alt: `${actor.name} took ${KINDS[card.kind].name} from ${victim.name}.`,
      only: [actor.id, victim.id],
    });
    this.pending = null;
    this.phase = PHASE.TURN;
    this.changed();
    return true;
  }

  // -------------------------------------------------------------- character

  playSet(playerId, uids) {
    if (this.phase !== PHASE.TURN || playerId !== this.current) return false;
    const p = this.cur();
    const cards = uids.map((u) => p.hand.find((c) => c.uid === u)).filter(Boolean);
    const set = evaluateSet(cards);
    if (!set) return false;
    for (const c of cards) { this.take(p, c.uid); this.toDiscard(c); }
    this.say(`${p.name} laid down ${set.label}.`, 'play');
    this.gainPoints(p, set.points, 'completed a set');
    if (this.phase !== PHASE.GAME_OVER) this.endTurn();
    this.changed(`${set.label} — ${set.points} point${set.points === 1 ? '' : 's'}!`);
    return true;
  }
}
