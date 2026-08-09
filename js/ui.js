// All DOM rendering and input handling. The engine never touches the DOM;
// this module never touches game rules.

import { KINDS, KIND_IDS, evaluateSet } from './cards.js';
import { PHASE } from './engine.js';
import { cactusSVG, iconSVG, pointCardSVG, cardBackSVG, logoSVG } from './art.js';

const $ = (id) => document.getElementById(id);

const el = {
  setup: $('setup'), lobby: $('lobby'), table: $('table'),
  modal: $('modal'), flash: $('flash'),
  rules: $('rules'), board: $('board'), toss: $('toss'),
  opponents: $('opponents'), hand: $('hand'),
  controls: $('controls'), prompt: $('prompt'), log: $('log'),
  drawArt: $('draw-art'), drawCount: $('draw-count'), discardArt: $('discard-art'),
  pointArt: $('point-art'), pointCount: $('point-count'), goalNum: $('goal-num'),
  mePips: $('me-pips'), meName: $('me-name'),
};

let game = null;
let onRestart = null;
const sel = new Set();
let pick = {};          // scratch state for multi-step target modals
let lastFlashId = -1;

// ------------------------------------------------------------------ colour

function mix(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (v) => Math.round(v + (255 - v) * amount);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

// -------------------------------------------------------------- card view

export function cardHTML(card, opts = {}) {
  const k = KINDS[card.kind];
  const isChar = k.type === 'character' || k.type === 'wild';
  const art = isChar ? cactusSVG(card.kind) : iconSVG(card.kind);
  const cls = ['card'];
  if (opts.big) cls.push('card--big');
  if (opts.selected) cls.push('card--sel');
  if (opts.dim) cls.push('card--off');
  if (opts.playable) cls.push('card--playable');
  const bg = isChar ? '#ffffff' : mix(k.color, 0.72);
  // The point value is the one thing worth reading on a thumbnail-sized card;
  // the full card text only appears at --big size.
  const val = isChar ? `<span class="card__val">${k.setValue}</span>` : '';
  return `<div class="${cls.join(' ')}" data-uid="${card.uid}" data-kind="${card.kind}"
      style="--kc:${k.color};--ki:${k.ink};--kbg:${bg}">
    <div class="card__top">
      <span class="card__badge">${isChar ? cactusSVG(card.kind) : iconSVG(card.kind)}</span>
      <span class="card__name">${k.name}</span>
    </div>
    <div class="card__art">${art}${val}</div>
    <div class="card__text">${k.text}</div>
  </div>`;
}

function backHTML() {
  return `<div class="card card--back">${cardBackSVG()}</div>`;
}

/** Points as a plain count — a row of diamonds stopped being readable past 4. */
function scoreHTML(n, big) {
  return `<span class="score${big ? ' score--big' : ''}${n ? '' : ' is-zero'}">
    <b>${n}</b><i>${n === 1 ? 'pt' : 'pts'}</i></span>`;
}

// --------------------------------------------------------------- rendering

/** Move to the table and start rendering `g`. */
export function attach(g, restart) {
  game = g;
  onRestart = restart;
  sel.clear();
  pick = {};
  lastFlashId = -1;
  showScreen('table');
  el.goalNum.textContent = g.goal;
  el.meName.textContent = g.human().name;
  el.drawArt.innerHTML = backHTML();
  el.pointArt.innerHTML = pointCardSVG();
  g.onChange = render;
  render(g);
  g.changed();
  // Only at the top of a game — a latecomer taking a seat has missed the toss.
  if (g.firstPlayer !== null && g.firstPlayer !== undefined && g.log.length <= 2) playToss(g);
}

export function render(g) {
  game = g;
  const me = g.human();

  renderOpponents(g, me);
  renderPiles(g);
  renderLog(g);

  el.mePips.innerHTML = scoreHTML(me.points, true);
  renderHand(g, me);
  renderControls(g, me);
  renderModal(g, me);
  renderBoard(g);
  renderFlash(g);
}

function renderOpponents(g, me) {
  const waiting = g.waitingOn();
  el.opponents.innerHTML = g.players
    .filter((p) => p.id !== me.id)
    .map((p) => {
      const cls = ['opp'];
      if (g.current === p.id && g.phase !== PHASE.GAME_OVER) cls.push('is-active');
      if (waiting && waiting.id === p.id) cls.push('is-thinking');
      if (p.away) cls.push('is-away');
      return `<div class="${cls.join(' ')}">
        <span class="opp__name">${p.away ? '<i class="dot"></i>' : ''}${esc(p.name)}</span>
        <span class="opp__row">
          <span class="opp__cards">🂠 <b>${p.hand.length}</b></span>
          ${scoreHTML(p.points)}
        </span>
      </div>`;
    })
    .join('');
}

function renderPiles(g) {
  el.drawCount.textContent = g.deck.length;
  el.pointCount.textContent = g.pointPile;
  const top = g.discard[g.discard.length - 1];
  el.discardArt.innerHTML = top ? cardHTML(top) : '';
}

function renderLog(g) {
  const recent = g.logView().slice(-40);
  el.log.innerHTML = recent.map((l) => `<li class="t-${l.tone}">${esc(l.text)}</li>`).join('');
  el.log.scrollTop = el.log.scrollHeight;
}

function myTurn(g, me) {
  return g.phase === PHASE.TURN && g.current === me.id;
}

function renderHand(g, me) {
  const active = myTurn(g, me);
  el.hand.innerHTML = me.hand
    .map((c) => {
      const k = KINDS[c.kind];
      const isChar = k.type === 'character' || k.type === 'wild';
      let playable = false;
      if (active) {
        if (isChar) playable = true;
        else if (k.type === 'action') playable = g.canPlayAction(c.kind, me.id);
      }
      return cardHTML(c, {
        selected: sel.has(c.uid),
        playable,
        dim: active && !playable,
      });
    })
    .join('');
  if (!me.hand.length) {
    el.hand.innerHTML = '<div class="prompt is-idle" style="margin:auto">No cards in hand.</div>';
  }
}

function selectedCards(me) {
  return me.hand.filter((c) => sel.has(c.uid));
}

function renderControls(g, me) {
  const active = myTurn(g, me);

  // Online: a move is on its way to the server. Freeze rather than let the
  // player fire a second one that the server will only reject.
  if (g.busy) {
    el.prompt.className = 'prompt is-idle';
    el.prompt.textContent = 'Sending…';
    el.controls.innerHTML = '';
    return;
  }

  if (g.phase === PHASE.GAME_OVER) {
    el.prompt.textContent = g.winner === me ? 'You win!' : `${g.winner.name} wins.`;
    el.prompt.className = 'prompt';
    el.controls.innerHTML = rematchHTML(g);
    return;
  }

  if (!active) {
    const w = g.waitingOn();
    const mine = w && w.id === me.id;
    el.prompt.className = mine ? 'prompt' : 'prompt is-idle';
    if (mine && g.phase === PHASE.CHOOSE_TARGET) el.prompt.textContent = 'Choose who to play it on.';
    else if (mine && g.phase === PHASE.STOP_WINDOW) el.prompt.textContent = 'STOP it, or let it through?';
    else if (mine && g.phase === PHASE.SEE_STEAL_PICK) el.prompt.textContent = 'Take a card.';
    else el.prompt.textContent = w ? `${w.name} is thinking…` : 'Resolving…';
    el.controls.innerHTML = '';
    return;
  }

  const cards = selectedCards(me);
  el.prompt.className = 'prompt';
  el.prompt.textContent = 'Your turn — play cards or draw to end.';

  let primary = { label: 'Select a card', disabled: true, act: '' };

  if (cards.length === 1 && KINDS[cards[0].kind].type === 'action') {
    const k = KINDS[cards[0].kind];
    primary = { label: `Play ${k.name}`, disabled: false, act: 'play-action' };
    el.prompt.textContent = k.rule;
  } else if (cards.length && cards.every((c) => ['character', 'wild'].includes(KINDS[c.kind].type))) {
    const set = evaluateSet(cards);
    if (set) {
      primary = { label: `Play set · +${set.points}`, disabled: false, act: 'play-set' };
      el.prompt.textContent = `${set.label} — worth ${set.points} point${set.points === 1 ? '' : 's'}.`;
    } else if (cards.length < 3) {
      primary = { label: `Pick ${3 - cards.length} more`, disabled: true, act: '' };
      el.prompt.textContent = 'Character sets are 3 matching cards (WILDS count as any).';
    } else {
      primary = { label: 'Not a matching set', disabled: true, act: '' };
      el.prompt.textContent = 'Those three do not match.';
    }
  } else if (cards.length === 1 && KINDS[cards[0].kind].type === 'stop') {
    primary = { label: 'STOP is a reaction', disabled: true, act: '' };
    el.prompt.textContent = 'Save STOP for when somebody else plays an action card.';
  }

  el.controls.innerHTML = `
    <button class="btn ${primary.disabled ? 'btn--muted' : 'btn--primary'}"
      data-act="${primary.act}" ${primary.disabled ? 'disabled' : ''}>${primary.label}</button>
    <button class="btn btn--muted" data-act="draw-end" style="flex:0 0 40%">Draw &amp; end</button>`;
}

// ------------------------------------------------------------------ modals

function renderModal(g, me) {
  const waiting = g.waitingOn();
  const mine = waiting && waiting.id === me.id;

  if (g.busy) return closeModal();
  if (g.phase === PHASE.CHOOSE_TARGET && mine) return targetModal(g, me);
  if (g.phase === PHASE.STOP_WINDOW && mine) return stopModal(g, me);
  if (g.phase === PHASE.SEE_STEAL_PICK && mine) return seeStealModal(g, me);
  if (g.phase === PHASE.GAME_OVER) return gameOverModal(g, me);
  closeModal();
}

// Rebuilding identical markup would replay the slide-in animation, so skip it.
function openModal(html) {
  if (el.modal.dataset.sig === html) return;
  el.modal.dataset.sig = html;
  el.modal.innerHTML = `<div class="sheetbox">${html}</div>`;
  el.modal.classList.remove('hidden');
}

function closeModal() {
  if (!el.modal.classList.contains('hidden')) {
    el.modal.classList.add('hidden');
    el.modal.innerHTML = '';
    el.modal.dataset.sig = '';
  }
}

function playerRow(p, opts = {}) {
  return `<button data-pick="${p.id}" ${opts.disabled ? 'disabled' : ''}
      class="${opts.picked ? 'is-picked' : ''}">
    <span>${esc(p.name)}</span>
    <span class="meta">🂠 ${p.hand.length} ${scoreHTML(p.points)}</span>
  </button>`;
}

function targetModal(g, me) {
  const pend = g.pending;
  const k = KINDS[pend.kind];
  const spec = pend.spec;
  const t = pend.targets;

  let body = '';
  if (spec.need === 'player' || (spec.need === 'playerAndKind' && typeof t.player !== 'number')) {
    body = `<h3>${k.name}</h3><p>${k.rule}</p>
      <div class="playerpick">${g.players
        .filter((p) => spec.options.includes(p.id))
        .map((p) => playerRow(p))
        .join('')}</div>`;
  } else if (spec.need === 'playerAndKind') {
    body = `<h3>Ask ${esc(g.player(t.player).name)} for…</h3>
      <p>If they hold one they must hand it over.</p>
      <div class="kindgrid">${KIND_IDS.map((id) =>
        `<button data-kind="${id}"><span class="swatch" style="background:${KINDS[id].color}"></span>${KINDS[id].name}</button>`
      ).join('')}</div>`;
  } else if (spec.need === 'twoPlayers') {
    const first = typeof t.a === 'number';
    body = `<h3>SWAP HANDS</h3>
      <p>${first ? 'Now pick the second player.' : 'Pick the first player — you can pick yourself.'}</p>
      <div class="playerpick">${g.players
        .map((p) => playerRow(p, { picked: t.a === p.id, disabled: first && t.a === p.id }))
        .join('')}</div>`;
  }

  openModal(`${body}<button class="btn btn--muted" data-act="cancel-target">Cancel</button>`);
}

function stopModal(g, me) {
  const pend = g.pending;
  const k = KINDS[pend.kind];
  const actor = g.player(pend.actor);
  const negated = pend.stops % 2 === 1;
  const stopCard = me.hand.find((c) => c.kind === 'stop');
  const aimed = pend.targets.player === me.id || pend.targets.a === me.id || pend.targets.b === me.id;

  const chain = pend.stops === 0
    ? `<p>Play STOP to cancel it, or pass.</p>`
    : negated
      ? `<p><b>${pend.stops} STOP${pend.stops > 1 ? 's' : ''} played — the action is currently cancelled.</b> Another STOP would let it through.</p>`
      : `<p><b>${pend.stops} STOPs played — they cancel out, so the action is going through.</b> Another STOP would cancel it.</p>`;

  const head = actor.id === me.id
    ? `Your ${k.name} ${negated ? 'was STOPPED' : 'is going through'}`
    : `${esc(actor.name)} played ${k.name}${aimed ? ' on you' : ''}`;

  openModal(`
    <h3>${head}</h3>
    <p>${k.rule}</p>
    ${chain}
    <div style="display:flex;justify-content:center;margin-bottom:4px">${cardHTML({ uid: 'x', kind: pend.kind }, { big: true })}</div>
    <div class="row">
      ${stopCard ? `<button class="btn btn--danger" data-act="do-stop" data-uid="${stopCard.uid}">Play STOP</button>` : ''}
      <button class="btn btn--muted" data-act="pass-stop">Pass</button>
    </div>`);
}

function seeStealModal(g, me) {
  const victim = g.player(g.pending.targets.player);
  // Online, the victim's cards arrive in a one-off reveal rather than in the
  // shared state, so nobody else can read them out of the wire.
  const hand = g.reveal ? g.reveal.hand : victim.hand;
  openModal(`
    <h3>${esc(victim.name)}'s hand</h3>
    <p>Take any one card.</p>
    <div class="pickgrid">${hand.map((c) => cardHTML(c, { playable: true })).join('')}</div>`);
}

/** Online, only the host can deal again — everyone else waits. */
function rematchHTML(g) {
  const r = g.rematch || { label: 'New game' };
  return `<button class="btn ${r.disabled ? 'btn--muted' : 'btn--primary'}"
    data-act="restart" ${r.disabled ? 'disabled' : ''}>${esc(r.label)}</button>`;
}

function gameOverModal(g, me) {
  const won = g.winner === me;
  const standings = [...g.players].sort((a, b) => b.points - a.points);
  openModal(`
    <h3>${won ? '🌵 You win!' : `${esc(g.winner.name)} wins`}</h3>
    <p>First to ${g.goal} points.</p>
    <div class="playerpick">${standings.map((p) =>
      `<button disabled class="${p === g.winner ? 'is-picked' : ''}" style="opacity:1">
        <span>${esc(p.name)}</span>
        <span class="meta">${p.points} pt${p.points === 1 ? '' : 's'}</span></button>`
    ).join('')}</div>
    ${rematchHTML(g)}`);
}

// ------------------------------------------------------------ leaderboard

function renderBoard(g) {
  if (el.board.classList.contains('hidden')) return;
  const me = g.human();
  const anyWins = g.players.some((p) => p.wins > 0);
  $('board-list').innerHTML = g.standings().map((p, i) => {
    const cls = ['brow'];
    if (p.id === me.id) cls.push('is-me');
    if (g.winner === p) cls.push('is-won');
    return `<li class="${cls.join(' ')}">
      <span class="brow__rank">${i + 1}</span>
      <span class="brow__name">${esc(p.name)}${p.isHuman ? '' : ' <i class="brow__bot">bot</i>'}</span>
      ${anyWins ? `<span class="brow__wins">${p.wins} won</span>` : ''}
      <span class="brow__pts">${p.points}</span>
    </li>`;
  }).join('');
  $('board-note').textContent = anyWins
    ? `First to ${g.goal} points takes the round. "Won" counts rounds at this table.`
    : `First to ${g.goal} points wins.`;
}

/**
 * Ceremony for the opening toss, so nobody wonders why they are not first.
 *
 * Driven by a deadline rather than a tick count: a backgrounded tab clamps
 * timers to about a second each, which would turn a fixed number of ticks into
 * a fifteen-second wait. This just shows fewer names instead.
 */
let tossTimer = null;

function playToss(g) {
  const winner = g.players[g.firstPlayer];
  if (!winner) return;
  const names = g.players.map((p) => p.name);
  clearTimeout(tossTimer);
  el.toss.classList.remove('hidden');

  const show = (name, settled) => {
    el.toss.innerHTML = `<div class="toss__box${settled ? ' is-settled' : ''}">
      <span class="toss__label">${settled ? 'goes first' : 'tossing for first…'}</span>
      <span class="toss__name">${esc(name)}</span></div>`;
  };

  const until = Date.now() + 1250;
  let i = Math.floor(Math.random() * names.length);
  const step = () => {
    if (Date.now() >= until) {
      show(winner.name, true);
      tossTimer = setTimeout(() => {
        el.toss.classList.add('hidden');
        el.toss.innerHTML = '';
      }, 1100);
      return;
    }
    show(names[i++ % names.length], false);
    tossTimer = setTimeout(step, 90);
  };
  step();
}

/** Drop a one-off banner over the table — used for network hiccups. */
export function flashMessage(text) {
  if (!text) return;
  el.flash.innerHTML = `<span class="is-note">${esc(text)}</span>`;
  setTimeout(() => { el.flash.innerHTML = ''; }, 1600);
}

function renderFlash(g) {
  if (!g.flash) return;
  const id = g.log.length;
  if (id === lastFlashId) return;
  lastFlashId = id;
  const isStop = /stop/i.test(g.flash);
  el.flash.innerHTML = `<span class="${isStop ? 'is-stop' : ''}">${esc(g.flash)}</span>`;
  g.flash = null;
  setTimeout(() => { el.flash.innerHTML = ''; }, 1200);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ------------------------------------------------------------------ input

function onHandTap(uid) {
  const me = game.human();
  if (!myTurn(game, me)) return;
  const card = me.hand.find((c) => c.uid === uid);
  if (!card) return;
  const k = KINDS[card.kind];
  const isChar = k.type === 'character' || k.type === 'wild';

  if (sel.has(uid)) sel.delete(uid);
  else {
    const current = selectedCards(me);
    const mixedTypes = current.some((c) => {
      const t = KINDS[c.kind].type;
      return isChar ? !['character', 'wild'].includes(t) : true;
    });
    if (!isChar || mixedTypes) sel.clear();
    if (isChar && sel.size >= 3) sel.clear();
    sel.add(uid);
  }
  render(game);
}

function doPrimary(act) {
  const me = game.human();
  const cards = selectedCards(me);
  if (act === 'play-action' && cards.length === 1) {
    const uid = cards[0].uid;
    sel.clear();
    game.playAction(me.id, uid);
  } else if (act === 'play-set') {
    const uids = cards.map((c) => c.uid);
    sel.clear();
    game.playSet(me.id, uids);
  }
}

export function bindEvents(restart) {
  onRestart = restart;

  el.hand.addEventListener('click', (e) => {
    const c = e.target.closest('.card');
    if (c) onHandTap(c.dataset.uid);
  });

  el.controls.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'draw-end') { sel.clear(); game.drawAndEnd(game.human().id); }
    else if (act === 'restart') onRestart();
    else doPrimary(act);
  });

  el.modal.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    const card = e.target.closest('.pickgrid .card');

    if (card && game.phase === PHASE.SEE_STEAL_PICK) {
      game.seeStealTake(card.dataset.uid);
      return;
    }
    if (!btn || btn.disabled) return;

    if (btn.dataset.act === 'restart') return onRestart();
    if (btn.dataset.act === 'cancel-target') return game.cancelTarget();
    if (btn.dataset.act === 'pass-stop') return game.respondStop(game.human().id, null);
    if (btn.dataset.act === 'do-stop') return game.respondStop(game.human().id, btn.dataset.uid);

    if (btn.dataset.kind) return game.provideTarget({ kind: btn.dataset.kind });

    if (btn.dataset.pick !== undefined) {
      const id = Number(btn.dataset.pick);
      const spec = game.pending.spec;
      if (spec.need === 'twoPlayers') {
        if (typeof game.pending.targets.a !== 'number') game.provideTarget({ a: id });
        else game.provideTarget({ b: id });
      } else {
        game.provideTarget({ player: id });
      }
    }
  });
}

// ------------------------------------------------------------------ chrome

const SCREENS = { setup: el.setup, lobby: el.lobby, table: el.table };

export function showScreen(name) {
  for (const [key, node] of Object.entries(SCREENS)) node.classList.toggle('hidden', key !== name);
  if (name !== 'table') {
    closeModal();
    el.board.classList.add('hidden');
  }
}

export function showError(id, message) {
  const node = $(id);
  node.textContent = message || '';
  node.classList.toggle('hidden', !message);
}

/** Little "ROOM ABCD" tag in the table's top bar. */
export function setRoomTag(code) {
  const tag = $('room-tag');
  tag.textContent = code ? `Room ${code}` : '';
  tag.classList.toggle('hidden', !code);
}

export const goalFor = (n) => (n <= 3 ? 10 : n <= 5 ? 6 : 5);

/**
 * Wires a segmented control. `onPick` gets the chosen data-* value; call the
 * returned function to move the highlight from the outside.
 */
export function segmented(id, attr, onPick) {
  const box = $(id);
  const mark = (value) => {
    [...box.children].forEach((c) => c.classList.toggle('is-on', c.dataset[attr] === String(value)));
  };
  box.addEventListener('click', (e) => {
    const b = e.target.closest(`button[data-${attr.toLowerCase()}]`);
    if (!b || b.disabled) return;
    mark(b.dataset[attr]);
    onPick(b.dataset[attr]);
  });
  return mark;
}

export function setupChrome({ onStart, onJoin, onQuit }) {
  $('setup-logo').innerHTML = logoSVG();

  const hint = $('goal-hint');
  const joinrow = $('joinrow');
  const startBtn = $('start-btn');
  let mode = 'online';
  let players = 3;
  let speedKey = 'normal';

  const refresh = () => {
    hint.textContent = mode === 'solo'
      ? `First to ${goalFor(players)} points wins.`
      : `${players} seats — first to ${goalFor(players)} points. You can still change this in the room.`;
    startBtn.textContent = mode === 'solo' ? 'Deal me in' : 'Open a room';
    joinrow.classList.toggle('hidden', mode === 'solo');
  };

  segmented('mode', 'mode', (v) => { mode = v; showError('setup-error', ''); refresh(); });
  segmented('player-count', 'n', (v) => { players = Number(v); refresh(); });
  segmented('speed', 'speed', (v) => { speedKey = v; });

  const name = () => ($('name-input').value || 'You').trim().slice(0, 12) || 'You';

  startBtn.addEventListener('click', () => onStart({ mode, players, name: name(), speedKey }));

  const code = $('code-input');
  code.addEventListener('input', () => {
    code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });
  const join = () => {
    if (code.value.length !== 4) return showError('setup-error', 'Room codes are four characters.');
    onJoin({ code: code.value, name: name() });
  };
  $('join-btn').addEventListener('click', join);
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

  const openRules = () => el.rules.classList.remove('hidden');
  $('rules-btn').addEventListener('click', openRules);
  $('setup-rules-btn').addEventListener('click', openRules);
  $('rules-close').addEventListener('click', () => el.rules.classList.add('hidden'));

  $('board-btn').addEventListener('click', () => {
    el.board.classList.remove('hidden');
    if (game) renderBoard(game);
  });
  $('board-close').addEventListener('click', () => el.board.classList.add('hidden'));

  $('quit-btn').addEventListener('click', onQuit);

  // Rules sheet card reference
  $('rules-cards').innerHTML = [
    'freePoint', 'stealPoint', 'draw3', 'seeSteal', 'stealCard', 'request', 'swapHands',
  ].map((id) => {
    const k = KINDS[id];
    return `<div class="rc">
      <span class="rc__ico" style="background:${mix(k.color, 0.55)}">${iconSVG(id)}</span>
      <div><dt>${k.name}</dt><dd>${k.rule}</dd></div>
    </div>`;
  }).join('');

  refresh();
}
