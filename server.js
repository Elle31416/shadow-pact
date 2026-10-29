'use strict';
/* ============================================================
   SHADOW PACT — real-time 2-player cooperative puzzle server
   - Dependency-free HTTP + WebSocket (matchmaking, rooms of 2)
   - Authoritative state: piece positions, rotations, lamp Y, locks
   - Seeded procedural levels, 45s timer, hints, streaks, win flow
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const LEVEL_MS = Number(process.env.LEVEL_MS) || 45000;   // per-level timer
const ROLE_MS = Number(process.env.ROLE_MS) || 2000;      // grace for the role card on level 1
const LOCK_IDLE_MS = 800;                                 // both players stop touching -> lock
const INTERMISSION_MS = 1600;                             // NICE SYNC! pause between levels

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/* ------------------------------------------------------------
   Static file server
------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.normalize(path.join(PUB, p));
  if (!fp.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

/* ------------------------------------------------------------
   Minimal RFC6455 WebSocket implementation
------------------------------------------------------------ */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Conn {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.alive = Date.now();
    this.closed = false;
    this.fragOp = 0;
    this.frag = [];
    this.onmessage = null;
    this.onclose = null;

    sock.on('data', (d) => {
      this.alive = Date.now();
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      this.parse();
    });
    sock.on('close', () => this.finish());
    sock.on('error', () => this.finish());

    this.pingTimer = setInterval(() => {
      if (Date.now() - this.alive > 55000) return this.finish();
      try { this.raw(0x9, Buffer.alloc(0)); } catch { this.finish(); }
    }, 20000);
  }

  raw(op, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | op, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.sock.write(Buffer.concat([header, payload]));
  }

  send(obj) {
    try { this.raw(0x1, Buffer.from(JSON.stringify(obj), 'utf8')); } catch { this.finish(); }
  }

  readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > 2n * 1024n * 1024n) { this.finish(); return null; }
      len = Number(big); off = 10;
    }
    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4); off += 4;
    }
    if (b.length < off + len) return null;
    let pay = b.subarray(off, off + len);
    if (mask) {
      pay = Buffer.from(pay);
      for (let i = 0; i < pay.length; i++) pay[i] ^= mask[i & 3];
    }
    this.buf = b.subarray(off + len);
    return { fin, op, payload: pay };
  }

  parse() {
    for (;;) {
      const f = this.readFrame();
      if (!f) break;
      if (f.op === 0x0 || f.op === 0x1 || f.op === 0x2) {
        // fragmentation support (text/binary)
        if (f.op !== 0x0) { this.fragOp = f.op; this.frag = [f.payload]; }
        else this.frag.push(f.payload);
        if (f.fin) {
          const op = this.fragOp || f.op;
          const full = Buffer.concat(this.frag);
          this.frag = []; this.fragOp = 0;
          if (op === 0x1) {
            let msg;
            try { msg = JSON.parse(full.toString('utf8')); } catch { continue; }
            if (this.onmessage) this.onmessage(msg);
          }
        }
      } else if (f.op === 0x8) {
        this.finish();
        break;
      } else if (f.op === 0x9) {
        this.raw(0xA, f.payload);
      } // 0xA pong: alive already updated
    }
  }

  finish(kill) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    try { this.sock.destroy(); } catch {}
    if (this.onclose) this.onclose();
  }
}

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    sock.destroy(); return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  sock.setNoDelay(true);
  const conn = new Conn(sock);
  handleConnection(conn);
});

/* ------------------------------------------------------------
   World / game constants  (mirrored by client)
------------------------------------------------------------ */
const W = 1200, H = 750;
const LAMP = { x: 72, min: 110, max: 640, sMin: 1.32, sMax: 1.92, aniso: 0.16 };
const AREA = { x0: 250, x1: 780, y0: 140, y1: 620 };
const TOL = [96, 78, 60, 48, 38, 30];          // position snap tolerance (px)
const LAMP_TOL = [72, 60, 50, 40, 32, 26];     // lamp snap tolerance (px)
const ROT_TOL = 20;                            // deg (rotations are 45° snapped)
const N_PIECES = [2, 3, 3, 4, 4, 4];
const SHAPES = ['circle', 'triangle', 'L', 'T'];

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function scaleAt(ly) {
  const u = (ly - LAMP.min) / (LAMP.max - LAMP.min);
  const s = LAMP.sMin + (LAMP.sMax - LAMP.sMin) * u;
  return { sx: s, sy: s * (1 + LAMP.aniso * (u - 0.5) * 2) };
}
function project(px, py, ly) {
  const { sx, sy } = scaleAt(ly);
  return [LAMP.x + (px - LAMP.x) * sx, ly + (py - ly) * sy];
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shapePoly(shape) {
  switch (shape) {
    case 'circle': {
      const pts = [];
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * Math.PI * 2;
        pts.push([Math.cos(a), Math.sin(a)]);
      }
      return pts;
    }
    case 'triangle': return [[0, -1.2], [1.04, 0.6], [-1.04, 0.6]];
    case 'L': return [[-1, -1], [-0.25, -1], [-0.25, 0.35], [1, 0.35], [1, 1], [-1, 1]];
    case 'T': return [[-1, -1], [1, -1], [1, -0.35], [0.3, -0.35], [0.3, 1], [-0.3, 1], [-0.3, -0.35], [-1, -0.35]];
    default: return [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  }
}
function worldPts(unit, size, x, y, rotDeg) {
  const r = (rotDeg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return unit.map(([ux, uy]) => {
    const px = ux * size, py = uy * size;
    return [x + px * c - py * s, y + px * s + py * c];
  });
}

/* ------------------------------------------------------------
   Seeded procedural level generation
   Start from solved state -> offset pieces + lamp -> that IS the
   start state; target silhouette = shadows of the solved state.
------------------------------------------------------------ */
function genLevel(roomSeed, idx) {
  const rnd = mulberry32((roomSeed ^ (idx * 7919)) >>> 0);
  const n = N_PIECES[idx - 1];
  const tol = TOL[idx - 1];
  const lampTol = LAMP_TOL[idx - 1];

  // pick shapes (distinct when possible)
  const bag = SHAPES.slice();
  for (let i = bag.length - 1 > 0 ? bag.length - 1 : 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  const shapes = [];
  for (let i = 0; i < n; i++) shapes.push(bag[i % bag.length]);

  // --- find a valid solved state ---
  let solved = null;
  for (let attempt = 0; attempt < 60 && !solved; attempt++) {
    const sizeShrink = 1 - Math.min(0.28, attempt * 0.012);
    const items = [];
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      const size = (46 + rnd() * 16) * sizeShrink;
      let x = 0, y = 0, placed = false;
      for (let tries = 0; tries < 40 && !placed; tries++) {
        x = AREA.x0 + 40 + rnd() * (AREA.x1 - AREA.x0 - 80);
        y = AREA.y0 + 40 + rnd() * (AREA.y1 - AREA.y0 - 80);
        placed = items.every((p) => Math.hypot(p.x - x, p.y - y) > p.size + size + 46);
      }
      if (!placed) { ok = false; break; }
      items.push({ id: 'p' + i, shape: shapes[i], size, x, y, rot: Math.floor(rnd() * 8) * 45 });
    }
    if (!ok) continue;
    const solvedLampY = LAMP.min + 150 + rnd() * (LAMP.max - LAMP.min - 300);
    // solved shadows must fit the board
    let fits = true;
    for (const it of items) {
      const pts = worldPts(shapePoly(it.shape), it.size, it.x, it.y, it.rot);
      for (const [px, py] of pts) {
        const [sx, sy] = project(px, py, solvedLampY);
        if (sx > 1145 || sy < 42 || sy > 708) { fits = false; break; }
      }
      if (!fits) break;
    }
    if (fits) solved = { items, lampY: Math.round(solvedLampY) };
  }
  if (!solved) { // ultra-safe fallback: small central pieces
    const items = shapes.map((sh, i) => ({
      id: 'p' + i, shape: sh, size: 42,
      x: 320 + (i % 2) * 190, y: 240 + Math.floor(i / 2) * 210, rot: 0,
    }));
    solved = { items, lampY: (LAMP.min + LAMP.max) / 2 };
  }

  // --- random start: offset everything ---
  const startItems = solved.items.map((it) => {
    const ang = rnd() * Math.PI * 2;
    const dist = Math.max(110, tol * 1.55) + rnd() * 55;
    let x = it.x, y = it.y;
    for (let tries = 0; tries < 6; tries++) {
      const a = tries === 0 ? ang : rnd() * Math.PI * 2;
      const d = tries === 0 ? dist : dist * (0.7 + rnd() * 0.6);
      x = clamp(it.x + Math.cos(a) * d, AREA.x0 + 30, AREA.x1 - 30);
      y = clamp(it.y + Math.sin(a) * d, AREA.y0 + 30, AREA.y1 - 30);
      if (Math.hypot(x - it.x, y - it.y) > tol * 1.25) break;
    }
    const rot = (it.rot + 45 * (1 + Math.floor(rnd() * 3))) % 360;
    return { id: it.id, x: Math.round(x), y: Math.round(y), rot };
  });

  const lOff = lampTol * 2.2 + 60 + rnd() * 130;
  const dir = rnd() < 0.5 ? -1 : 1;
  let startLamp = clamp(solved.lampY + dir * lOff, LAMP.min, LAMP.max);
  if (Math.abs(startLamp - solved.lampY) <= lampTol * 1.5) {
    startLamp = clamp(solved.lampY - dir * lOff, LAMP.min, LAMP.max);
  }

  // --- target silhouette: shadows of the SOLVED state ---
  const target = solved.items.map((it) => {
    const pts = worldPts(shapePoly(it.shape), it.size, it.x, it.y, it.rot);
    return pts.map(([px, py]) => {
      const [sx, sy] = project(px, py, solved.lampY);
      return [Math.round(sx * 10) / 10, Math.round(sy * 10) / 10];
    });
  });

  return {
    idx,
    tol,
    lampTol,
    rotTol: ROT_TOL,
    cfg: { W, H, lampX: LAMP.x, lampMin: LAMP.min, lampMax: LAMP.max },
    pieces: solved.items.map((it) => ({ id: it.id, shape: it.shape, size: Math.round(it.size * 10) / 10 })),
    solved: {
      pieces: solved.items.map((it) => ({ id: it.id, x: Math.round(it.x), y: Math.round(it.y), rot: it.rot })),
      lampY: Math.round(solved.lampY),
    },
    start: {
      pieces: startItems,
      lampY: Math.round(startLamp),
    },
    target,
  };
}

/* ------------------------------------------------------------
   Matchmaking + rooms
------------------------------------------------------------ */
let nextPlayerId = 1;
let nextRoomId = 1;
const queue = [];          // waiting players
const rooms = new Map();   // roomId -> room

function send(p, obj) { if (p && p.conn && !p.conn.closed) p.conn.send(obj); }
function other(room, p) { return room.players[0] === p ? room.players[1] : room.players[0]; }
function broadcast(room, obj) { for (const p of room.players) send(p, obj); }

function handleConnection(conn) {
  const p = {
    id: 'P' + nextPlayerId++,
    conn,
    room: null,
    role: null,
    wantAgain: false,
    msgWindow: Date.now(),
    msgCount: 0,
  };

  conn.onmessage = (msg) => onMessage(p, msg);
  conn.onclose = () => onLeave(p);

  send(p, { t: 'hello', id: p.id });
  enqueue(p, null);
}

function enqueue(p, reason) {
  if (p.room) leaveRoom(p, false);
  p.role = null;
  p.wantAgain = false;
  if (!queue.includes(p)) queue.push(p);
  send(p, { t: 'queue', reason: reason || null });
  tryMatch();
}

function tryMatch() {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    if (a.conn.closed || b.conn.closed) {
      if (!a.conn.closed) queue.unshift(a);
      if (!b.conn.closed) queue.unshift(b);
      continue;
    }
    startMatch(a, b);
  }
}

function startMatch(a, b) {
  const room = {
    id: 'R' + nextRoomId++,
    seed: crypto.randomInt(1, 2 ** 31 - 1),
    players: [a, b],
    lvl: null,
    state: null,
    lastTouch: {},
    loadAt: 0,
    deadline: 0,
    dirty: false,
    intermission: false,
    ended: false,
    lvlTimeouts: 0,
    totalHints: 0,
    streak: 0,
    streakBest: 0,
    matchStart: 0,
    stats: [],
    timers: [],
    againTimer: null,
  };
  rooms.set(room.id, room);
  a.room = room; a.role = 'p1'; a.wantAgain = false;
  b.room = room; b.role = 'p2'; b.wantAgain = false;

  send(a, { t: 'start', role: 'p1', peerId: b.id });
  send(b, { t: 'start', role: 'p2', peerId: a.id });
  loadLevel(room, 1, true);
}

function loadLevel(room, idx, first) {
  for (const t of room.timers) clearTimeout(t);
  room.timers = [];
  const lvl = genLevel(room.seed, idx);
  room.lvl = lvl;
  room.state = {
    pieces: lvl.start.pieces.map((s, i) => ({
      id: lvl.pieces[i].id, x: s.x, y: s.y, rot: s.rot, locked: false,
    })),
    lamp: { y: lvl.start.lampY, locked: false },
  };
  room.lastTouch = {};
  room.loadAt = Date.now();
  room.deadline = room.loadAt + LEVEL_MS + (first ? ROLE_MS : 0);
  room.intermission = false;
  room.lvlTimeouts = 0;
  room.dirty = true;
  if (first) {
    room.matchStart = Date.now();
    room.stats = [];
    room.totalHints = 0;
    room.streak = 0;
    room.streakBest = 0;
  }
  broadcast(room, { t: 'level', lvl, lvlMs: LEVEL_MS, deadline: room.deadline, rem: room.deadline - Date.now(), first: !!first });
}

function stateSnapshot(room) {
  return {
    t: 'state',
    pieces: room.state.pieces,
    lamp: room.state.lamp,
    rem: Math.max(0, room.deadline - Date.now()),
    dirty: true,
  };
}

function checkLocks(room, now) {
  const lvl = room.lvl;
  if (!lvl || room.intermission) return;
  const events = [];
  const idle = (k) => now - (room.lastTouch[k] != null ? room.lastTouch[k] : room.loadAt) >= LOCK_IDLE_MS;

  for (const sp of room.state.pieces) {
    if (sp.locked) continue;
    const sol = lvl.solved.pieces.find((s) => s.id === sp.id);
    if (!sol) continue;
    const d = Math.hypot(sp.x - sol.x, sp.y - sol.y);
    const dr = Math.abs(((sp.rot - sol.rot) % 360 + 540) % 360 - 180);
    const rotClose = Math.min(dr, 360 - dr) <= lvl.rotTol;
    if (d <= lvl.tol && rotClose && idle(sp.id)) {
      sp.locked = true;
      events.push(sp.id);
    }
  }
  const lamp = room.state.lamp;
  if (!lamp.locked &&
      Math.abs(lamp.y - lvl.solved.lampY) <= lvl.lampTol &&
      idle('lamp')) {
    lamp.locked = true;
    events.push('lamp');
  }
  if (events.length) {
    room.dirty = true;
    broadcast(room, { t: 'lock', ids: events, rem: Math.max(0, room.deadline - Date.now()) });
  }
  const allLocked = room.state.pieces.every((p) => p.locked) && lamp.locked;
  if (allLocked) clearLevel(room, now);
}

function clearLevel(room, now) {
  room.intermission = true;
  const lvl = room.lvl;
  if (room.lvlTimeouts === 0) room.streak++;
  else room.streak = 0;
  room.streakBest = Math.max(room.streakBest, room.streak);
  room.stats.push({ idx: lvl.idx, hints: room.lvlTimeouts });
  const totalMs = now - room.matchStart;
  broadcast(room, {
    t: 'clear',
    idx: lvl.idx,
    streak: room.streak,
    streakBest: room.streakBest,
    totalMs,
  });

  if (lvl.idx >= 6) {
    room.timers.push(setTimeout(() => {
      room.lvl = null;
      room.ended = true;
      broadcast(room, {
        t: 'end',
        totalMs: Date.now() - room.matchStart,
        streakBest: room.streakBest,
        hints: room.totalHints,
        levels: room.stats,
      });
      // auto-rematch if both already asked; otherwise wait briefly
      room.againTimer = setTimeout(() => {
        const waiting = room.players.filter((p) => p.wantAgain);
        if (waiting.length === 1) enqueue(waiting[0], 'partner-left');
        else if (waiting.length === 0) dissolveRoom(room, 'ended');
      }, 30000);
    }, INTERMISSION_MS));
  } else {
    room.timers.push(setTimeout(() => {
      if (room.lvl) loadLevel(room, lvl.idx + 1, false);
    }, INTERMISSION_MS));
  }
}

function handleTimeout(room, now) {
  room.lvlTimeouts++;
  room.totalHints++;
  room.deadline = now + LEVEL_MS;
  broadcast(room, { t: 'timeout', deadline: room.deadline, rem: LEVEL_MS, lvlMs: LEVEL_MS, hints: room.totalHints });
}

function tick() {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.lvl || room.intermission || room.ended) continue;
    checkLocks(room, now);
    if (!room.lvl || room.intermission) continue;
    if (now >= room.deadline) handleTimeout(room, now);
    if (room.dirty) {
      room.dirty = false;
      broadcast(room, stateSnapshot(room));
    }
  }
}
setInterval(tick, 33);

/* ------------------------------------------------------------
   Input (role-checked, clamped, rate-limited)
------------------------------------------------------------ */
function onMessage(p, msg) {
  if (!msg || typeof msg.t !== 'string') return;
  if (process.env.DEBUG_IO) console.log('[io]', p.id, p.role, JSON.stringify(msg));

  // crude rate limit: 80 msgs / 500ms
  const now = Date.now();
  if (now - p.msgWindow > 500) { p.msgWindow = now; p.msgCount = 0; }
  if (++p.msgCount > 80) return;

  if (msg.t === 'again') {
    handleAgain(p);
    return;
  }
  if (msg.t === 'wake') {
    if (p.room && p.room.lvl) send(p, stateSnapshot(p.room));
    return;
  }
  const room = p.room;
  if (!room || !room.lvl || room.intermission || room.ended) return;

  if (msg.t === 'ptr') {
    const x = clamp(Number(msg.x) || 0, 0, W);
    const y = clamp(Number(msg.y) || 0, 0, H);
    send(other(room, p), { t: 'cursor', role: p.role, x, y });
    return;
  }

  if (p.role === 'p1') {
    if (msg.t === 'drag') {
      const sp = room.state.pieces.find((s) => s.id === msg.id);
      if (!sp || sp.locked) return;
      sp.x = Math.round(clamp(Number(msg.x) || 0, AREA.x0 + 20, AREA.x1 - 20));
      sp.y = Math.round(clamp(Number(msg.y) || 0, AREA.y0 + 20, AREA.y1 - 20));
      room.lastTouch[sp.id] = now;
      room.dirty = true;
    } else if (msg.t === 'tap') {
      const sp = room.state.pieces.find((s) => s.id === msg.id);
      if (!sp || sp.locked) return;
      sp.rot = ((sp.rot + 45) % 360 + 360) % 360;
      room.lastTouch[sp.id] = now;
      room.dirty = true;
    } else if (msg.t === 'up') {
      if (room.state.pieces.some((s) => s.id === msg.id && !s.locked)) {
        room.lastTouch[msg.id] = now;
      }
    }
  } else if (p.role === 'p2') {
    if (msg.t === 'drag' && msg.id === 'lamp') {
      const lamp = room.state.lamp;
      if (lamp.locked) return;
      lamp.y = Math.round(clamp(Number(msg.y) || 0, LAMP.min, LAMP.max));
      room.lastTouch.lamp = now;
      room.dirty = true;
    } else if (msg.t === 'up' && msg.id === 'lamp') {
      if (!room.state.lamp.locked) room.lastTouch.lamp = now;
    }
  }
}

function handleAgain(p) {
  const room = p.room;
  if (room && room.ended) {
    p.wantAgain = true;
    const all = room.players.every((q) => q.conn.closed || q.wantAgain);
    const ready = room.players.filter((q) => !q.conn.closed && q.wantAgain);
    if (ready.length === 2) {
      clearTimeout(room.againTimer);
      room.ended = false;
      room.wantReset = true;
      for (const q of room.players) { q.wantAgain = false; }
      send(room.players[0], { t: 'start', role: 'p1', peerId: room.players[1].id });
      send(room.players[1], { t: 'start', role: 'p2', peerId: room.players[0].id });
      loadLevel(room, 1, true);
    } else if (all && ready.length <= 1 && ready.length >= 0 && room.players.every((q) => q.conn.closed || q.wantAgain) && ready.length === 1) {
      // partner gone: solo requeue happens via againTimer, but act fast:
      clearTimeout(room.againTimer);
      enqueue(p, 'partner-left');
    } else {
      // wait for partner; remind them gently
      const mate = other(room, p);
      if (mate && !mate.conn.closed) send(mate, { t: 'peer', wantAgain: true });
    }
    return;
  }
  if (room) { // mid-game leave -> requeue
    enqueue(p, 'left-match');
  }
}

function leaveRoom(p, notify) {
  const room = p.room;
  if (!room) return;
  p.room = null; p.role = null;
  const mate = other(room, p);
  dissolveRoom(room, 'disconnect');
  if (mate && !mate.conn.closed) {
    send(mate, { t: 'peer', online: false });
    enqueue(mate, 'partner-left');
  }
}

function dissolveRoom(room, why) {
  for (const t of room.timers) clearTimeout(t);
  if (room.againTimer) clearTimeout(room.againTimer);
  for (const p of room.players) {
    if (p.room === room) { p.room = null; p.role = null; }
  }
  rooms.delete(room.id);
}

function onLeave(p) {
  if (queue.includes(p)) {
    const i = queue.indexOf(p);
    queue.splice(i, 1);
  }
  leaveRoom(p, true);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SHADOW PACT server on http://0.0.0.0:${PORT}  (LEVEL_MS=${LEVEL_MS})`);
});
