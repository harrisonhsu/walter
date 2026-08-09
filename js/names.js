// Bot names, shared by the solo game and the server that fills empty seats.

export const BOT_NAMES = [
  'Prickles', 'Rosa', 'Barrel', 'Nopal', 'Sage', 'Aloe', 'Yucca',
  'Pear', 'Agave', 'Fig',
];

/** A bot name nobody at the table is already using. */
export function botName(taken = []) {
  const used = new Set(taken.map((n) => String(n).toLowerCase()));
  const free = BOT_NAMES.filter((n) => !used.has(n.toLowerCase()));
  const pool = free.length ? free : BOT_NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Trim a name typed by a player down to something safe to show. */
export function cleanName(raw, fallback = 'Player') {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 12);
  return s || fallback;
}
