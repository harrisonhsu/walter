// The room screen: who is at the table, how big it is, and the invite link.
// It doubles as the door for anyone arriving mid-game, where the seat list
// becomes a list of bots you can take over.

import { goalFor, segmented, showError } from './ui.js';

const $ = (id) => document.getElementById(id);

let markSeats = null;
let markSpeed = null;
let view = null;

export function inviteLink(code) {
  return `${location.origin}${location.pathname}?r=${code}`;
}

export function bindLobby(h) {
  markSeats = segmented('lobby-count', 'n', (v) => h.onSeats(Number(v)));
  markSpeed = segmented('lobby-speed', 'speed', (v) => h.onSpeed(v));

  $('lobby-start').addEventListener('click', () => h.onStart());
  $('lobby-leave').addEventListener('click', () => h.onLeave());
  $('copy-btn').addEventListener('click', () => share(view && view.code));

  $('seats').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-seat]');
    if (!b || b.disabled) return;
    h.onTake(Number(b.dataset.seat));
  });
}

export function renderLobby(v) {
  view = v;
  const playing = v.status === 'playing';
  const seated = v.seat !== null && v.seat !== undefined;
  const host = Boolean(v.isHost) && !playing;
  const bots = v.seats.filter((s) => s.bot).length;

  $('lobby-eyebrow').textContent = playing ? 'Game in progress' : 'Room';
  $('lobby-code').textContent = v.code;
  $('lobby-sub').textContent = playing
    ? (bots ? 'Take a bot’s seat and its hand comes with it.' : 'Every seat is taken right now.')
    : 'Anyone who opens the link takes a seat.';

  $('seats').innerHTML = v.seats.map((s) => seatRow(s, playing, seated)).join('');

  $('host-seats').classList.toggle('hidden', !host);
  $('host-speed').classList.toggle('hidden', !host);
  $('lobby-start').classList.toggle('hidden', !host);
  if (host) {
    markSeats(v.seatCount);
    markSpeed(v.speedKey);
  }

  $('lobby-hint').textContent = hint(v, playing, seated, host, bots);
  $('lobby-leave').textContent = seated ? 'Leave the table' : 'Back';
  $('copy-btn').classList.toggle('hidden', playing && !seated);
}

function seatRow(s, playing, seated) {
  const claimable = s.bot && (playing ? !seated : false);
  const tag = s.bot
    ? (claimable ? 'Take this seat' : 'Bot')
    : (s.you ? 'You' : (s.here ? (s.host ? 'Host' : 'Ready') : 'Away'));
  const cls = ['seat'];
  if (s.you) cls.push('is-you');
  if (s.bot) cls.push('is-bot');
  if (claimable) cls.push('is-claimable');
  if (!s.bot && !s.here) cls.push('is-away');
  return `<button class="${cls.join(' ')}" data-seat="${s.i}" ${claimable ? '' : 'disabled'}>
    <span class="seat__n">${s.i + 1}</span>
    <span class="seat__name">${esc(s.name)}</span>
    <span class="seat__tag">${tag}</span>
  </button>`;
}

function hint(v, playing, seated, host, bots) {
  if (playing) {
    if (seated) return 'Rejoining the table…';
    return bots ? 'Pick a seat above to jump in.' : 'Nothing free — leave this open and it will update.';
  }
  const humans = v.seats.length - bots;
  const people = `${humans} ${humans === 1 ? 'person' : 'people'}, ${bots} bot${bots === 1 ? '' : 's'}`;
  const goal = `First to ${goalFor(v.seatCount)} points wins.`;
  return host
    ? `${people}. ${goal} Bots fill anything nobody claims.`
    : `${people}. ${goal} Waiting for the host to deal.`;
}

async function share(code) {
  if (!code) return;
  const url = inviteLink(code);
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Cactus', text: `Join my game — room ${code}`, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    flashCopy('Link copied');
  } catch {
    // Clipboard blocked (or the share sheet was dismissed) — show it instead.
    showError('lobby-error', url);
  }
}

function flashCopy(text) {
  const btn = $('copy-btn');
  const was = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = was; }, 1400);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
