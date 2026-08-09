// Wiring. Two ways to play run through the same table:
//
//   solo    — a Game right here in the tab, pacing itself
//   online  — a Session that mirrors a Game living on the server
//
// Both hand ui.js an object with the same shape, so the table never has to
// know which one it is looking at.

import { Game, SPEED } from './engine.js';
import {
  attach, render, bindEvents, setupChrome, showScreen, showError, setRoomTag, flashMessage,
} from './ui.js';
import { bindLobby, renderLobby } from './lobby.js';
import { Session } from './net.js';
import { botName } from './names.js';

let solo = null;
let soloCfg = null;
let session = null;
let atTable = false;
let myName = 'You';

// ------------------------------------------------------------------- solo

function startSolo(cfg) {
  leaveOnline();
  soloCfg = cfg;
  if (solo) solo.destroy();

  const names = [cfg.name];
  const players = [{ name: cfg.name, isHuman: true }];
  while (players.length < cfg.players) {
    const n = botName(names);
    names.push(n);
    players.push({ name: n });
  }

  solo = new Game({ players, speed: SPEED[cfg.speedKey] || SPEED.normal });
  setRoomTag(null);
  atTable = false;
  attach(solo, () => startSolo(soloCfg));
}

// ----------------------------------------------------------------- online

function makeSession() {
  return new Session({
    onUpdate: showView,
    onError: (err, fatal) => {
      if (fatal) {
        session = null;
        atTable = false;
        setRoomTag(null);
        showScreen('setup');
        showError('setup-error', err.message);
        return;
      }
      if (atTable) flashMessage(err ? err.message : '');
      else showError('lobby-error', err ? err.message : '');
    },
  });
}

function showView(view) {
  if (!view) return;
  const seated = view.seat !== null && view.seat !== undefined;

  if (view.status === 'playing' && seated) {
    const g = session.table();
    g.rematch = view.isHost
      ? { label: 'Play again' }
      : { label: 'Waiting for the host…', disabled: true };
    setRoomTag(view.code);
    if (!atTable) {
      atTable = true;
      attach(g, () => session.host('again').catch(reportLobby));
    } else {
      render(g);
    }
    return;
  }

  atTable = false;
  setRoomTag(null);
  showScreen('lobby');
  showError('lobby-error', '');
  renderLobby(view);
}

function reportLobby(err) {
  showError('lobby-error', err.message || 'That did not work.');
}

async function openRoom(cfg) {
  if (solo) { solo.destroy(); solo = null; }
  session = makeSession();
  try {
    await session.create({ name: cfg.name, speedKey: cfg.speedKey, seats: cfg.players });
  } catch (err) {
    session = null;
    showError('setup-error', err.message);
  }
}

async function joinRoom({ code, name }) {
  if (solo) { solo.destroy(); solo = null; }
  session = makeSession();
  showError('setup-error', '');
  try {
    const view = await session.peek(code);
    if (view.seat !== null && view.seat !== undefined) {
      // This browser already holds a seat here — walk straight back into it.
      session.adopt(code, null, view);
    } else if (view.status === 'lobby') {
      await session.sit(code, name);
    } else {
      // Game already running: show the table's seats and let them pick a bot.
      session.code = code;
      session.apply(view);
      session.startPolling();
    }
  } catch (err) {
    session = null;
    showError('setup-error', err.message);
  }
}

function leaveOnline() {
  if (!session) return;
  const s = session;
  session = null;
  atTable = false;
  s.leave();
}

// ------------------------------------------------------------------ setup

setupChrome({
  onStart: (cfg) => {
    showError('setup-error', '');
    myName = cfg.name;
    if (cfg.mode === 'solo') startSolo(cfg);
    else openRoom(cfg);
  },
  onJoin: (cfg) => { myName = cfg.name; joinRoom(cfg); },
  onQuit: () => {
    if (!confirm('Leave this game and start over?')) return;
    if (solo) { solo.destroy(); solo = null; }
    leaveOnline();
    setRoomTag(null);
    showScreen('setup');
  },
});

bindEvents(() => {
  if (session) session.host('again').catch(reportLobby);
  else startSolo(soloCfg);
});

bindLobby({
  onSeats: (n) => session && session.host('seats', { seats: n }).catch(reportLobby),
  onSpeed: (k) => session && session.host('speed', { speedKey: k }).catch(reportLobby),
  onStart: () => session && session.host('start').catch(reportLobby),
  onTake: (seat) => session && session.sit(session.code, myName, seat).catch(reportLobby),
  onLeave: () => {
    leaveOnline();
    setRoomTag(null);
    showScreen('setup');
    history.replaceState(null, '', location.pathname);
  },
});

// ----------------------------------------------------------------- invites

const invite = (new URLSearchParams(location.search).get('r') || '')
  .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);

if (invite.length === 4) {
  document.getElementById('code-input').value = invite;
  showError('setup-error', `You have been invited to room ${invite} — pick a name and tap Join.`);
  document.getElementById('name-input').focus();
  document.getElementById('name-input').select();
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
