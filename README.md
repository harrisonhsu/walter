# 🌵 Cactus — the card game

A phone-first web version of **The Cactus Card Game**: collect cacti, steal points off
your friends, and yell STOP at everything.

Two ways to play:

- **Just bots** — 1–5 of them, entirely in your browser, no network at all.
- **With friends** — open a room, send the link, and anyone who taps it takes a seat.
  Bots play whatever nobody claims, and you can change how many seats there are while
  people are still arriving.

No build step and no dependencies. The client is plain ES modules; the four API
routes are plain Node functions that talk to Redis over HTTPS.

## Play locally

```bash
node scripts/dev-server.mjs
```

Serves the game on <http://localhost:3000> **and** runs online play against an
in-memory stand-in for Redis, so you can open two tabs and play yourself without
signing up for anything. Rooms vanish when you stop the server.

For solo play alone, any static server does (`npx serve .`, `python3 -m http.server`).
Opening `index.html` straight off disk will **not** work: the app uses ES modules,
which browsers refuse to load over `file://`.

> Two tabs of the *same* browser share one seat — that's the reload path working as
> intended. To test two players on one machine, use `localhost` in one tab and
> `127.0.0.1` in the other so they get separate storage.

## Deploying to Vercel

1. Import the repo at [vercel.com/new](https://vercel.com/new). `vercel.json` pins
   the framework to *Other* with no build command, so the defaults are right.
2. Add a Redis store: project → **Storage** → **Upstash for Redis** → Connect.
   The free tier is plenty. This injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. Redeploy so the functions pick up the variables.

Without step 2 the solo game still works perfectly; online play returns a clear
"not configured" message rather than failing strangely.

Rooms are stored under a six-hour TTL and clean themselves up. There is no cron
job and nothing to keep warm — see *How online play works* below.

**GitHub Pages** still works for the solo game (Settings → Pages → *Deploy from a
branch* → `main` / `/ (root)`), but has no backend, so the online half is dark.

It also installs as a home-screen app — there's a web manifest and a small
network-first service worker, so after the first load the solo game works offline.

## Rules implemented

The full rulebook, as printed in the box:

- **Table size** — 2–6 seats, set by the host and adjustable right up until the
  deal. Anyone who has not turned up is a bot.
- **Who starts** — tossed for, not given to the dealer.
- **Winning** — 2–3 players: 10 points. 4–5: 6 points. 6: 5 points.
- **Setup** — 5 cards each from the 90-card playing deck; 30 point cards sit aside.
- **Your turn** — play as many action cards as you like, or none.
- **Ending your turn** — exactly two ways: you earn a point (turn ends instantly,
  no draw, no further plays), or you draw a card.
- **Character sets** — 3 CHARLIES = 1pt, 3 SPIKES = 2pts, 3 WALTERS = 3pts,
  3 WILDS = 3pts. A WILD substitutes for any character. Sets can't be STOPPED.
- **Turn-ending actions** — FREE POINT, STEAL A POINT, DRAW 3.
- **Non-ending actions** — SEE AND STEAL, STEAL A CARD, REQUEST A CARD, SWAP HANDS.
- **STOP** — any player, any time, cancels any action card. STOPs chain: an odd
  number of STOPs kills the action, an even number lets it through. A stopped
  FREE POINT or STEAL A POINT costs the point *and leaves it that player's turn*.
- **Running out of cards** — emptying your hand ends your turn on the spot;
  you pick up 3 at the start of your next turn, and that turn ends too.
- **Empty draw pile** — the discard pile is shuffled back in.
- **Leaderboard** — 🏆 in the top bar. Points for the current round, plus rounds
  won at this table once anyone has won one.

### One deliberate adaptation

On the table, several cards are "un-stoppable once the thing has happened"
(SEE AND STEAL after the hand is looked at, STEAL A CARD after a card is taken,
and so on). Digitally, resolution is instantaneous, so the STOP window opens
**before** the action resolves. That preserves the intent of every one of those
clauses — you get exactly one chance to stop it, and it's before the damage is done.

## Deck

90 playing cards + 30 point cards = 120.

| Card | # | | Card | # |
|---|---|---|---|---|
| CHARLIE | 16 | | SEE AND STEAL | 6 |
| SPIKE | 12 | | DRAW 3 | 6 |
| WALTER | 5 | | STEAL A POINT | 6 |
| WILD | 3 | | REQUEST A CARD | 10 |
| FREE POINT | 3 | | STEAL A CARD | 10 |
| SWAP HANDS | 3 | | STOP | 10 |

## Code layout

```
index.html              markup + the rules sheet
css/styles.css          everything visual
js/cards.js             card definitions, deck, set scoring
js/engine.js            rules engine + turn/STOP state machine
js/ai.js                bot decisions (turn play, STOP responses)
js/names.js             bot names
js/art.js               all card art, generated as inline SVG
js/ui.js                DOM rendering and input
js/net.js               online client: polling, and view → Game
js/lobby.js             the room screen
js/main.js              wiring
api/room.js             open a room, take a seat, size the table, deal
api/action.js           one move from one seat
api/state.js            the long poll (and the table's clock)
api/_lib/rooms.js       room model + per-seat views
api/_lib/store.js       Redis over its REST API
scripts/dev-server.mjs  local everything, no cloud account
sw.js                   offline cache
```

`engine.js` never touches the DOM and `ui.js` never decides rules. That split is
what makes online play cheap: the server runs the *same* engine file, so there is
exactly one implementation of the rules and no chance of the two disagreeing.

The engine has two modes. In the browser's solo game it paces itself — after every
state change it schedules the next automatic step and stops when it needs a human.
On the server it keeps no timers at all: `Game.hydrate()` rebuilds it, one thing
happens, `snapshot()` puts it away again.

## How online play works

**No hand ever leaves the server.** Each seat gets a view with its own cards and a
count for everyone else's. Lines like "took a card" become "took SPIKE" only for
the two players entitled to know.

**No cron, no worker, no warm process.** Bots move because whoever is watching the
table drives them: `/api/state` is a long poll that, while waiting, checks whether
a step is due and applies one. The room's version key doubles as that clock, so an
idle poll is a single tiny Redis read.

**Nobody can stall the table.** Seats send a heartbeat as they poll. If one goes
quiet for 30 seconds the bots play it, and the moment that player comes back they
pick their hand up again. Closing the tab and reopening the link restores your seat.

**Simultaneous moves can't corrupt anything.** Every write is a compare-and-set on
the room version; the loser re-reads and retries.

**Target picking happens client-side.** The server only ever sees a finished play,
so somebody staring at "who do I steal from?" isn't holding up the game.

## Art & attribution

The Cactus Card Game was designed by **Ryan Wallace** —
[thecactuscardgame.com](https://www.thecactuscardgame.com). This is an unofficial,
fan-made implementation and is not affiliated with or endorsed by the publisher.

All artwork here is **original SVG generated in `js/art.js`** — none of the
published card illustrations are reproduced. If you ever want to ship the real
artwork, get permission from the rights holder first and swap out `art.js`.
