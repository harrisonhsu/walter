// Bot logic. Each call to aiChooseTurn() performs exactly one move; the
// engine's pump calls it again if the bot still has the turn. That keeps the
// bots readable and gives the table a nice beat between plays.

import { KINDS, CHARACTER_IDS, evaluateSet } from './cards.js';

function countKinds(hand) {
  const c = {};
  for (const card of hand) c[card.kind] = (c[card.kind] || 0) + 1;
  return c;
}

function bestSet(hand) {
  let best = null;
  for (let i = 0; i < hand.length; i++) {
    for (let j = i + 1; j < hand.length; j++) {
      for (let k = j + 1; k < hand.length; k++) {
        const cards = [hand[i], hand[j], hand[k]];
        const set = evaluateSet(cards);
        if (set && (!best || set.points > best.points)) best = { cards, ...set };
      }
    }
  }
  return best;
}

/** Character kinds we hold exactly two of (wilds count towards a pair). */
function nearSets(hand) {
  const counts = countKinds(hand);
  const wilds = counts.wild || 0;
  const out = [];
  for (const id of CHARACTER_IDS) {
    const have = (counts[id] || 0) + wilds;
    if (have === 2) out.push({ kind: id, value: KINDS[id].setValue });
  }
  return out.sort((a, b) => b.value - a.value);
}

function leaderOf(game, exceptId) {
  return game.players
    .filter((p) => p.id !== exceptId && p.points > 0)
    .sort((a, b) => b.points - a.points)[0];
}

function fattestHand(game, exceptId) {
  return game.players
    .filter((p) => p.id !== exceptId && p.hand.length > 0)
    .sort((a, b) => b.hand.length - a.hand.length)[0];
}

function find(hand, kind) {
  return hand.find((c) => c.kind === kind);
}

export function aiChooseTurn(game, me) {
  const hand = me.hand;
  const set = bestSet(hand);
  const near = nearSets(hand);

  // A 2- or 3-point set is worth taking right away.
  if (set && set.points >= 2) {
    return game.playSet(me.id, set.cards.map((c) => c.uid));
  }

  // Otherwise try to fish for a better set before cashing a 1-pointer.
  const gather = chooseGather(game, me, near);
  if (gather) return gather();

  const free = find(hand, 'freePoint');
  if (free && game.canPlayAction('freePoint', me.id)) {
    return game.playAction(me.id, free.uid, {});
  }

  const steal = find(hand, 'stealPoint');
  if (steal && game.canPlayAction('stealPoint', me.id)) {
    const victim = leaderOf(game, me.id);
    if (victim) return game.playAction(me.id, steal.uid, { player: victim.id });
  }

  if (set) return game.playSet(me.id, set.cards.map((c) => c.uid));

  const d3 = find(hand, 'draw3');
  if (d3 && hand.length <= 4) return game.playAction(me.id, d3.uid, {});

  return game.drawAndEnd(me.id);
}

/**
 * Returns a thunk that plays a hand-building card, or null when none is worth
 * playing. These cards do not end the turn, so the bot gets another go.
 */
function chooseGather(game, me, near) {
  const hand = me.hand;
  const wantKind = near.length ? near[0].kind : null;

  // Ask a specific player for the exact card that finishes a set.
  const req = find(hand, 'request');
  if (req && wantKind && game.canPlayAction('request', me.id)) {
    const holder = game.players
      .filter((p) => p.id !== me.id && p.hand.length > 0)
      .sort((a, b) => b.hand.length - a.hand.length)[0];
    if (holder) {
      const ask = Math.random() < 0.25 ? 'wild' : wantKind;
      return () => game.playAction(me.id, req.uid, { player: holder.id, kind: ask });
    }
  }

  // Look through a hand and take what we need.
  const see = find(hand, 'seeSteal');
  if (see && game.canPlayAction('seeSteal', me.id) && (wantKind || hand.length < 6)) {
    const victim = fattestHand(game, me.id);
    if (victim) return () => game.playAction(me.id, see.uid, { player: victim.id });
  }

  // Swap into a much bigger hand.
  const swap = find(hand, 'swapHands');
  if (swap && game.canPlayAction('swapHands', me.id)) {
    const victim = fattestHand(game, me.id);
    if (victim && victim.hand.length - hand.length >= 3) {
      return () => game.playAction(me.id, swap.uid, { a: me.id, b: victim.id });
    }
  }

  const grab = find(hand, 'stealCard');
  if (grab && game.canPlayAction('stealCard', me.id) && (wantKind || hand.length < 5)) {
    const victim = fattestHand(game, me.id);
    if (victim) return () => game.playAction(me.id, grab.uid, { player: victim.id });
  }

  return null;
}

/** Which card to lift out of `victim`'s hand. */
export function aiPickFromHand(game, me, victim) {
  const near = nearSets(me.hand).map((n) => n.kind);
  const score = (card) => {
    if (near.includes(card.kind)) return 100 + KINDS[card.kind].setValue;
    if (card.kind === 'wild') return 90;
    if (card.kind === 'freePoint') return 80;
    if (card.kind === 'stealPoint') return 70;
    if (card.kind === 'stop') return 60;
    if (KINDS[card.kind].type === 'character') return 30 + KINDS[card.kind].setValue * 3;
    return 20;
  };
  return [...victim.hand].sort((a, b) => score(b) - score(a))[0].uid;
}

/**
 * How badly `me` wants the pending action cancelled, from -1 (wants it to
 * resolve) to +1 (must be stopped).
 */
function wantNegated(game, me) {
  const pend = game.pending;
  const actor = game.player(pend.actor);
  if (actor.id === me.id) return -0.9;

  const t = pend.targets || {};
  const aimedAtMe = t.player === me.id || t.a === me.id || t.b === me.id;
  const wouldWin = actor.points + 1 >= game.goal;
  const leading = actor.points >= Math.max(...game.players.map((p) => p.points));

  switch (pend.kind) {
    case 'freePoint':
      return wouldWin ? 0.97 : leading ? 0.6 : 0.3;
    case 'stealPoint':
      if (wouldWin) return 0.97;
      if (aimedAtMe) return 0.85;
      return leading ? 0.45 : 0.2;
    case 'seeSteal':
      return aimedAtMe ? 0.55 : 0.12;
    case 'stealCard':
      return aimedAtMe ? 0.4 : 0.08;
    case 'request':
      return aimedAtMe ? 0.35 : 0.05;
    case 'swapHands':
      return aimedAtMe ? (me.hand.length >= 5 ? 0.5 : 0.15) : 0.1;
    case 'draw3':
      return 0.12;
    default:
      return 0.1;
  }
}

export function aiWantsStop(game, me) {
  const pend = game.pending;
  if (!pend) return false;
  const currentlyNegated = pend.stops % 2 === 1;
  const want = wantNegated(game, me);
  const desireNegated = want > 0;
  // Already the way we want it — save the card.
  if (desireNegated === currentlyNegated) return false;
  // Don't burn the last STOP on something trivial.
  const stopsLeft = me.hand.filter((c) => c.kind === 'stop').length;
  const threshold = Math.abs(want) * (stopsLeft > 1 ? 1 : 0.8);
  return Math.random() < threshold;
}
