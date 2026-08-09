// Original hand-drawn-style SVG art. Deliberately not the published card
// artwork — see README for why.

const SPINES = [
  [56, 34], [64, 46], [55, 58], [65, 70], [56, 82], [64, 96], [55, 110], [63, 124],
  [27, 74], [33, 90], [26, 104], [89, 60], [95, 76], [88, 92], [94, 106],
];

function spines() {
  return SPINES.map(([x, y]) =>
    `<path d="M${x} ${y} l3 6 l-3 -1.5 l-3 1.5 z" fill="#14301a"/>`
  ).join('');
}

// A saguaro built from overlapping rounded rects. Drawn twice: once fat and
// black for the outline, once clean on top, so the seams disappear.
const LIMBS = [
  'M48 20 h26 a13 13 0 0 1 13 13 v107 h-52 v-107 a13 13 0 0 1 13 -13 z',
  'M20 70 h20 a10 10 0 0 1 10 10 v30 h-40 v-30 a10 10 0 0 1 10 -10 z',
  'M20 92 h34 v22 h-34 z',
  'M82 52 h20 a10 10 0 0 1 10 10 v46 h-40 v-46 a10 10 0 0 1 10 -10 z',
  'M68 84 h34 v22 h-34 z',
];

function cactusShape(fill, gradId) {
  const paint = gradId ? `url(#${gradId})` : fill;
  const outline = LIMBS.map((d) => `<path d="${d}"/>`).join('');
  const body = LIMBS.map((d) => `<path d="${d}" fill="${paint}"/>`).join('');
  return `
    <g stroke="#111" stroke-width="9" stroke-linejoin="round" fill="none">${outline}</g>
    <g stroke="none">${body}</g>`;
}

function face(kind) {
  if (kind === 'charlie') {
    return `
      <g transform="translate(0,-2)">
        <path d="M52 30 q-9 -10 1 -13 q7 -2 8 6" fill="#e8386d" stroke="#111" stroke-width="3.5"/>
        <path d="M62 24 q10 -8 13 2 q2 7 -6 9" fill="#e8386d" stroke="#111" stroke-width="3.5"/>
        <circle cx="61" cy="30" r="4" fill="#f6d743" stroke="#111" stroke-width="3"/>
      </g>
      <rect x="46" y="52" width="14" height="11" rx="2.5" fill="#fff" stroke="#111" stroke-width="3.5"/>
      <rect x="63" y="52" width="14" height="11" rx="2.5" fill="#fff" stroke="#111" stroke-width="3.5"/>
      <path d="M60 57 h3" stroke="#111" stroke-width="3.5"/>
      <circle cx="53" cy="58" r="2.4" fill="#111"/>
      <circle cx="70" cy="58" r="2.4" fill="#111"/>`;
  }
  if (kind === 'spike') {
    return `
      <path d="M44 50 h35 v4 h-35 z" fill="#111"/>
      <path d="M45 52 h13 l-1.5 11 h-10 z" fill="#111"/>
      <path d="M65 52 h13 l-1.5 11 h-10 z" fill="#111"/>
      <path d="M58 54 h7" stroke="#111" stroke-width="3"/>
      <path d="M54 76 q7 5 14 0" stroke="#111" stroke-width="4" fill="none" stroke-linecap="round"/>`;
  }
  if (kind === 'walter') {
    return `
      <ellipse cx="54" cy="56" rx="4" ry="5" fill="#111"/>
      <ellipse cx="69" cy="56" rx="4" ry="5" fill="#111"/>
      <path d="M52 76 h19" stroke="#111" stroke-width="4.5" stroke-linecap="round"/>`;
  }
  // wild
  return `
    <path d="M50 50 l4 8 l8 1 l-6 6 l2 8 l-8 -4 l-8 4 l2 -8 l-6 -6 l8 -1 z" fill="#fff" stroke="#111" stroke-width="3"/>
    <path d="M72 50 l4 8 l8 1 l-6 6 l2 8 l-8 -4 l-8 4 l2 -8 l-6 -6 l8 -1 z" fill="#fff" stroke="#111" stroke-width="3"/>
    <path d="M52 88 q10 12 20 0" stroke="#111" stroke-width="4.5" fill="none" stroke-linecap="round"/>`;
}

const CACTUS_TINT = { charlie: '#5cc65f', spike: '#3fae5a', walter: '#4dbb63' };

export function cactusSVG(kind) {
  const grad = kind === 'wild'
    ? `<defs><linearGradient id="wildgrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#ff5f6d"/><stop offset="25%" stop-color="#ffc371"/>
        <stop offset="50%" stop-color="#5cc65f"/><stop offset="75%" stop-color="#4fc3f7"/>
        <stop offset="100%" stop-color="#a06cf5"/></linearGradient></defs>`
    : '';
  return `<svg viewBox="0 0 132 150" class="art" aria-hidden="true">${grad}
    ${cactusShape(CACTUS_TINT[kind] || '#5cc65f', kind === 'wild' ? 'wildgrad' : null)}
    ${spines()}
    ${face(kind)}
  </svg>`;
}

const DIAMOND = `<path d="M24 6 L40 20 L24 44 L8 20 Z" fill="#ffffff" stroke="#111" stroke-width="3" stroke-linejoin="round"/>
  <path d="M8 20 H40 M24 6 L17 20 L24 44 M24 6 L31 20 L24 44" stroke="#111" stroke-width="2" fill="none"/>`;

const ICONS = {
  freePoint: `<svg viewBox="0 0 48 48" class="glyph">${DIAMOND}</svg>`,

  stealPoint: `<svg viewBox="0 0 48 48" class="glyph">
    <g transform="translate(0,-4) scale(0.86) translate(4,0)">${DIAMOND}</g>
    <path d="M10 40 q6 -8 14 -8 q8 0 14 8" stroke="#111" stroke-width="3.5" fill="#5cc65f" stroke-linejoin="round"/>
    <path d="M17 34 v-6 M24 32 v-8 M31 34 v-6" stroke="#111" stroke-width="3" stroke-linecap="round"/>
  </svg>`,

  draw3: `<svg viewBox="0 0 48 48" class="glyph">
    <rect x="5" y="5" width="38" height="38" rx="7" fill="#fff" stroke="#111" stroke-width="3.5"/>
    <text x="24" y="34" text-anchor="middle" font-size="26" font-weight="800" fill="#111" font-family="inherit">+3</text>
  </svg>`,

  swapHands: `<svg viewBox="0 0 48 48" class="glyph">
    <path d="M8 17 h24 l-6 -7 M8 17 l6 7" stroke="#111" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M40 31 h-24 l6 -7 M40 31 l-6 7" stroke="#111" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,

  seeSteal: `<svg viewBox="0 0 48 48" class="glyph">
    <path d="M24 6 L43 40 H5 Z" fill="#fff" stroke="#111" stroke-width="3.5" stroke-linejoin="round"/>
    <path d="M11 31 q13 -12 26 0 q-13 12 -26 0 z" fill="#fff" stroke="#111" stroke-width="3"/>
    <circle cx="24" cy="31" r="4.5" fill="#111"/>
  </svg>`,

  stealCard: `<svg viewBox="0 0 48 48" class="glyph">
    <ellipse cx="24" cy="19" rx="19" ry="7" fill="#fff" stroke="#111" stroke-width="3.5"/>
    <path d="M14 15 q10 -11 20 0" fill="#fff" stroke="#111" stroke-width="3.5"/>
    <path d="M14 25 L9 43 M34 25 L39 43" stroke="#111" stroke-width="3" stroke-linecap="round"/>
    <rect x="19" y="31" width="10" height="13" rx="2" fill="#fff" stroke="#111" stroke-width="3"/>
  </svg>`,

  request: `<svg viewBox="0 0 48 48" class="glyph">
    <path d="M6 8 h36 a4 4 0 0 1 4 4 v18 a4 4 0 0 1 -4 4 h-19 l-10 8 v-8 h-7 a4 4 0 0 1 -4 -4 v-18 a4 4 0 0 1 4 -4 z"
      fill="#fff" stroke="#111" stroke-width="3.5" stroke-linejoin="round"/>
    <text x="24" y="30" text-anchor="middle" font-size="22" font-weight="800" fill="#111" font-family="inherit">?</text>
  </svg>`,

  stop: `<svg viewBox="0 0 48 48" class="glyph">
    <path d="M16 4 h16 l12 12 v16 l-12 12 h-16 l-12 -12 v-16 z" fill="#e11d2f" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"/>
    <path d="M16 4 h16 l12 12 v16 l-12 12 h-16 l-12 -12 v-16 z" fill="none" stroke="#111" stroke-width="2"/>
    <text x="24" y="29" text-anchor="middle" font-size="11" font-weight="800" fill="#fff" font-family="inherit" letter-spacing="0.5">STOP</text>
  </svg>`,
};

export function iconSVG(kindId) {
  return ICONS[kindId] || '';
}

export function pointCardSVG() {
  return `<svg viewBox="0 0 100 140" class="art art--point" aria-hidden="true">
    <defs>
      <pattern id="dia" width="20" height="20" patternUnits="userSpaceOnUse">
        <path d="M10 4 L16 10 L10 17 L4 10 Z" fill="none" stroke="#ffffff" stroke-width="1.4" opacity="0.5"/>
      </pattern>
    </defs>
    <rect x="0" y="0" width="100" height="140" rx="8" fill="#141414"/>
    <rect x="0" y="0" width="100" height="140" rx="8" fill="url(#dia)"/>
    <circle cx="50" cy="70" r="33" fill="#ffffff"/>
    <circle cx="50" cy="70" r="26" fill="#cdeccd"/>
    <g transform="translate(50,70) scale(0.28) translate(-66,-80)">
      ${cactusShape('#5cc65f', null)}
    </g>
    <path d="M27 55 a30 30 0 0 1 46 0" fill="none" stroke="#141414" stroke-width="1"/>
    <text x="50" y="49" text-anchor="middle" font-size="9" font-weight="800" fill="#141414" font-family="inherit">ONE POINT</text>
    <text x="50" y="98" text-anchor="middle" font-size="9" font-weight="800" fill="#141414" font-family="inherit">ONE POINT</text>
  </svg>`;
}

export function cardBackSVG() {
  return `<svg viewBox="0 0 100 140" class="art art--back" aria-hidden="true">
    <defs>
      <pattern id="backpat" width="18" height="18" patternUnits="userSpaceOnUse">
        <circle cx="9" cy="9" r="2.5" fill="#0f3d1c" opacity="0.55"/>
      </pattern>
    </defs>
    <rect width="100" height="140" rx="8" fill="#1f7a3d"/>
    <rect width="100" height="140" rx="8" fill="url(#backpat)"/>
    <rect x="9" y="9" width="82" height="122" rx="6" fill="none" stroke="#eafbe9" stroke-width="3"/>
    <g transform="translate(50,70) scale(0.36) translate(-66,-78)">
      ${cactusShape('#5cc65f', null)}
    </g>
  </svg>`;
}

export function logoSVG() {
  return `<svg viewBox="0 0 200 200" class="logo" aria-hidden="true">
    <circle cx="100" cy="100" r="96" fill="#ffffff" stroke="#111" stroke-width="5"/>
    <circle cx="100" cy="100" r="70" fill="#cdeccd" stroke="#111" stroke-width="4"/>
    <g transform="translate(100,104) scale(0.72) translate(-66,-78)">
      ${cactusShape('#5cc65f', null)}
      ${spines()}
      ${face('charlie')}
    </g>
  </svg>`;
}
