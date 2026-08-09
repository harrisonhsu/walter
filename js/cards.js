// Card definitions for The Cactus Card Game.
// Counts come straight from the CONTENTS page of the rulebook:
// 90 playing cards + 30 point cards = 120.

export const KINDS = {
  charlie: {
    id: 'charlie',
    name: 'CHARLIE',
    type: 'character',
    setValue: 1,
    count: 16,
    color: '#3cb44b',
    ink: '#ffffff',
    text: 'COLLECT AND PLAY 3 OF THIS CARD TO EARN 1 POINT.',
    rule: 'Play a set of 3 CHARLIES to earn 1 point. Earning a point ends your turn.',
  },
  spike: {
    id: 'spike',
    name: 'SPIKE',
    type: 'character',
    setValue: 2,
    count: 12,
    color: '#4fc3f7',
    ink: '#ffffff',
    text: 'COLLECT AND PLAY 3 OF THIS CARD TO EARN 2 POINTS.',
    rule: 'Play a set of 3 SPIKES to earn 2 points. Earning a point ends your turn.',
  },
  walter: {
    id: 'walter',
    name: 'WALTER',
    type: 'character',
    setValue: 3,
    count: 5,
    color: '#f4761f',
    ink: '#ffffff',
    text: 'COLLECT AND PLAY 3 OF THIS CARD TO EARN 3 POINTS.',
    rule: 'Play a set of 3 WALTERS to earn 3 points. Earning a point ends your turn.',
  },
  wild: {
    id: 'wild',
    name: 'WILD',
    type: 'wild',
    setValue: 3,
    count: 3,
    color: '#7c3aed',
    ink: '#ffffff',
    text: 'USE AS ANY MATCHING CARD (CHARLIE, SPIKE, WALTER).',
    rule: 'Stands in for any CHARACTER CARD. Three WILDS played together are worth 3 points.',
  },

  freePoint: {
    id: 'freePoint',
    name: 'FREE POINT',
    type: 'action',
    count: 3,
    color: '#e0a800',
    ink: '#1a1a1a',
    endsTurn: true,
    text: 'EARN 1 FREE POINT. THIS ENDS YOUR TURN.',
    rule: 'Earn 1 point from the point pile and end your turn. If STOPPED you earn nothing and it is still your turn.',
  },
  stealPoint: {
    id: 'stealPoint',
    name: 'STEAL A POINT',
    type: 'action',
    count: 6,
    color: '#f4761f',
    ink: '#ffffff',
    endsTurn: true,
    target: 'player',
    text: 'STEAL 1 POINT FROM ANOTHER PLAYER. THIS ENDS YOUR TURN.',
    rule: 'Take 1 point from another player. If STOPPED the point goes back and it is still your turn.',
  },
  draw3: {
    id: 'draw3',
    name: 'DRAW 3',
    type: 'action',
    count: 6,
    color: '#39d353',
    ink: '#1a1a1a',
    endsTurn: true,
    text: 'DRAW 3 NEW CARDS FROM THE DRAW PILE. THIS ENDS YOUR TURN.',
    rule: 'Draw 3 cards, then your turn ends. Can only be STOPPED before any cards are drawn.',
  },
  swapHands: {
    id: 'swapHands',
    name: 'SWAP HANDS',
    type: 'action',
    count: 3,
    color: '#ec4899',
    ink: '#ffffff',
    target: 'twoPlayers',
    text: 'FORCE ANY TWO PLAYERS TO SWAP HANDS. (THIS COULD INCLUDE YOU)',
    rule: 'Force any two players to trade hands — you may pick yourself. It is still your turn afterwards.',
  },
  seeSteal: {
    id: 'seeSteal',
    name: 'SEE AND STEAL',
    type: 'action',
    count: 6,
    color: '#4fc3f7',
    ink: '#ffffff',
    target: 'playerWithCards',
    text: "LOOK AT ANOTHER PLAYER'S HAND AND TAKE 1 CARD OF YOUR CHOOSING.",
    rule: "Look at another player's hand and take any 1 card. It is still your turn afterwards.",
  },
  stealCard: {
    id: 'stealCard',
    name: 'STEAL A CARD',
    type: 'action',
    count: 10,
    color: '#3b6fd4',
    ink: '#ffffff',
    target: 'playerWithCards',
    text: "STEAL 1 RANDOM CARD FROM ANOTHER PLAYER'S HAND.",
    rule: "Take 1 card at random from another player's hand. It is still your turn afterwards.",
  },
  request: {
    id: 'request',
    name: 'REQUEST A CARD',
    type: 'action',
    count: 10,
    color: '#8b5cf6',
    ink: '#ffffff',
    target: 'playerAndKind',
    text: "REQUEST 1 CARD FROM ANY PLAYER. IF THEY DON'T HAVE IT, YOU GET NOTHING.",
    rule: 'Name a card and a player. If they hold it they must hand one over. If not, the action is over.',
  },
  stop: {
    id: 'stop',
    name: 'STOP',
    type: 'stop',
    count: 10,
    color: '#e11d2f',
    ink: '#ffffff',
    text: "STOP ANY PLAYER'S ACTION CARD. THIS CARD CAN BE PLAYED AT ANY TIME.",
    rule: 'Cancels any ACTION CARD played by any player — including another STOP. It cannot stop a set of CHARACTER CARDS.',
  },
};

/** Every card kind — also the list a player can name with REQUEST A CARD. */
export const KIND_IDS = Object.keys(KINDS);

export const CHARACTER_IDS = ['charlie', 'spike', 'walter'];

export const POINT_PILE_SIZE = 30;

let uidSeq = 0;

export function makeCard(kindId) {
  return { uid: `c${++uidSeq}`, kind: kindId };
}

export function buildDeck() {
  const deck = [];
  for (const id of KIND_IDS) {
    for (let i = 0; i < KINDS[id].count; i++) deck.push(makeCard(id));
  }
  return deck;
}

export function kindOf(card) {
  return KINDS[card.kind];
}

/**
 * Works out what a 3-card selection is worth.
 * Wilds substitute for any character; three wilds are worth 3.
 * Returns null when the selection is not a legal set.
 */
export function evaluateSet(cards) {
  if (!cards || cards.length !== 3) return null;
  const kinds = cards.map((c) => c.kind);
  if (kinds.some((k) => KINDS[k].type !== 'character' && KINDS[k].type !== 'wild')) return null;

  const named = kinds.filter((k) => k !== 'wild');
  if (named.length === 0) return { kind: 'wild', points: 3, label: '3 WILDS' };

  const first = named[0];
  if (!named.every((k) => k === first)) return null;
  return { kind: first, points: KINDS[first].setValue, label: `3 ${KINDS[first].name}S` };
}

export function goalForPlayers(n) {
  if (n <= 3) return 10;
  if (n <= 5) return 6;
  return 5;
}
