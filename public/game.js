/* ============================================================
   SHADOW PACT — client
   One shared canvas · blue drags pieces · red drags the lamp
   Server is authoritative; client renders optimistically with
   interpolation so both screens always show the same view.
   ============================================================ */
'use strict';

/* ---------- constants (mirror server) ---------- */
const W = 1200, H = 750;
const LAMP = { x: 72, min: 110, max: 640, sMin: 1.32, sMax: 1.92, aniso: 0.16 };
const AREA = { x0: 250, x1: 780, y0: 140, y1: 620 };
const COLORS = {
  bg: '#101216', ink: '#030407',
  amber: '#ffb454', blue: '#4f9dff', red: '#ff5f5f', cyan: '#7de8ff',
};
const ROLE_CARD_MS = 2200;
const DEFAULT_LVL_MS = 45000;
const DEBUG_INPUT = /[?&]dbg=1/.test(location.search);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const now = () => performance.now();

function scaleAt(ly) {
  const u = (ly - LAMP.min) / (LAMP.max - LAMP.min);
  const s = LAMP.sMin + (LAMP.sMax - LAMP.sMin) * u;
  return { sx: s, sy: s * (1 + LAMP.aniso * (u - 0.5) * 2) };
}
function project(px, py, ly) {
  const { sx, sy } = scaleAt(ly);
  return [LAMP.x + (px - LAMP.x) * sx, ly + (py - ly) * sy];
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
const angLerp = (a, b, t) => {
  const d = (((b - a) % 360) + 540) % 360 - 180;
  return a + d * t;
};

/* ---------- dom ---------- */
const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');
const hud = $('hud');
const overlayQueue = $('queue-screen');
const overlayRole = $('role-screen');
const overlayWin = $('win-screen');
const timerFill = $('timer-fill');
const timerNum = $('timer-num');
const lvlChip = $('lvl-chip');
const streakChip = $('streak-chip');
const queueText = $('queue-text');
const queueHint = $('queue-hint');

/* ---------- game state ---------- */
const G = {
  phase: 'boot',          // boot | queue | role | play | clear | win
  role: null,             // p1 | p2
  lvl: null,              // level payload
  lvlMs: DEFAULT_LVL_MS,
  pieces: [],             // {id,shape,size,x,y,rot,locked, rx,ry,rrot}
  lamp: { y: (LAMP.min + LAMP.max) / 2, locked: false, ry: (LAMP.min + LAMP.max) / 2 },
  remAnchor: { rem: DEFAULT_LVL_MS, at: now() },
  levelIdx: 1,
  streak: 0,
  roleUntil: 0,
  lockFlash: {},          // id -> t0
  hintT0: -1e9,
  clearT0: -1e9,
  bannerT0: -1e9,
  clearIdx: 1,
  dragging: null,         // piece id | 'lamp'
  hover: null,
  particles: [],
  screenPulse: 0,
  seenLocal: false,
  remote: { seen: false, role: null, x: 0, y: 0, rx: 0, ry: 0 },
  local: { x: W / 2, y: H / 2 },
  hints: 0,
  peerOnline: true,
};

/* ---------- viewport transform ---------- */
let view = { s: 1, ox: 0, oy: 0, cw: 0, ch: 0, dpr: 1 };
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = window.innerWidth, ch = window.innerHeight;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  const s = Math.min(cw / W, ch / H);
  view = { s, ox: (cw - W * s) / 2, oy: (ch - H * s) / 2, cw, ch, dpr };
}
window.addEventListener('resize', resize);
resize();

function toWorld(cx, cy) {
  return { x: (cx - view.ox) / view.s, y: (cy - view.oy) / view.s };
}

/* ---------- audio (WebAudio sine sweeps — no assets) ---------- */
let AC = null;
let muted = localStorage.getItem('sp_mute') === '1';
function ensureAudio() {
  if (!AC) {
    try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch { AC = null; }
  }
  if (AC && AC.state === 'suspended') AC.resume();
}
function tone(f0, f1, dur, type, vol, delay) {
  if (!AC || muted) return;
  const t0 = AC.currentTime + (delay || 0);
  const o = AC.createOscillator();
  const g = AC.createGain();
  o.type = type || 'sine';
  o.frequency.setValueAtTime(f0, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(AC.destination);
  o.start(t0); o.stop(t0 + dur + 0.05);
}
const sfx = {
  lock: () => { tone(620, 1080, 0.16, 'sine', 0.16); tone(1240, 1620, 0.1, 'sine', 0.05, 0.03); },
  rot: () => tone(880, 1150, 0.05, 'square', 0.045),
  clear: () => { tone(523, 784, 0.22, 'sine', 0.15); tone(784, 1176, 0.3, 'sine', 0.13, 0.12); tone(1046, 1568, 0.34, 'sine', 0.09, 0.24); },
  hint: () => { tone(210, 150, 0.3, 'triangle', 0.13); tone(105, 75, 0.34, 'triangle', 0.08, 0.04); },
  win: () => { [523, 659, 784, 1046].forEach((f, i) => tone(f, f * 1.01, 0.45, 'sine', 0.12, i * 0.13)); },
  tick: () => tone(430, 470, 0.5, 'sine', 0.03),
};
$('mute-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  muted = !muted;
  localStorage.setItem('sp_mute', muted ? '1' : '0');
  $('mute-btn').classList.toggle('muted', muted);
  ensureAudio();
});
$('mute-btn').classList.toggle('muted', muted);

/* ---------- networking ---------- */
let ws = null;
let intentionalClose = false;
let retry = 0;
const URL_WS = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

function showQueue(reason) {
  G.phase = 'queue';
  hud.classList.add('hidden');
  overlayWin.classList.add('hidden');
  overlayRole.classList.add('hidden');
  overlayQueue.classList.remove('hidden');
  if (reason === 'partner-left') {
    queueText.textContent = 'SHADOW LOST — FINDING A NEW ONE…';
    queueHint.textContent = 'your partner left the room';
  } else if (reason === 'reconnecting') {
    queueText.textContent = 'RECONNECTING…';
    queueHint.textContent = 'hold on — rejoining the pact';
  } else if (reason === 'again') {
    queueText.textContent = 'READY — WAITING FOR YOUR SHADOW…';
    queueHint.textContent = 'both players tap QUEUE NEW MATCH to rematch instantly';
  } else {
    queueText.textContent = 'FINDING YOUR SHADOW…';
    queueHint.textContent = 'open this page on a second screen — rooms are exactly 2 players';
  }
}

function connect() {
  intentionalClose = false;
  try { ws = new WebSocket(URL_WS); } catch { setTimeout(connect, 1500); return; }
  ws.onopen = () => { retry = 0; send({ t: 'wake' }); };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMsg(msg);
  };
  ws.onclose = () => {
    if (intentionalClose) return;
    showQueue('reconnecting');
    retry++;
    setTimeout(connect, Math.min(5000, 700 * retry));
  };
  ws.onerror = () => {};
}

function handleMsg(msg) {
  switch (msg.t) {
    case 'hello': break;

    case 'queue':
      showQueue(msg.reason);
      break;

    case 'start': {
      G.role = msg.role;
      overlayQueue.classList.add('hidden');
      overlayWin.classList.add('hidden');
      hud.classList.remove('hidden');
      G.phase = 'role';
      G.roleUntil = now() + ROLE_CARD_MS;
      overlayRole.classList.remove('hidden');
      G.remote.seen = false;
      G.dragging = null;
      // personalize the cards: my card = YOU, the other = PARTNER
      const mine = G.role === 'p1' ? 'blue' : 'red';
      const theirs = mine === 'blue' ? 'red' : 'blue';
      $('you-' + mine).textContent = 'YOU';
      $('you-' + theirs).textContent = 'PARTNER';
      $('role-card-' + mine).classList.remove('partner');
      $('role-card-' + theirs).classList.add('partner');
      break;
    }

    case 'level': {
      const lvl = msg.lvl;
      G.lvl = lvl;
      G.levelIdx = lvl.idx;
      G.lvlMs = msg.lvlMs || DEFAULT_LVL_MS;
      G.pieces = lvl.start.pieces.map((s, i) => {
        const p = lvl.pieces[i];
        return {
          id: p.id, shape: p.shape, size: p.size,
          x: s.x, y: s.y, rot: s.rot, locked: false,
          rx: s.x, ry: s.y, rrot: s.rot,
        };
      });
      G.lamp = { y: lvl.start.lampY, locked: false, ry: lvl.start.lampY };
      G.remAnchor = { rem: msg.rem != null ? msg.rem : G.lvlMs, at: now() };
      G.lockFlash = {};
      G.dragging = null;
      G.hover = null;
      G.bannerT0 = now();
      G.clearT0 = -1e9;
      G.hintT0 = -1e9;
      G.particles.length = 0;
      if (msg.first || G.phase !== 'role') {
        if (G.phase !== 'role') G.phase = 'play';
      }
      updateHudChips();
      break;
    }

    case 'state': {
      if (!G.lvl) break;
      for (const sp of msg.pieces || []) {
        const p = G.pieces.find((q) => q.id === sp.id);
        if (!p) continue;
        if (p.rot !== sp.rot && G.role !== 'p1') sfx.tick();
        p.x = sp.x; p.y = sp.y;
        // p1 is the sole owner of rotation — never let a stale echo
        // revert an optimistic tap (remote p1 taps always apply for p2)
        if (G.role !== 'p1') p.rot = sp.rot;
        p.locked = sp.locked;
      }
      if (msg.lamp) {
        // p2 owns the lamp — same rule: never revert an optimistic drag
        if (G.role !== 'p2') G.lamp.y = msg.lamp.y;
        G.lamp.locked = msg.lamp.locked;
      }
      G.remAnchor = { rem: msg.rem, at: now() };
      break;
    }

    case 'lock': {
      const ids = msg.ids || [];
      ids.forEach((id, i) => {
        G.lockFlash[id] = now() + i * 90;
        const p = G.pieces.find((q) => q.id === id);
        if (p) p.locked = true;
        if (id === 'lamp') G.lamp.locked = true;
        setTimeout(() => sfx.lock(), i * 90);
      });
      break;
    }

    case 'timeout': {
      G.hintT0 = now();
      G.remAnchor = { rem: msg.rem, at: now() };
      G.hints = msg.hints || G.hints + 1;
      sfx.hint();
      break;
    }

    case 'clear': {
      G.phase = 'clear';
      G.clearT0 = now();
      G.clearIdx = msg.idx;
      G.streak = msg.streak;
      G.roleUntil = 0;
      overlayRole.classList.add('hidden');
      spawnFireworks();
      sfx.clear();
      updateHudChips();
      break;
    }

    case 'end': {
      G.phase = 'win';
      G.roleUntil = 0;
      overlayRole.classList.add('hidden');
      hud.classList.add('hidden');
      showWin(msg);
      sfx.win();
      spawnFireworks(true);
      break;
    }

    case 'cursor': {
      if (msg.role === G.role) break;
      const r = G.remote;
      if (!r.seen) { r.rx = msg.x; r.ry = msg.y; }
      r.seen = true; r.role = msg.role; r.x = msg.x; r.y = msg.y;
      break;
    }

    case 'peer': {
      if (msg.online === false) {
        G.peerOnline = false;
        toast('PARTNER LEFT');
      }
      if (msg.wantAgain) toast('PARTNER IS READY');
      break;
    }
  }
}

function updateHudChips() {
  lvlChip.innerHTML = G.levelIdx + '<span class="dim">/6</span>';
  if (G.streak >= 2) {
    streakChip.classList.remove('hidden');
    streakChip.innerHTML = 'SYNC&times;' + G.streak;
  } else streakChip.classList.add('hidden');
}

/* ---------- win ---------- */
function fmt(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function showWin(msg) {
  $('win-time').textContent = fmt(msg.totalMs);
  $('win-streak').textContent = String(msg.streakBest);
  $('win-hints').textContent = String(msg.hints);
  let best = Number(localStorage.getItem('sp_best_ms') || 0);
  const bestEl = $('win-best');
  if (!best || msg.totalMs < best) {
    localStorage.setItem('sp_best_ms', String(msg.totalMs));
    bestEl.textContent = '★ NEW LOCAL BEST — ' + fmt(msg.totalMs);
    bestEl.classList.add('new');
  } else {
    bestEl.textContent = 'BEST TEAM TIME — ' + fmt(best);
    bestEl.classList.remove('new');
  }
  overlayWin.classList.remove('hidden');
}
$('again-btn').addEventListener('click', () => {
  ensureAudio();
  send({ t: 'again' });
  showQueue('again');
});

/* ---------- toasts ---------- */
function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 2700);
}

/* ---------- particles ---------- */
const PART_COLORS = [COLORS.blue, COLORS.red, COLORS.amber, '#e9f0ff', COLORS.cyan];
function spawnFireworks(big) {
  const target = G.lvl ? G.lvl.target : null;
  let cx = W / 2, cy = H / 2;
  if (target) {
    let sx = 0, sy = 0, n = 0;
    for (const poly of target) for (const [x, y] of poly) { sx += x; sy += y; n++; }
    if (n) { cx = sx / n; cy = sy / n; }
  }
  const count = big ? 170 : 110;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 90 + Math.random() * 340;
    G.particles.push({
      x: cx + (Math.random() - 0.5) * 260,
      y: cy + (Math.random() - 0.5) * 180,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 130,
      life: 0.8 + Math.random() * 0.9,
      age: 0,
      size: 2 + Math.random() * 2.4,
      c: PART_COLORS[(Math.random() * PART_COLORS.length) | 0],
    });
  }
}

/* ---------- input ---------- */
let activePointer = null;
let lastPtrSend = 0;
let lastPtrSent = { x: -1, y: -1 };

function pieceAt(wx, wy) {
  let best = null, bestD = 1e9;
  for (const p of G.pieces) {
    const d = Math.hypot(wx - p.rx, wy - p.ry);
    const hit = p.size * 1.45 + 16;
    if (d < hit && d < bestD) { best = p; bestD = d; }
  }
  return best;
}

canvas.addEventListener('pointerdown', (e) => {
  ensureAudio();
  if (G.phase !== 'play' || G.role === null) return;
  const w = toWorld(e.clientX, e.clientY);
  G.local.x = w.x; G.local.y = w.y; G.seenLocal = true;
  canvas.setPointerCapture(e.pointerId);

  const down = {
    pid: e.pointerId, sx: e.clientX, sy: e.clientY,
    t0: now(), moved: false, target: null,
  };

  if (G.role === 'p1') {
    const p = pieceAt(w.x, w.y);
    if (p && !p.locked) down.target = p.id;
  } else if (G.role === 'p2') {
    const nearLamp = Math.hypot(w.x - LAMP.x, w.y - G.lamp.ry) < 52;
    if ((w.x < 160 && w.y > 40 && w.y < H - 20) || nearLamp) down.target = 'lamp';
  }
  activePointer = down;
  e.preventDefault();
});

canvas.addEventListener('pointermove', (e) => {
  const w = toWorld(e.clientX, e.clientY);
  G.local.x = w.x; G.local.y = w.y; G.seenLocal = true;

  // cursor relay ~30Hz
  const t = now();
  if (t - lastPtrSend > 33 && (w.x !== lastPtrSent.x || w.y !== lastPtrSent.y)) {
    lastPtrSend = t;
    lastPtrSent = { x: w.x, y: w.y };
    send({ t: 'ptr', x: w.x, y: w.y });
  }

  if (G.phase !== 'play') return;

  if (activePointer && activePointer.pid === e.pointerId && activePointer.target) {
    if (Math.hypot(e.clientX - activePointer.sx, e.clientY - activePointer.sy) / view.s > 7) {
      activePointer.moved = true;
    }
    if (activePointer.moved) {
      if (G.role === 'p1') {
        const p = G.pieces.find((q) => q.id === activePointer.target);
        if (p && !p.locked) {
          p.x = Math.round(clamp(w.x, AREA.x0 + 20, AREA.x1 - 20));
          p.y = Math.round(clamp(w.y, AREA.y0 + 20, AREA.y1 - 20));
          p.rx = w.x; p.ry = w.y; // 1:1 while dragging
          if (t - (activePointer.lastSend || 0) > 24) {
            activePointer.lastSend = t;
            send({ t: 'drag', id: p.id, x: p.x, y: p.y });
          }
        }
      } else if (G.role === 'p2') {
        G.lamp.y = Math.round(clamp(w.y, LAMP.min, LAMP.max));
        G.lamp.ry = w.y;
        if (t - (activePointer.lastSend || 0) > 24) {
          activePointer.lastSend = t;
          send({ t: 'drag', id: 'lamp', y: G.lamp.y });
        }
      }
    }
  } else if (G.role === 'p1' && !activePointer) {
    const p = pieceAt(w.x, w.y);
    G.hover = p && !p.locked ? p.id : null;
  }
  e.preventDefault();
});

function endPointer(e) {
  if (!activePointer || activePointer.pid !== e.pointerId) return;
  const a = activePointer;
  activePointer = null;
  if (DEBUG_INPUT) console.log('[endPtr]', JSON.stringify({ role: G.role, target: a.target, moved: a.moved, phase: G.phase, lamp: G.lamp.y }));
  if (G.phase !== 'play' || !a.target) return;

  if (G.role === 'p1') {
    if (!a.moved && now() - a.t0 < 420) {
      const p = G.pieces.find((q) => q.id === a.target);
      if (p && !p.locked) {
        p.rot = ((p.rot + 45) % 360 + 360) % 360;
        send({ t: 'tap', id: p.id });
        sfx.rot();
      }
    } else if (a.moved) {
      // flush the final position (last move may have been throttled)
      const p = G.pieces.find((q) => q.id === a.target);
      if (p && !p.locked) send({ t: 'drag', id: p.id, x: p.x, y: p.y });
    }
    send({ t: 'up', id: a.target });
  } else if (G.role === 'p2') {
    if (a.moved) send({ t: 'drag', id: 'lamp', y: G.lamp.y });
    send({ t: 'up', id: 'lamp' });
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', (e) => { if (!e.buttons) endPointer(e); });
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) send({ t: 'wake' });
});

/* ---------- drawing helpers ---------- */
function tracePoly(pts, close) {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i];
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  if (close !== false) ctx.closePath();
}
function pieceWorldPts(p, x, y, rot) {
  const unit = shapePoly(p.shape);
  const r = (rot * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return unit.map(([ux, uy]) => {
    const px = ux * p.size, py = uy * p.size;
    return [x + px * c - py * s, y + px * s + py * c];
  });
}
function shadowGlow(p, lvl) {
  if (!G.lvl) return false;
  const tgt = G.lvl.target[G.pieces.indexOf(p)];
  if (!tgt) return false;
  const cur = pieceWorldPts(p, p.rx, p.ry, p.rrot).map(([x, y]) => project(x, y, G.lamp.ry));
  const limit = lvl.tol * 0.8;
  for (let i = 0; i < cur.length; i++) {
    const dx = cur[i][0] - tgt[i][0], dy = cur[i][1] - tgt[i][1];
    if (dx * dx + dy * dy > limit * limit) return false;
  }
  return true;
}

/* ---------- render ---------- */
let lastFrame = now();
function frame() {
  const t = now();
  const dt = Math.min(0.05, (t - lastFrame) / 1000);
  lastFrame = t;

  if (G.phase === 'role' && t >= G.roleUntil) {
    overlayRole.classList.add('hidden');
    G.phase = 'play';
  }

  update(dt, t);
  draw(t);
  requestAnimationFrame(frame);
}

function update(dt, t) {
  // render interpolation toward authoritative state
  const k = 1 - Math.pow(0.0001, dt); // fast, framerate independent
  for (const p of G.pieces) {
    if (G.dragging === p.id || (activePointer && activePointer.target === p.id && activePointer.moved)) {
      // local drag is already 1:1
    } else {
      p.rx = lerp(p.rx, p.x, Math.min(1, k * 1.6));
      p.ry = lerp(p.ry, p.y, Math.min(1, k * 1.6));
    }
    p.rrot = angLerp(p.rrot, p.rot, Math.min(1, k * 1.4));
  }
  G.lamp.ry = (activePointer && activePointer.target === 'lamp' && activePointer.moved)
    ? G.lamp.y
    : lerp(G.lamp.ry, G.lamp.y, Math.min(1, k * 1.5));
  G.remote.rx = lerp(G.remote.rx, G.remote.x, Math.min(1, k * 1.3));
  G.remote.ry = lerp(G.remote.ry, G.remote.y, Math.min(1, k * 1.3));

  // particles
  for (let i = G.particles.length - 1; i >= 0; i--) {
    const q = G.particles[i];
    q.age += dt;
    if (q.age >= q.life) { G.particles.splice(i, 1); continue; }
    q.vy += 340 * dt;
    q.vx *= 1 - 1.4 * dt;
    q.x += q.vx * dt;
    q.y += q.vy * dt;
  }
  G.screenPulse = Math.max(0, G.screenPulse - dt * 2.2);

  // timer hud
  if (G.phase === 'play' || G.phase === 'role' || G.phase === 'clear') {
    let rem = Math.max(0, G.remAnchor.rem - (t - G.remAnchor.at));
    const shown = Math.min(rem, G.lvlMs);
    const f = clamp(shown / G.lvlMs, 0, 1);
    timerFill.style.width = (f * 100).toFixed(1) + '%';
    const warn = rem <= 10000 && G.phase !== 'clear';
    timerFill.classList.toggle('warn', warn);
    timerNum.classList.toggle('warn', warn);
    const s = Math.ceil(rem / 1000);
    timerNum.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
}

function draw(t) {
  const { cw, ch, s, ox, oy, dpr } = view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, cw, ch);

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();

  const hasLvl = !!G.lvl && (G.phase === 'play' || G.phase === 'role' || G.phase === 'clear' || G.phase === 'win');
  if (hasLvl) {
    drawWallGlow();
    drawCone(t);
    drawRays();
    drawTarget(t);
    drawShadows(t);
    if (G.phase === 'clear' || G.phase === 'win') drawInkFill(t);
    drawPieces(t);
    drawLamp(t);
    drawBanner(t);
    if (G.phase === 'play' || G.phase === 'role') drawCursors();
    drawParticles();
    if (G.phase === 'clear') drawClearText(t);
    drawScreenPulse();
  }
  ctx.restore();

  if (hasLvl && (G.phase === 'play' || G.phase === 'role' || G.phase === 'clear')) {
    drawMinimap();
  }
}

function drawWallGlow() {
  // warm pool of light on the wall, follows lamp
  const ly = G.lamp.ry;
  const g = ctx.createRadialGradient(W * 0.52, ly, 60, W * 0.52, ly, 760);
  g.addColorStop(0, 'rgba(255,180,84,0.055)');
  g.addColorStop(1, 'rgba(255,180,84,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // vignette
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.36, W / 2, H / 2, H * 0.95);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

function drawCone(t) {
  const ly = G.lamp.ry;
  const { sx } = scaleAt(ly);
  const spread = clamp(230 * (sx / LAMP.sMin), 200, 560);
  const stretch = 1 + 0.05 * Math.sin(t / 300);
  const grad = ctx.createLinearGradient(LAMP.x, 0, W, 0);
  grad.addColorStop(0, 'rgba(255,180,84,0.16)');
  grad.addColorStop(0.45, 'rgba(255,180,84,0.07)');
  grad.addColorStop(1, 'rgba(255,180,84,0.015)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(LAMP.x + 8, ly);
  ctx.lineTo(W + 20, ly - spread * stretch);
  ctx.lineTo(W + 20, ly + spread * stretch);
  ctx.closePath();
  ctx.fill();
}

function drawRays() {
  const ly = G.lamp.ry;
  ctx.strokeStyle = 'rgba(255,180,84,0.10)';
  ctx.lineWidth = 1.4;
  for (const p of G.pieces) {
    ctx.beginPath();
    ctx.moveTo(LAMP.x, ly);
    const [rx, ry] = project(p.rx, p.ry, ly);
    ctx.lineTo(rx, ry);
    ctx.stroke();
  }
}

function drawTarget(t) {
  if (!G.lvl) return;
  const hintAge = t - G.hintT0;
  const hinting = hintAge >= 0 && hintAge < 1100;
  const hintK = hinting ? Math.sin((hintAge / 1100) * Math.PI) : 0;

  ctx.save();
  ctx.setLineDash([9, 8]);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2 + hintK * 2.5;
  ctx.strokeStyle = hinting
    ? `rgba(233,244,255,${0.55 + 0.45 * hintK})`
    : 'rgba(233,240,255,0.40)';
  if (hinting) {
    ctx.shadowColor = COLORS.cyan;
    ctx.shadowBlur = 22 * hintK;
  }
  for (const poly of G.lvl.target) {
    tracePoly(poly);
    ctx.stroke();
  }
  ctx.restore();
}

function drawShadows(t) {
  if (!G.lvl) return;
  const pulse = 0.6 + 0.4 * Math.sin(t / 260);
  for (let i = 0; i < G.pieces.length; i++) {
    const p = G.pieces[i];
    const pts = pieceWorldPts(p, p.rx, p.ry, p.rrot).map(([x, y]) => project(x, y, G.lamp.ry));
    ctx.save();
    tracePoly(pts);
    ctx.fillStyle = 'rgba(3,4,7,0.94)';
    ctx.fill();
    if (shadowGlow(p, G.lvl)) {
      ctx.setLineDash([]);
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = `rgba(125,232,255,${0.45 + 0.5 * pulse})`;
      ctx.shadowColor = COLORS.cyan;
      ctx.shadowBlur = 16;
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawInkFill(t) {
  const age = t - G.clearT0;
  if (age < 0 || !G.lvl) return;
  const a = clamp(age / 650, 0, 1);
  ctx.save();
  ctx.fillStyle = `rgba(3,4,7,${0.96 * a})`;
  for (const poly of G.lvl.target) {
    tracePoly(poly);
    ctx.fill();
  }
  ctx.setLineDash([9, 8]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = `rgba(255,180,84,${0.65 * (1 - clamp((age - 900) / 700, 0, 1)) + 0.1})`;
  for (const poly of G.lvl.target) {
    tracePoly(poly);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPieces(t) {
  for (const p of G.pieces) {
    const pts = pieceWorldPts(p, p.rx, p.ry, p.rrot);
    const flash0 = G.lockFlash[p.id];
    const flashAge = flash0 != null ? t - flash0 : 1e9;
    const flashing = flashAge >= 0 && flashAge < 620;

    let stroke = p.locked ? 'rgba(125,232,255,0.85)' : 'rgba(79,157,255,0.62)';
    let lw = 2.6;
    let glow = p.locked ? 10 : 0;
    if (G.hover === p.id && !p.locked) {
      stroke = 'rgba(120,180,255,1)';
      glow = 16;
      lw = 3;
    }
    if (flashing) {
      const k = Math.sin(flashAge / 80 * Math.PI);
      stroke = (Math.floor(flashAge / 90) % 2 === 0) ? COLORS.blue : COLORS.red;
      glow = 24 * k;
      lw = 3.4;
    }

    ctx.save();
    const scalePulse = flashing ? 1 + 0.05 * Math.sin((flashAge / 620) * Math.PI) : 1;
    if (scalePulse !== 1) {
      ctx.translate(p.rx, p.ry);
      ctx.scale(scalePulse, scalePulse);
      ctx.translate(-p.rx, -p.ry);
    }
    tracePoly(pts);
    ctx.fillStyle = p.locked ? 'rgba(20,24,30,0.96)' : 'rgba(23,26,33,0.96)';
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.lineWidth = lw;
    ctx.strokeStyle = stroke;
    if (glow > 0) { ctx.shadowColor = flashing ? stroke : (p.locked ? COLORS.cyan : COLORS.blue); ctx.shadowBlur = glow; }
    ctx.stroke();
    if (p.locked) {
      ctx.shadowBlur = 0;
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(125,232,255,0.9)';
      ctx.beginPath();
      ctx.arc(p.rx, p.ry - p.size - 12, 4.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawLamp(t) {
  const ly = G.lamp.ry;
  ctx.save();

  // rail
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(34, LAMP.min - 46);
  ctx.lineTo(34, LAMP.max + 46);
  ctx.stroke();

  // bracket
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(34, ly);
  ctx.lineTo(LAMP.x - 12, ly);
  ctx.stroke();

  // glow orb
  const g = ctx.createRadialGradient(LAMP.x + 6, ly, 2, LAMP.x + 6, ly, 64);
  g.addColorStop(0, 'rgba(255,210,140,0.95)');
  g.addColorStop(0.25, 'rgba(255,180,84,0.5)');
  g.addColorStop(1, 'rgba(255,180,84,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(LAMP.x + 6, ly, 64, 0, Math.PI * 2);
  ctx.fill();

  // housing
  ctx.beginPath();
  ctx.moveTo(LAMP.x - 14, ly - 15);
  ctx.lineTo(LAMP.x + 10, ly - 10);
  ctx.lineTo(LAMP.x + 10, ly + 10);
  ctx.lineTo(LAMP.x - 14, ly + 15);
  ctx.closePath();
  ctx.fillStyle = '#23262e';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,180,84,0.7)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // bulb
  ctx.beginPath();
  ctx.arc(LAMP.x + 10, ly, 5.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffe6bd';
  ctx.fill();

  // control ring — red when grabbable, cyan when locked
  const pulse = 0.6 + 0.4 * Math.sin(t / 300);
  ctx.beginPath();
  ctx.arc(LAMP.x, ly, 26, 0, Math.PI * 2);
  if (G.lamp.locked) {
    ctx.setLineDash([]);
    ctx.strokeStyle = `rgba(125,232,255,${0.55 + 0.3 * pulse})`;
    ctx.lineWidth = 2.4;
    ctx.shadowColor = COLORS.cyan;
    ctx.shadowBlur = 12;
  } else {
    ctx.setLineDash([6, 6]);
    ctx.lineDashOffset = -t / 40;
    ctx.strokeStyle = `rgba(255,95,95,${0.45 + 0.35 * pulse})`;
    ctx.lineWidth = 2.6;
    ctx.shadowColor = COLORS.red;
    ctx.shadowBlur = 10;
  }
  ctx.stroke();
  ctx.restore();
}

function drawBanner(t) {
  const age = t - G.bannerT0;
  if (age < 0 || age > 1100) return;
  const a = age < 200 ? age / 200 : age > 850 ? 1 - (age - 850) / 250 : 1;
  ctx.save();
  ctx.globalAlpha = clamp(a, 0, 1);
  ctx.font = '800 44px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,180,84,0.92)';
  ctx.shadowColor = 'rgba(255,180,84,0.6)';
  ctx.shadowBlur = 26;
  const txt = 'SHADOW ' + G.levelIdx + ' / 6';
  const sp = 10;
  let tw = 0;
  for (const ch2 of txt) tw += ctx.measureText(ch2).width + sp;
  let x = W / 2 - tw / 2;
  for (const ch2 of txt) {
    const w2 = ctx.measureText(ch2).width;
    ctx.fillText(ch2, x + w2 / 2, 150);
    x += w2 + sp;
  }
  ctx.restore();
}

function drawCursors() {
  // remote first
  if (G.remote.seen) {
    const col = G.remote.role === 'p1' ? COLORS.blue : COLORS.red;
    drawCursor(G.remote.rx, G.remote.ry, col, false, G.remote.role);
  }
  if (G.seenLocal) {
    const col = G.role === 'p1' ? COLORS.blue : COLORS.red;
    drawCursor(G.local.x, G.local.y, col, true, G.role);
  }
}

function drawCursor(x, y, col, isLocal, role) {
  const active = isLocal
    ? !!(activePointer && activePointer.target)
    : false;
  ctx.save();
  ctx.shadowColor = col;
  ctx.shadowBlur = active ? 22 : 12;
  ctx.beginPath();
  ctx.arc(x, y, active ? 9 : 7, 0, Math.PI * 2);
  ctx.fillStyle = col;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(x, y, active ? 22 : 15, 0, Math.PI * 2);
  ctx.strokeStyle = col;
  ctx.globalAlpha = active ? 0.95 : 0.55;
  ctx.lineWidth = 2.2;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // role glyph: piece for blue, lamp spark for red
  ctx.strokeStyle = 'rgba(10,12,16,0.9)';
  ctx.lineWidth = 2;
  if (role === 'p1') {
    ctx.beginPath();
    ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 1, y - 4);
    ctx.lineTo(x + 1, y + 1); ctx.lineTo(x + 5, y + 1);
    ctx.lineTo(x + 5, y + 5); ctx.lineTo(x - 4, y + 5);
    ctx.closePath();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(x, y, 3.4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 5, y); ctx.lineTo(x + 9, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawParticles() {
  for (const q of G.particles) {
    const a = 1 - q.age / q.life;
    ctx.globalAlpha = clamp(a, 0, 1);
    ctx.fillStyle = q.c;
    ctx.fillRect(q.x, q.y, q.size, q.size);
  }
  ctx.globalAlpha = 1;
}

function drawClearText(t) {
  const age = t - G.clearT0;
  if (age < 120 || age > 1650) return;
  const inK = clamp((age - 120) / 260, 0, 1);
  const outK = clamp((age - 1300) / 350, 0, 1);
  const a = inK * (1 - outK);
  const scale = 0.8 + 0.2 * (1 - Math.pow(1 - inK, 3));
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(W / 2, H / 2 - 40);
  ctx.scale(scale, scale);
  ctx.textAlign = 'center';
  ctx.font = '900 84px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = '#f2f6ff';
  ctx.shadowColor = COLORS.cyan;
  ctx.shadowBlur = 34;
  const txt = 'NICE SYNC!';
  const sp = 6;
  let tw = 0;
  for (const ch2 of txt) tw += ctx.measureText(ch2).width + sp;
  let x = -tw / 2;
  for (const ch2 of txt) {
    const w2 = ctx.measureText(ch2).width;
    ctx.fillText(ch2, x + w2 / 2, 0);
    x += w2 + sp;
  }
  ctx.shadowBlur = 0;
  ctx.font = '700 22px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,180,84,0.95)';
  ctx.fillText(G.clearIdx >= 6 ? 'ALL SIX SHADOWS ALIGNED' : 'SHADOW ' + G.clearIdx + ' LOCKED', 0, 52);
  ctx.restore();
}

function drawScreenPulse() {
  const age = t0ClearAge();
  if (age >= 0 && age < 600) {
    const a = (1 - age / 600) * 0.07;
    ctx.fillStyle = `rgba(255,180,84,${a})`;
    ctx.fillRect(0, 0, W, H);
  }
}
function t0ClearAge() {
  if (G.clearT0 < -1e8) return -1;
  // clearT0 uses performance.now too
  return now() - G.clearT0;
}

function drawMinimap() {
  const { cw, ch, dpr } = view;
  const mw = Math.min(220, cw * 0.32);
  const mh = mw * (H / W);
  const pad = 14;
  const mx = cw - mw - pad;
  const my = ch - mh - pad - (window.visualViewport ? 0 : 0);
  const k = mw / W;

  ctx.save();
  ctx.fillStyle = 'rgba(9,10,13,0.82)';
  ctx.strokeStyle = 'rgba(255,180,84,0.30)';
  ctx.lineWidth = 1;
  roundRect(ctx, mx, my, mw, mh, 10);
  ctx.fill();
  ctx.stroke();
  ctx.clip();

  // target ghost
  if (G.lvl) {
    ctx.strokeStyle = 'rgba(255,255,255,0.20)';
    ctx.lineWidth = 1;
    for (const poly of G.lvl.target) {
      ctx.beginPath();
      poly.forEach(([x, y], i) => {
        const px = mx + x * k, py = my + y * k;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.stroke();
    }
  }
  // lamp tick
  const ly = G.lamp.ry * k;
  ctx.strokeStyle = COLORS.amber;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(mx + 3, my + ly - 5);
  ctx.lineTo(mx + 3, my + ly + 5);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,180,84,0.5)';
  ctx.beginPath();
  ctx.arc(mx + LAMP.x * k, my + ly, 3, 0, Math.PI * 2);
  ctx.fill();

  // pieces
  for (const p of G.pieces) {
    ctx.fillStyle = p.locked ? COLORS.cyan : COLORS.blue;
    ctx.globalAlpha = p.locked ? 0.95 : 0.75;
    ctx.beginPath();
    ctx.arc(mx + p.rx * k, my + p.ry * k, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // cursors
  const dot = (x, y, col) => {
    ctx.shadowColor = col;
    ctx.shadowBlur = 6;
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(mx + x * k, my + y * k, 4.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
  };
  if (G.remote.seen) dot(G.remote.rx, G.remote.ry, G.remote.role === 'p1' ? COLORS.blue : COLORS.red);
  if (G.seenLocal) dot(G.local.x, G.local.y, G.role === 'p1' ? COLORS.blue : COLORS.red);
  ctx.restore();
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/* ---------- boot ---------- */
showQueue(null);
connect();
requestAnimationFrame(frame);
