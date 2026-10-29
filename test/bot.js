'use strict';
/* ============================================================
   SHADOW PACT — headless acceptance test (2 bot players)
   Verifies: matchmaking < 8s · exact-2 rooms · authoritative
   sync relay · hint/timeout flow · locks · 6-level match win ·
   rematch · disconnect + re-partnering.
   Run:  node test/bot.js [port]
   (server should run with a short LEVEL_MS, e.g. 4000)
   ============================================================ */
const net = require('net');
const crypto = require('crypto');

const PORT = Number(process.argv[2]) || 3100;
const HOST = '127.0.0.1';
let passCount = 0, failCount = 0;

function ok(cond, label, extra) {
  if (cond) { passCount++; console.log('  ✓ ' + label + (extra ? '  [' + extra + ']' : '')); }
  else { failCount++; console.log('  ✗ FAIL: ' + label + (extra ? '  [' + extra + ']' : '')); }
}
function fatal(msg) {
  failCount++;
  console.log('\nFATAL: ' + msg);
  finish(1);
}

/* ---------- minimal WebSocket client (client frames masked) ---------- */
class MiniWS {
  constructor(name) {
    this.name = name;
    this.handlers = [];
    this.closeHandlers = [];
    this.buf = Buffer.alloc(0);
    this.handshook = false;
    this.closed = false;
    this.frag = [];
    this.all = [];      // every message, buffered (no waiter-registration races)
    this.cur = 0;       // replay cursor for sequential waits
    this.pending = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      this.sock = net.connect(PORT, HOST, () => {
        this.sock.write(
          `GET / HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      const timer = setTimeout(() => reject(new Error(this.name + ': connect timeout')), 8000);
      this.sock.on('data', (d) => {
        this.buf = Buffer.concat([this.buf, d]);
        if (!this.handshook) {
          const idx = this.buf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          const head = this.buf.subarray(0, idx).toString();
          if (!/101/.test(head)) { clearTimeout(timer); reject(new Error('no 101: ' + head)); return; }
          this.buf = this.buf.subarray(idx + 4);
          this.handshook = true;
          clearTimeout(timer);
          resolve();
        }
        this.parse();
      });
      this.sock.on('close', () => { this.closed = true; for (const h of this.closeHandlers) h(); });
      this.sock.on('error', (e) => { if (!this.handshook) { clearTimeout(timer); reject(e); } });
    });
  }
  send(obj) {
    if (this.closed) return;
    const payload = Buffer.from(JSON.stringify(obj));
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    const m = Buffer.from(payload);
    for (let i = 0; i < m.length; i++) m[i] ^= mask[i & 3];
    this.sock.write(Buffer.concat([header, mask, m]));
  }
  raw(op, payload) {
    const len = payload.length;
    const mask = crypto.randomBytes(4);
    let header;
    if (len < 126) header = Buffer.from([0x80 | op, 0x80 | len]);
    else { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    const m = Buffer.from(payload);
    for (let i = 0; i < m.length; i++) m[i] ^= mask[i & 3];
    this.sock.write(Buffer.concat([header, mask, m]));
  }
  parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      let mask = null;
      if (masked) { if (b.length < off + 4) return; mask = b.subarray(off, off + 4); off += 4; }
      if (b.length < off + len) return;
      let pay = b.subarray(off, off + len);
      if (mask) { pay = Buffer.from(pay); for (let i = 0; i < pay.length; i++) pay[i] ^= mask[i & 3]; }
      this.buf = b.subarray(off + len);
      if (op === 0x1) {
        this.frag.push(pay);
        if (fin) {
          const full = Buffer.concat(this.frag); this.frag = [];
          let msg; try { msg = JSON.parse(full.toString('utf8')); } catch { continue; }
          this.all.push(msg);
          const idx = this.all.length - 1;
          for (const h of this.handlers) h(msg);
          if (this.pending && this.pending.pred(msg)) this.pending.resolve(msg, idx);
        }
      } else if (op === 0x9) this.raw(0xA, pay);
      else if (op === 0x8) { this.close(); return; }
    }
  }
  on(fn) { this.handlers.push(fn); }
  onClose(fn) { this.closeHandlers.push(fn); }
  close() { try { this.raw(0x8, Buffer.alloc(0)); } catch {} try { this.sock.destroy(); } catch {} this.closed = true; }
}

/* ---------- helpers ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitFor(ws, pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    // 1) replay anything already buffered (start/level can share one TCP chunk)
    for (let i = ws.cur; i < ws.all.length; i++) {
      if (pred(ws.all[i])) { ws.cur = i + 1; return resolve(ws.all[i]); }
    }
    // 2) otherwise wait for live delivery
    const t = setTimeout(() => {
      ws.pending = null;
      reject(new Error('timeout waiting for ' + label));
    }, timeoutMs);
    ws.pending = {
      pred,
      resolve: (m, i) => { clearTimeout(t); ws.cur = i + 1; ws.pending = null; resolve(m); },
    };
  });
}
function collect(ws, sink) { ws.on((m) => sink.push(m)); }

function solveLevel(p1ws, p2ws, lvl, opts) {
  // p1: move + rotate every piece to solved; p2: lamp to solved
  const acts = [];
  for (const sol of lvl.solved.pieces) {
    p1ws.send({ t: 'drag', id: sol.id, x: sol.x, y: sol.y });
    const cur = lvl.start.pieces.find((s) => s.id === sol.id);
    let rot = cur.rot;
    let guard = 0;
    while (rot !== sol.rot && guard++ < 8) {
      rot = (rot + 45) % 360;
      p1ws.send({ t: 'tap', id: sol.id });
    }
    p1ws.send({ t: 'up', id: sol.id });
    acts.push('drag+tap ' + sol.id);
  }
  p2ws.send({ t: 'drag', id: 'lamp', y: lvl.solved.lampY });
  p2ws.send({ t: 'up', id: 'lamp' });
  acts.push('lamp=' + lvl.solved.lampY);
  return acts;
}

let exitCode = 0;
function finish(code) {
  console.log(`\n==== RESULT: ${passCount} passed, ${failCount} failed ====`);
  process.exit(code || (failCount ? 1 : 0));
}
setTimeout(() => fatal('global watchdog (90s)'), 90000).unref?.();

/* ---------- main ---------- */
(async () => {
  console.log(`SHADOW PACT acceptance test → ws://${HOST}:${PORT}`);

  /* 1) matchmaking: two players pair up */
  const A = new MiniWS('A'), B = new MiniWS('B');
  const t0 = Date.now();
  await A.connect(); await B.connect();
  const [sa, sb] = await Promise.all([
    waitFor(A, (m) => m.t === 'start', 8000, 'A start'),
    waitFor(B, (m) => m.t === 'start', 8000, 'B start'),
  ]);
  const matchMs = Date.now() - t0;
  ok(matchMs < 8000, 'matchmaking found partner in < 8s', matchMs + 'ms');
  ok(sa.role === 'p1' && sb.role === 'p2', 'roles assigned exactly p1/p2', sa.role + '/' + sb.role);

  let lvl1, lvl2;
  const [l1a] = await Promise.all([
    waitFor(A, (m) => m.t === 'level', 5000, 'A level1'),
    waitFor(B, (m) => m.t === 'level', 5000, 'B level1'),
  ]);
  lvl1 = l1a.lvl;
  ok(lvl1.idx === 1 && lvl1.pieces.length === 2, 'level 1 generated (2 pieces)', JSON.stringify(lvl1.pieces.map((p) => p.shape)));
  ok(lvl1.target.length === lvl1.pieces.length && lvl1.target[0].length >= 3, 'target silhouette computed from solved state');
  ok(lvl1.start.lampY !== lvl1.solved.lampY, 'lamp start offset from solved', lvl1.start.lampY + '→' + lvl1.solved.lampY);

  /* 2) role routing: p2 cannot move pieces, p1 cannot move lamp */
  const bStates = []; collect(B, bStates);
  B.send({ t: 'drag', id: lvl1.pieces[0].id, x: 500, y: 400 }); // illegal (p2 → piece)
  A.send({ t: 'drag', id: 'lamp', y: 300 });                   // illegal (p1 → lamp)
  await sleep(250);
  ok(!bStates.some((m) => m.t === 'state' && m.pieces && m.pieces[0].x === 500),
    'p2 input on pieces rejected by server');
  ok(!bStates.some((m) => m.t === 'state' && m.lamp && m.lamp.y === 300),
    'p1 input on lamp rejected by server');

  /* 3) hint/timeout: nobody moves -> both must see the hint pulse */
  const tmoA = waitFor(A, (m) => m.t === 'timeout', 12000, 'A timeout');
  const tmoB = waitFor(B, (m) => m.t === 'timeout', 12000, 'B timeout');
  await Promise.all([tmoA, tmoB]);
  ok(true, 'idle level → shared hint pulse (timer reset) for both players');
  ok(!bStates.some((m) => m.t === 'lock'), 'no premature locks before solving');

  /* 4) real-time sync: p1 drag shows up on p2\'s screen */
  const probe = lvl1.solved.pieces[0];
  const px = probe.x + 11, py = probe.y + 9;
  A.send({ t: 'drag', id: probe.id, x: px, y: py });
  const st = await waitFor(B, (m) => m.t === 'state' && m.pieces.some((p) => p.id === probe.id && p.x === px && p.y === py),
    1500, 'B receives A drag');
  ok(!!st, 'piece drag relayed to partner in real time', '<1.5s');

  /* 5) solve level 1 → locks → clear */
  solveLevel(A, B, lvl1);
  const lockA = waitFor(A, (m) => m.t === 'lock', 4000, 'A locks');
  const lockB = waitFor(B, (m) => m.t === 'lock', 4000, 'B locks');
  await Promise.all([lockA, lockB]);
  ok(true, 'both players receive lock events (chime + flash)');
  await Promise.all([
    waitFor(A, (m) => m.t === 'clear', 5000, 'A clear'),
    waitFor(B, (m) => m.t === 'clear', 5000, 'B clear'),
  ]);
  ok(true, 'level 1 cleared (all pieces + lamp locked)');

  /* 6) levels 2..6 */
  for (let idx = 2; idx <= 6; idx++) {
    const [la] = await Promise.all([
      waitFor(A, (m) => m.t === 'level' && m.lvl.idx === idx, 6000, 'A level' + idx),
      waitFor(B, (m) => m.t === 'level' && m.lvl.idx === idx, 6000, 'B level' + idx),
    ]);
    const lvl = la.lvl;
    if (idx === 2) lvl2 = lvl;
    ok(lvl.pieces.length >= 3 && lvl.tol <= 78, `level ${idx} generated (tol ${lvl.tol}px, ${lvl.pieces.length} pieces)`);
    solveLevel(A, B, lvl);
    await Promise.all([
      waitFor(A, (m) => m.t === 'clear' && m.idx === idx, 6000, 'A clear' + idx),
      waitFor(B, (m) => m.t === 'clear' && m.idx === idx, 6000, 'B clear' + idx),
    ]);
    ok(true, `level ${idx} cleared`);
  }

  /* 7) win screen data */
  const [endA] = await Promise.all([
    waitFor(A, (m) => m.t === 'end', 6000, 'A end'),
    waitFor(B, (m) => m.t === 'end', 6000, 'B end'),
  ]);
  ok(typeof endA.totalMs === 'number' && endA.totalMs > 0, 'match end: combined time', (endA.totalMs / 1000).toFixed(1) + 's');
  ok(typeof endA.streakBest === 'number' && endA.streakBest >= 1, 'match end: Best Sync Streak', String(endA.streakBest));
  ok(Array.isArray(endA.levels) && endA.levels.length === 6, 'match end: 6 level stats');
  ok(endA.totalMs < 240000, 'entire match finishes in < 4 minutes', (endA.totalMs / 1000).toFixed(1) + 's');

  /* 8) exactly-2 rooms: a third player waits, never joins mid-match */
  const C = new MiniWS('C');
  await C.connect();
  let cStarted = false;
  C.on((m) => { if (m.t === 'start') cStarted = true; });
  const cQueue = await waitFor(C, (m) => m.t === 'queue', 3000, 'C queue');
  await sleep(1200);
  ok(cQueue && !cStarted, 'third player queued — rooms are exactly 2');
  C.close();

  /* 9) instant rematch when both tap "queue again" */
  A.send({ t: 'again' });
  B.send({ t: 'again' });
  await Promise.all([
    waitFor(A, (m) => m.t === 'start', 5000, 'A rematch'),
    waitFor(B, (m) => m.t === 'start', 5000, 'B rematch'),
  ]);
  ok(true, 'instant rematch for the same pair (new seed)');
  await Promise.all([
    waitFor(A, (m) => m.t === 'level', 5000, 'A rematch level'),
    waitFor(B, (m) => m.t === 'level', 5000, 'B rematch level'),
  ]);
  ok(true, 'rematch level 1 delivered');

  /* 10) disconnect → partner re-queues → new partner found */
  A.close();
  const bQ = await waitFor(B, (m) => m.t === 'queue', 5000, 'B requeue after partner left');
  ok(bQ.reason === 'partner-left', 'partner disconnect → survivor auto re-queues', bQ.reason);

  const D = new MiniWS('D');
  const tD = Date.now();
  await D.connect();
  await Promise.all([
    waitFor(B, (m) => m.t === 'start', 8000, 'B new partner'),
    waitFor(D, (m) => m.t === 'start', 8000, 'D start'),
  ]);
  ok(Date.now() - tD < 8000, 'new partner matched in < 8s', (Date.now() - tD) + 'ms');

  B.close(); D.close();
  console.log('');
  finish(failCount ? 1 : 0);
})().catch((e) => fatal(e.message));
