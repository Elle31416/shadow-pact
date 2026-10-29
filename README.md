# SHADOW PACT

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Elle31416/shadow-pact)

**One-click deploy → [Render Blueprint](https://render.com/deploy?repo=https://github.com/Elle31416/shadow-pact)** · [Live repo](https://github.com/Elle31416/shadow-pact)

A minimalist **2-player real-time cooperative puzzle**. One shared screen, one lamp,
one wall. Odd geometric pieces cast shadows — **Blue** drags and rotates the pieces,
**Red** slides the lamp up and down the left edge, which rescales and distorts *every
shadow at once*. Only by moving **at the same time** can the pair make the combined
shadow match the dotted target silhouette. First team to clear **6 levels** forges the pact.

No images, no sprites, no physics engine, no menus, no dependencies — ~45 KB of
hand-written HTML/CSS/JS plus one dependency-free Node server.

---

## Run

```bash
node server.js                     # production: http://0.0.0.0:3000
PORT=3100 LEVEL_MS=4000 node server.js   # fast-timer variant (used by the test suite)
```

Open the page on **two devices (or two windows)** — matchmaking pairs the first two
waiting players into a room of exactly 2. A third player waits in queue and is never
admitted mid-match.

### Environment tunables

| var         | default | meaning                                   |
|-------------|---------|-------------------------------------------|
| `PORT`      | `3000`  | HTTP + WebSocket port (same socket)       |
| `LEVEL_MS`  | `45000` | per-level countdown                       |
| `ROLE_MS`   | `2000`  | grace added to level 1's timer (role card)|
| `DEBUG_IO`  | off     | set to `1` to log every inbound message   |

Appending `?dbg=1` to the URL logs client-side pointer handling.

---

## Deploy (Render Blueprint)

`render.yaml` is the whole blueprint: one free-tier Node web service that serves the
game **and** runs the WebSocket matchmaker on the same port — no databases, no env
vars to configure. Click the button above → authorize GitHub → done; `autoDeploy`
redeploys on every push to `main`.

Notes:
- **WebSockets work out of the box** on Render's proxy (the server pings every 20 s
  to hold connections open; dropped sockets auto-reconnect with backoff and players
  re-queue cleanly).
- Render injects `PORT` — `server.js` reads `process.env.PORT`.
- **Free instances sleep** after ~15 min of inactivity: the first visitor after a
  cold start waits ~30–50 s (the queue screen shows *reconnecting* meanwhile).
  Switch `plan: free` → `starter` in `render.yaml` for always-on.
- Matchmaking needs two players: share your `*.onrender.com` link on two devices.

---

## How to play (learned in ~10 seconds, no tutorial)

- **Role cards** on match start show `YOU` on your card (Blue · Pieces / Red · Lamp)
  and the cursor carries your color plus a role glyph; the lamp wears a **red dashed
  grab ring**, pieces glow **blue** under the cursor — the split reads instantly.
- **Blue:** drag pieces anywhere in the arena · **tap a piece to rotate it 45°**.
- **Red:** drag the lamp vertically (grab ring or the whole left strip).
- A piece **locks** when *neither* player has touched it for **0.8 s** and it sits
  within the level's snap tolerance of its solved pose (the lamp locks the same way).
  Lock = sine-sweep chime + flash of both colors. All pieces + lamp locked → level clear.
- Shadow edges glow **cyan** when that piece's shadow matches its target — the glow
  needs *both* the piece right *and* the lamp right, so it rewards simultaneous movement.
- **45 s shared countdown.** On timeout both players get a **hint pulse** (target
  silhouette flashes its correct shadow edges once) and the timer resets — dying
  together is part of the fun.
- 6 levels, tolerances tighten (96 → 78 → 60 → 48 → 38 → 30 px), 2 → 4 pieces.
- Match end: **combined time**, **Best Sync Streak** (consecutive levels cleared with
  no hint), hint count, and the local best time (localStorage). **QUEUE NEW MATCH**
  instantly rematches the same pair (new seed) or re-queues if the partner left.

---

## Architecture — why sync is rock-solid

```
browser A ──ws──┐                       authoritative room state:
browser B ──ws──┼── single Node server  · piece {x, y, rot, locked} × 4
                │   (HTTP static +      · lamp  {y, locked}
                │    RFC6455 sockets,   · deadline, lock timers, streaks
                │    zero deps)         · seeded level payloads
```

- **Server-authoritative at 30 Hz**: clients send intents (`drag/tap/up/ptr`), the
  server clamps to bounds, enforces roles (P2 dragging a piece is rejected, and vice
  versa), runs lock/timeout logic on its own clock, and broadcasts one coalesced
  snapshot to **both** screens. Both clients render the same state machine → the
  exact same view, always.
- **Optimistic local echo + interpolation**: your own drag is 1:1 on pointer move;
  each side owns one field (P1 rotation, P2 lamp Y) so stale echoes can never revert
  an input in flight — remote motion arrives smoothed.
- **Timing is server-driven**: lock idle (0.8 s), intermissions, the 45 s timer, and
  the hint reset all live server-side; clients only *display* a shared deadline.
  Tabs that get throttled still play correctly.
- **Rooms of exactly 2**, enforced at the queue: pair → `start(role)` → seeded match.
  Disconnect ⇒ survivor auto re-queues, ghost pairings are impossible. Both `again`
  taps ⇒ instant rematch on the same socket.
- **Resilience**: ping/pong keepalive, payload-size guards, input rate limits,
  client auto-reconnect with backoff.

## Levels are born solved

`genLevel(seed, idx)` runs on the server: place 2–4 pieces (circle, triangle, L, T)
at random solved poses + a solved lamp height, **verify the projected shadows fit the
board**, then work backwards — offset every piece ≥ tolerance away, nudge rotations
by 45° steps, shove the lamp off its solved height. The dotted target is literally
the solved state's shadow polygon set. Lamp math is one similar-triangles projection:

```
s(ly) = lerp(1.32, 1.92, lampY-normalized)      # global scale
shadow = lamp + (point − lamp) × s              # (+ slight anisotropy for distortion)
```

Moving the lamp changes the projection center *and* the scale → all shadows
translate, stretch, and grow together; the amber cone stretches with it.

## Juice (all procedural, all cheap)

Warm amber cone + rays through piece centers · cyan tolerance glow on shadow edges ·
lock chime (WebAudio sine sweep) + blue/red flash · **NICE SYNC!** + ink-fill +
screen pulse + tiny particle fireworks on clear · hint flash on timeout · streak chip ·
PiP mini-map with target ghost, lamp tick and **both cursors** · mobile-safe hit
areas (lamp strip ≈ full-height grab zone, piece hit radii ≈ 44 px+).

---

## Acceptance test

`test/bot.js` is a headless 2-player suite (raw WebSocket client, zero deps):

```bash
PORT=3100 LEVEL_MS=4000 node server.js &
node test/bot.js 3100
```

Latest results — **31/31 assertions, 3 consecutive runs, no flakes**:

| check | result |
|---|---|
| matchmaking finds partner | **< 8 s** (≈ 5 ms locally) |
| roles exactly p1/p2, rooms exactly 2 (third player queues) | ✓ |
| role routing: P2→piece and P1→lamp inputs rejected | ✓ |
| idle level → shared hint pulse + timer reset on both clients | ✓ |
| P1 drag relayed to P2's screen in real time | ✓ |
| lock events → level clear → 6 levels → win payload (time, streak, stats) | ✓ |
| full match duration | **< 4 min** (≈ 20 s bot pace) |
| instant rematch; disconnect → auto re-queue → new partner < 8 s | ✓ |

Browser-verified with headless Chromium (screenshots in `shots/`): queue, role cards,
mid-action distortion, cyan-glow solve, NICE SYNC + fireworks, win screen — a complete
6-level match with **zero console/page errors**, plus a real-mouse end-to-end run
(hit-testing, drags, tap-rotates, cursor relay, minimap dots).

## Files

```
server.js          HTTP static + WebSocket + matchmaking + authoritative game loop
public/index.html  DOM shell (HUD, queue/role/win overlays)
public/style.css   charcoal/amber/blue/red design system
public/game.js     canvas renderer, input, WebAudio, effects, net client
test/bot.js        headless acceptance suite (minimal RFC6455 client)
shots/             verification screenshots
```
