import { getMap } from '/shared/map.js';
import { findPath, tilesInRadius } from '/shared/geom.js';
import { DEFAULT_CONFIG } from '/shared/config.js';
import {
  applyBuy, pickGear, inSetupZone, checkOrder, moveAllowance, weaponOf, isWounded, defaultOrder,
} from '/shared/engine.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const S = {
  ws: null,
  session: null, // { code, token, seat }
  lobby: null,
  view: null,
  map: getMap('dust'),
  sel: null, // selected unit id
  mode: null, // 'run' | 'walk' | 'throw:<kind>' | null
  draft: null,
  draftKey: null,
  resKey: null,
  logRound: null,
  logHtml: [],
  replay: null, // { res, i, t, playing }
  hover: null,
  ts: 24,
};

const SIDE_NAME = { T: 'Terrorists', CT: 'Counter-Terrorists' };
const REASON = { elimination: 'Enemy eliminated', bomb: 'Bomb detonated', defuse: 'Bomb defused', time: 'Time ran out' };
const unitLabel = (id) => id; // T1, CT3 …

// ---------------- networking ----------------

function connect(onOpen) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = onOpen;
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = (e) => {
    if (e.code === 4000) return toast('Opened in another tab');
    setTimeout(() => {
      if (S.session) connect(() => send({ t: 'join', code: S.session.code, token: S.session.token }));
    }, 1500);
  };
}
const send = (m) => S.ws && S.ws.readyState === 1 && S.ws.send(JSON.stringify(m));

function onMessage(m) {
  if (m.t === 'joined') {
    S.session = { code: m.code, token: m.token, seat: m.seat };
    localStorage.setItem(`breach:${m.code}`, m.token);
    history.replaceState(null, '', `?room=${m.code}`);
  } else if (m.t === 'lobby') {
    S.lobby = m;
    if (!m.inMatch) S.view = null;
    renderLobby();
  } else if (m.t === 'state') {
    onState(m.view);
  } else if (m.t === 'error') {
    toast(m.msg);
    $('#lobby-error').textContent = m.msg;
  }
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// ---------------- lobby ----------------

$('#name').value = localStorage.getItem('breach:name') || '';
const myName = () => {
  const n = $('#name').value.trim() || 'Player';
  localStorage.setItem('breach:name', n);
  return n;
};
$('#btn-create').onclick = () => connect(() => send({ t: 'create', name: myName() }));
$('#btn-join').onclick = () => {
  const code = $('#join-code').value.trim().toUpperCase();
  connect(() => send({ t: 'join', code, name: myName(), token: localStorage.getItem(`breach:${code}`) }));
};
$('#btn-copy').onclick = () => {
  navigator.clipboard?.writeText($('#room-link').value);
  toast('Link copied');
};
$('#btn-start').onclick = () => send({ t: 'start', hostSide: $('#host-side').value });
$('#btn-levers').onclick = () => openLevers();
$('#btn-levers-guest').onclick = (e) => {
  e.preventDefault();
  openLevers();
};

const params = new URLSearchParams(location.search);
if (params.get('room')) {
  const code = params.get('room').toUpperCase();
  $('#join-code').value = code;
  const token = localStorage.getItem(`breach:${code}`);
  if (token) connect(() => send({ t: 'join', code, token }));
}

function renderLobby() {
  const L = S.lobby;
  const inGame = L.inMatch && S.view;
  $('#lobby').hidden = !!inGame;
  $('#game').hidden = !inGame;
  if (inGame) return renderAll();
  $('#lobby-entry').hidden = true;
  $('#lobby-room').hidden = false;
  $('#room-code').textContent = L.code;
  $('#room-link').value = `${location.origin}/?room=${L.code}`;
  $('#players').innerHTML = L.players
    .map((p, i) => `<li>${p ? `<span class="dot ${p.connected ? 'on' : ''}"></span>${esc(p.name)}${i === L.host ? ' <span class="muted">(host)</span>' : ''}${i === L.seat ? ' <span class="muted">— you</span>' : ''}` : '<span class="muted">Waiting for opponent… share the link</span>'}</li>`)
    .join('');
  const host = L.host === L.seat;
  $('#host-controls').hidden = !host;
  $('#guest-note').hidden = host;
  $('#btn-start').disabled = !(L.players[0] && L.players[1]);
}

// ---------------- levers ----------------

function openLevers() {
  const L = S.lobby;
  const host = L.host === L.seat;
  const cfg = S.view?.pendingCfg || L.config;
  $('#levers-text').value = JSON.stringify(cfg, null, 2);
  $('#levers-text').readOnly = !host;
  $('#levers-apply').hidden = !host;
  $('#levers-reset').hidden = !host;
  $('#levers-error').textContent = '';
  $('#levers-note').textContent = L.inMatch
    ? host
      ? 'Changes apply from the next round (teamSize only changes at match start).'
      : 'Read only — the host controls the levers.'
    : host
      ? 'Every number in the game. Edit the JSON and apply.'
      : 'Read only — the host controls the levers.';
  $('#levers-dialog').showModal();
}
$('#levers-apply').onclick = () => {
  try {
    const cfg = JSON.parse($('#levers-text').value);
    send({ t: 'config', config: cfg });
    $('#levers-dialog').close();
    toast(S.lobby.inMatch ? 'Levers saved — they apply next round' : 'Levers saved');
  } catch (e) {
    $('#levers-error').textContent = e.message;
  }
};
$('#levers-reset').onclick = () => ($('#levers-text').value = JSON.stringify(DEFAULT_CONFIG, null, 2));

// ---------------- state handling ----------------

function onState(view) {
  S.view = view;
  const key = `${view.phase}:${view.round}:${view.turn}`;
  if (key !== S.draftKey) {
    S.draftKey = key;
    resetDraft();
  }
  const res = view.lastResolution;
  const rk = res ? `${view.round}:${res.turn}` : null;
  if (rk && rk !== S.resKey) {
    S.resKey = rk;
    startReplay(res);
    renderLog(res);
  } else if (!rk && S.resKey) {
    S.resKey = null;
    S.replay = null;
    renderLog(null);
  }
  renderLobby();
}

function resetDraft() {
  const v = S.view;
  S.mode = null;
  const mine = v.units;
  const firstAlive = mine.find((u) => u.alive);
  S.sel = firstAlive?.id ?? null;
  if (v.phase === 'setup') {
    S.draft = { units: {}, carrier: v.side === 'T' ? mine[0].id : undefined };
    for (const u of mine) S.draft.units[u.id] = { buy: [], x: null, y: null, hidden: true };
    if (v.mine) S.draft = structuredClone(v.mine);
  } else if (v.phase === 'planning') {
    S.draft = { orders: {} };
    if (v.mine && typeof v.mine === 'object') S.draft.orders = structuredClone(v.mine);
  } else S.draft = null;
}

// ---------------- setup helpers ----------------

function setupPreview() {
  const v = S.view;
  const cfg = v.cfg;
  let cost = 0;
  const gear = {};
  const errors = {};
  for (const u of v.units) {
    const g = pickGear(u);
    for (const it of S.draft.units[u.id].buy) {
      try {
        cost += applyBuy(cfg, v.side, g, it);
      } catch (e) {
        errors[u.id] = e.message;
      }
    }
    gear[u.id] = g;
  }
  return { cost, gear, errors, left: v.money - cost };
}

function canBuy(itemId, unitId, preview) {
  const v = S.view;
  const item = v.cfg.items[itemId];
  if (item.sides && !item.sides.includes(v.side)) return false;
  const g = structuredClone(preview.gear[unitId]);
  try {
    const c = applyBuy(v.cfg, v.side, g, itemId);
    return c <= preview.left;
  } catch {
    return false;
  }
}

function priceFor(itemId, gear) {
  const it = S.view.cfg.items[itemId];
  return it.type === 'helmet' && gear.armor ? it.priceIfArmored : it.price;
}

// ---------------- planning helpers ----------------

const unitById = (id) => S.view.units.find((u) => u.id === id);
const orderOf = (id) => S.draft?.orders?.[id] || defaultOrder(S.map, unitById(id));

function plannedPath(u, o) {
  if (!o || (o.action !== 'run' && o.action !== 'walk')) return null;
  const p = findPath(S.map, u, o.to) || [];
  const allow = moveAllowance(S.view.cfg, u, o.action);
  return { full: p, used: p.slice(0, allow) };
}

function setOrder(id, o) {
  const u = unitById(id);
  const prev = orderOf(id);
  if (prev.stopOnContact !== undefined && o.stopOnContact === undefined) o.stopOnContact = prev.stopOnContact;
  const err = checkOrder(S.view.cfg, S.map, u, o, S.view.bomb);
  if (err) return toast(err);
  S.draft.orders[id] = o;
  renderAll();
}

// ---------------- input ----------------

const canvas = $('#board');
const ctx = canvas.getContext('2d');

function tileAt(e) {
  const r = canvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - r.left) / r.width) * S.map.w);
  const y = Math.floor(((e.clientY - r.top) / r.height) * S.map.h);
  return x >= 0 && y >= 0 && x < S.map.w && y < S.map.h ? { x, y } : null;
}

canvas.addEventListener('mousemove', (e) => {
  S.hover = tileAt(e);
});
canvas.addEventListener('mouseleave', () => (S.hover = null));
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  S.mode = null;
  renderAll();
});

canvas.addEventListener('click', (e) => {
  const v = S.view;
  const t = tileAt(e);
  if (!v || !t || S.replay?.playing) return;
  const locked = !!v.mine;

  if (v.phase === 'setup') {
    if (locked) return;
    const d = S.draft.units;
    const onTile = v.units.find((u) => d[u.id].x === t.x && d[u.id].y === t.y);
    if (onTile && onTile.id !== S.sel) {
      S.sel = onTile.id;
      return renderAll();
    }
    if (!S.sel) return;
    if (!inSetupZone(v.cfg, S.map, v.side, t.x, t.y)) return toast('Place units inside your highlighted setup zone');
    d[S.sel].x = t.x;
    d[S.sel].y = t.y;
    // auto-advance to next unplaced unit
    const next = v.units.find((u) => d[u.id].x == null);
    if (next) S.sel = next.id;
    return renderAll();
  }

  if (v.phase === 'planning') {
    const own = v.units.find((u) => u.alive && u.x === t.x && u.y === t.y);
    if (!S.mode && own && own.id !== S.sel) {
      S.sel = own.id;
      return renderAll();
    }
    if (locked || !S.sel) return;
    const u = unitById(S.sel);
    if (S.mode?.startsWith('throw:')) {
      setOrder(u.id, { action: 'throw', util: S.mode.slice(6), target: t });
      S.mode = null;
      return renderAll();
    }
    if (t.x === u.x && t.y === u.y) return;
    const action = S.mode || (e.shiftKey ? 'walk' : 'run');
    setOrder(u.id, { action, to: t });
    S.mode = null;
    renderAll();
  }
});

document.addEventListener('keydown', (e) => {
  const v = S.view;
  if (!v || e.target.matches('input, textarea')) return;
  if (/^[1-9]$/.test(e.key)) {
    const u = v.units[Number(e.key) - 1];
    if (u && (u.alive || v.phase === 'setup')) {
      S.sel = u.id;
      renderAll();
    }
    return;
  }
  if (v.phase !== 'planning' || v.mine || !S.sel) return;
  const map = { r: 'run', w: 'walk', h: 'hold', c: 'hide', p: 'plant', d: 'defuse' };
  const a = map[e.key.toLowerCase()];
  if (!a) {
    if (e.key === 'Escape') {
      S.mode = null;
      renderAll();
    }
    return;
  }
  actionClick(a);
});

function actionClick(a) {
  if (a === 'run' || a === 'walk') {
    S.mode = S.mode === a ? null : a;
    renderAll();
  } else if (a.startsWith('throw:')) {
    S.mode = S.mode === a ? null : a;
    renderAll();
  } else setOrder(S.sel, { action: a });
}

// ---------------- replay ----------------

const FRAME_MS = 650;

function startReplay(res) {
  if (!res || res.frames.length < 2) return (S.replay = null);
  S.replay = { res, i: 0, t: performance.now(), playing: true };
}

$('#replay-bar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !S.replay) return;
  const R = S.replay;
  const n = R.res.frames.length;
  if (b.dataset.r === 'prev') Object.assign(R, { i: Math.max(0, R.i - 1), playing: false, t: performance.now() - FRAME_MS });
  if (b.dataset.r === 'next') Object.assign(R, { i: Math.min(n - 1, R.i + 1), playing: false, t: performance.now() - FRAME_MS });
  if (b.dataset.r === 'play') Object.assign(R, { i: 0, playing: true, t: performance.now() });
  if (b.dataset.r === 'skip') Object.assign(R, { i: n - 1, playing: false, t: performance.now() - FRAME_MS });
  renderAll();
});

function tickReplay(now) {
  const R = S.replay;
  if (!R || !R.playing) return;
  if (now - R.t >= FRAME_MS) {
    if (R.i < R.res.frames.length - 1) {
      R.i++;
      R.t = now;
      renderReplayBar();
    } else {
      R.playing = false;
      renderAll();
    }
  }
}

// ---------------- drawing ----------------

const COLORS = {
  wall: '#17181b',
  wallEdge: '#2a2c31',
  floor: '#4a4538',
  floor2: '#4f4a3c',
  cover: '#6e5a3a',
  siteA: '#5a3f37',
  siteB: '#3a4556',
  spawnT: '#56492f',
  spawnC: '#344456',
  T: '#e3a33b',
  CT: '#5aa0e6',
};

function resize() {
  const wrap = $('#board-wrap');
  const W = wrap.clientWidth - 16;
  const H = wrap.clientHeight - 16;
  S.ts = Math.max(10, Math.floor(Math.min(W / S.map.w, H / S.map.h)));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = S.map.w * S.ts * dpr;
  canvas.height = S.map.h * S.ts * dpr;
  canvas.style.width = `${S.map.w * S.ts}px`;
  canvas.style.height = `${S.map.h * S.ts}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);

const cx = (x) => (x + 0.5) * S.ts;

function drawTiles() {
  const M = S.map;
  const ts = S.ts;
  for (let y = 0; y < M.h; y++) {
    for (let x = 0; x < M.w; x++) {
      const c = M.at(x, y);
      let col = (x + y) % 2 ? COLORS.floor : COLORS.floor2;
      if (c === '#') col = COLORS.wall;
      else if (c === 'A' || c === 'a') col = COLORS.siteA;
      else if (c === 'B' || c === 'b') col = COLORS.siteB;
      else if (c === 'T' || c === 't') col = COLORS.spawnT;
      else if (c === 'C' || c === 'k') col = COLORS.spawnC;
      ctx.fillStyle = col;
      ctx.fillRect(x * ts, y * ts, ts, ts);
      if (c === '#') {
        // edge highlight next to floor
        ctx.fillStyle = COLORS.wallEdge;
        if (M.walkable(x, y + 1)) ctx.fillRect(x * ts, (y + 1) * ts - 3, ts, 3);
      }
      if (M.isCover(x, y)) {
        ctx.fillStyle = COLORS.cover;
        ctx.fillRect(x * ts + 3, y * ts + 3, ts - 6, ts - 6);
        ctx.strokeStyle = '#8a7350';
        ctx.lineWidth = 1;
        ctx.strokeRect(x * ts + 3.5, y * ts + 3.5, ts - 7, ts - 7);
        ctx.beginPath();
        ctx.moveTo(x * ts + 4, y * ts + 4);
        ctx.lineTo((x + 1) * ts - 4, (y + 1) * ts - 4);
        ctx.stroke();
      }
    }
  }
  // site letters
  ctx.font = `bold ${ts * 2.4}px system-ui`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillText('A', cx(28.5), cx(4.5));
  ctx.fillText('B', cx(2.5), cx(4.5));
}

function drawFog(tiles) {
  if (!tiles) return;
  const M = S.map;
  const ts = S.ts;
  ctx.fillStyle = 'rgba(5,6,8,0.62)';
  for (let y = 0; y < M.h; y++)
    for (let x = 0; x < M.w; x++) if (tiles[y * M.w + x] !== '1' && M.walkable(x, y)) ctx.fillRect(x * ts, y * ts, ts, ts);
}

function drawZone(side) {
  const M = S.map;
  const ts = S.ts;
  ctx.fillStyle = side === 'T' ? 'rgba(227,163,59,0.18)' : 'rgba(90,160,230,0.18)';
  for (let y = 0; y < M.h; y++)
    for (let x = 0; x < M.w; x++) if (inSetupZone(S.view.cfg, M, side, x, y)) ctx.fillRect(x * ts, y * ts, ts, ts);
}

function drawEffects(smokes, fires) {
  const ts = S.ts;
  for (const f of fires || []) {
    ctx.fillStyle = 'rgba(240,110,30,0.45)';
    for (const [x, y] of tilesInRadius(S.map, f.x, f.y, f.r)) ctx.fillRect(x * ts, y * ts, ts, ts);
  }
  for (const s of smokes || []) {
    for (const [x, y] of tilesInRadius(S.map, s.x, s.y, s.r)) {
      ctx.fillStyle = 'rgba(200,204,210,0.78)';
      ctx.beginPath();
      ctx.arc(cx(x), cx(y), ts * 0.72, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawDrops(drops) {
  const ts = S.ts;
  for (const d of drops || []) {
    const x = d.x * ts;
    const y = d.y * ts;
    ctx.fillStyle = d.type === 'weapon' ? '#c8c8c8' : d.type === 'kit' ? '#5bbf73' : '#a7d36b';
    if (d.type === 'weapon') ctx.fillRect(x + ts * 0.15, y + ts * 0.7, ts * 0.7, ts * 0.14);
    else {
      ctx.beginPath();
      ctx.arc(x + ts * 0.8, y + ts * 0.25, ts * 0.12, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawBomb(b, units) {
  if (!b) return;
  let x = b.x;
  let y = b.y;
  if (b.state === 'carried') {
    const c = units.find((u) => u.id === b.carrierId);
    if (!c) return;
    x = c.x;
    y = c.y;
    ctx.fillStyle = '#e5534b';
    ctx.fillRect(cx(x) + S.ts * 0.18, cx(y) - S.ts * 0.45, S.ts * 0.26, S.ts * 0.2);
    return;
  }
  if (x == null || !['dropped', 'planted', 'exploded', 'defused'].includes(b.state)) return;
  const ts = S.ts;
  ctx.fillStyle = b.state === 'defused' ? '#5bbf73' : '#e5534b';
  ctx.fillRect(x * ts + ts * 0.2, y * ts + ts * 0.3, ts * 0.6, ts * 0.4);
  ctx.fillStyle = '#111';
  ctx.font = `bold ${ts * 0.3}px system-ui`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(b.state === 'planted' ? String(b.timer ?? '') : 'C4', cx(x), cx(y));
  if (b.state === 'planted') {
    ctx.strokeStyle = 'rgba(229,83,75,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx(x), cx(y), ts * 0.6 + (Math.sin(performance.now() / 200) + 1) * 2, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawUnit(u, { enemy = false, sel = false, ghost = false } = {}) {
  const ts = S.ts;
  const X = cx(u.x);
  const Y = cx(u.y);
  const r = ts * 0.36;
  ctx.globalAlpha = ghost ? 0.35 : 1;
  if (!u.alive) {
    ctx.strokeStyle = COLORS[u.side];
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(X - r * 0.7, Y - r * 0.7);
    ctx.lineTo(X + r * 0.7, Y + r * 0.7);
    ctx.moveTo(X + r * 0.7, Y - r * 0.7);
    ctx.lineTo(X - r * 0.7, Y + r * 0.7);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }
  if (u.hidden) ctx.globalAlpha *= 0.6;
  ctx.fillStyle = COLORS[u.side];
  ctx.beginPath();
  ctx.arc(X, Y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = enemy ? 2.5 : 1.5;
  ctx.strokeStyle = enemy ? '#ff3b30' : '#111';
  if (u.hidden) ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
  if (sel) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(X, Y, r + 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#111';
  ctx.font = `bold ${ts * 0.42}px system-ui`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(u.n), X, Y + 1);
  if (u.hp != null) {
    const hpw = ts * 0.8;
    ctx.fillStyle = '#000';
    ctx.fillRect(X - hpw / 2, Y + r + 2, hpw, 3);
    ctx.fillStyle = u.hp > 50 ? '#5bbf73' : u.hp > 25 ? '#e3a33b' : '#e5534b';
    ctx.fillRect(X - hpw / 2, Y + r + 2, (hpw * Math.max(0, u.hp)) / 100, 3);
  }
  if (u.blind > 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    ctx.arc(X, Y, r * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawPings(events, filterF) {
  const ts = S.ts;
  for (const e of events) {
    if (e.k !== 'ping' || (filterF != null && e.f !== filterF)) continue;
    ctx.strokeStyle = e.kind === 'shot' ? 'rgba(255,90,80,0.85)' : e.kind === 'utility' ? 'rgba(170,220,110,0.85)' : 'rgba(170,140,230,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx(e.x), cx(e.y), ts * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = `bold ${ts * 0.45}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(e.kind === 'shot' ? '!' : e.kind === 'utility' ? '*' : '?', cx(e.x), cx(e.y));
  }
}

function drawShots(events, f) {
  for (const e of events) {
    if (e.f !== f) continue;
    if (e.k === 'shot') {
      ctx.strokeStyle = e.hit ? (e.hs ? '#ff2d20' : '#ff8a6b') : 'rgba(220,220,220,0.5)';
      ctx.lineWidth = e.hit ? 2 : 1;
      ctx.setLineDash(e.hit ? [] : [4, 4]);
      ctx.beginPath();
      ctx.moveTo(cx(e.from.x), cx(e.from.y));
      ctx.lineTo(cx(e.to.x), cx(e.to.y));
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (e.k === 'util') {
      ctx.strokeStyle = e.kind === 'flash' ? '#ffffff' : e.kind === 'he' ? '#ff6a3d' : e.kind === 'molotov' ? '#ff9a2e' : '#bfc3c9';
      ctx.lineWidth = 2;
      if (e.from) {
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(cx(e.from.x), cx(e.from.y));
        ctx.lineTo(cx(e.at.x), cx(e.at.y));
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const R = S.view.cfg.utility[e.kind]?.radius ?? 2;
      ctx.beginPath();
      ctx.arc(cx(e.at.x), cx(e.at.y), R * S.ts, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawOrders() {
  const v = S.view;
  const ts = S.ts;
  for (const u of v.units.filter((x) => x.alive)) {
    const o = orderOf(u.id);
    const sel = u.id === S.sel;
    ctx.globalAlpha = sel ? 1 : 0.6;
    if (o.action === 'run' || o.action === 'walk') {
      const p = plannedPath(u, o);
      ctx.strokeStyle = o.action === 'run' ? '#f5d76e' : '#9fe0a8';
      ctx.lineWidth = 2.5;
      ctx.setLineDash(o.action === 'walk' ? [5, 4] : []);
      ctx.beginPath();
      ctx.moveTo(cx(u.x), cx(u.y));
      for (const s of p.used) ctx.lineTo(cx(s.x), cx(s.y));
      ctx.stroke();
      ctx.setLineDash([]);
      const end = p.used[p.used.length - 1];
      if (end) {
        ctx.strokeStyle = ctx.strokeStyle;
        ctx.strokeRect(end.x * ts + 3, end.y * ts + 3, ts - 6, ts - 6);
        drawUnit({ ...u, x: end.x, y: end.y }, { ghost: true });
      }
      if (p.full.length > p.used.length) {
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(cx(end.x), cx(end.y));
        for (const s of p.full.slice(p.used.length)) ctx.lineTo(cx(s.x), cx(s.y));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else if (o.action === 'throw') {
      ctx.strokeStyle = '#c6f07a';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(cx(u.x), cx(u.y));
      ctx.lineTo(cx(o.target.x), cx(o.target.y));
      ctx.stroke();
      ctx.setLineDash([]);
      const R = v.cfg.utility[o.util]?.radius ?? 2;
      ctx.beginPath();
      ctx.arc(cx(o.target.x), cx(o.target.y), R * ts, 0, Math.PI * 2);
      ctx.stroke();
    }
    const explicit = !!S.draft?.orders?.[u.id];
    const badge = { hold: explicit ? 'HOLD' : null, hide: 'HIDE', plant: 'PLANT', defuse: 'DEFUSE', throw: o.util?.toUpperCase() }[o.action];
    if (badge) {
      ctx.font = `bold ${Math.max(8, ts * 0.32)}px system-ui`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#000a';
      const w = ctx.measureText(badge).width + 6;
      ctx.fillRect(cx(u.x) - w / 2, u.y * ts - ts * 0.38, w, ts * 0.38);
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(badge, cx(u.x), u.y * ts - ts * 0.19);
    }
    ctx.globalAlpha = 1;
  }
}

function drawModePreview() {
  const v = S.view;
  if (!S.hover || !S.sel || v.phase !== 'planning' || v.mine) return;
  const u = unitById(S.sel);
  if (!u?.alive) return;
  const ts = S.ts;
  if (S.mode?.startsWith('throw:')) {
    const kind = S.mode.slice(6);
    const ok = !checkOrder(v.cfg, S.map, u, { action: 'throw', util: kind, target: S.hover }, v.bomb);
    ctx.strokeStyle = ok ? '#c6f07a' : '#e5534b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx(S.hover.x), cx(S.hover.y), (v.cfg.utility[kind]?.radius ?? 2) * ts, 0, Math.PI * 2);
    ctx.stroke();
    // throw range
    ctx.strokeStyle = 'rgba(198,240,122,0.25)';
    ctx.beginPath();
    ctx.arc(cx(u.x), cx(u.y), v.cfg.utility.throwRange * ts, 0, Math.PI * 2);
    ctx.stroke();
  } else if (S.mode === 'run' || S.mode === 'walk') {
    const p = findPath(S.map, u, S.hover);
    if (p) {
      const allow = moveAllowance(v.cfg, u, S.mode);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx(u.x), cx(u.y));
      p.slice(0, allow).forEach((s) => ctx.lineTo(cx(s.x), cx(s.y)));
      ctx.stroke();
    }
  }
  // weapon range ring for selected unit
  const w = weaponOf(v.cfg, u);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx(u.x), cx(u.y), w.range * ts, 0, Math.PI * 2);
  ctx.stroke();
}

function lerpUnits(a, b, k) {
  return b.units.map((u) => {
    const p = a.units.find((x) => x.id === u.id);
    if (!p) return u;
    return { ...u, x: p.x + (u.x - p.x) * k, y: p.y + (u.y - p.y) * k };
  });
}

function draw(now) {
  tickReplay(now);
  const v = S.view;
  if (v && !$('#game').hidden) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawTiles();
    const R = S.replay;
    if (R && (R.playing || R.i < R.res.frames.length - 1)) {
      const f = R.res.frames[R.i];
      const prev = R.res.frames[Math.max(0, R.i - 1)];
      const k = R.playing ? Math.min(1, (now - R.t) / (FRAME_MS * 0.6)) : 1;
      drawEffects(f.smokes, f.fires);
      const units = lerpUnits(prev, f, k);
      drawBomb(f.bomb, units);
      for (const u of units) drawUnit(u, { enemy: u.side !== v.side });
      drawPings(R.res.events, R.i);
      drawShots(R.res.events, R.i);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(6, 6, 170, 24);
      ctx.fillStyle = '#fff';
      ctx.font = '13px system-ui';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`Turn ${R.res.turn} — ${f.label}`, 12, 18);
    } else {
      if (v.phase === 'setup' && !v.mine) drawZone(v.side);
      drawEffects(v.smokes, v.fires);
      drawDrops(v.drops);
      if (v.phase === 'planning') drawFog(v.visibleTiles);
      if (v.phase === 'planning' && R) drawPings(R.res.events, null);
      if (v.phase === 'planning') drawOrders();
      const own = v.phase === 'setup'
        ? v.units.filter((u) => S.draft?.units[u.id]?.x != null).map((u) => ({ ...u, x: S.draft.units[u.id].x, y: S.draft.units[u.id].y, hidden: S.draft.units[u.id].hidden && S.map.isCover(S.draft.units[u.id].x, S.draft.units[u.id].y), hasBomb: u.id === S.draft.carrier }))
        : v.units.filter((u) => u.x != null);
      drawBomb(v.phase === 'setup' ? null : v.bomb, own);
      for (const u of v.enemies) drawUnit(u, { enemy: true });
      for (const u of own) drawUnit(u, { sel: u.id === S.sel });
      if (v.phase === 'setup' && v.side === 'T' && S.draft) {
        const c = own.find((u) => u.id === S.draft.carrier);
        if (c) drawBomb({ state: 'carried', carrierId: c.id }, own);
      }
      drawModePreview();
    }
    if (S.hover) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(S.hover.x * S.ts + 0.5, S.hover.y * S.ts + 0.5, S.ts - 1, S.ts - 1);
    }
    updateTimer();
  }
  requestAnimationFrame(draw);
}

// ---------------- panels ----------------

function renderAll() {
  renderHud();
  renderPanel();
  renderReplayBar();
  renderOverlay();
}

function renderReplayBar() {
  const R = S.replay;
  const bar = $('#replay-bar');
  const v = S.view;
  bar.hidden = !R || !v || !['planning', 'roundEnd', 'matchEnd'].includes(v.phase);
  if (!R) return;
  $('#replay-label').textContent = `Turn ${R.res.turn}: ${R.i + 1}/${R.res.frames.length}`;
}

function itemName(id) {
  return S.view.cfg.items[id]?.name ?? id;
}

function gearSummary(g) {
  const parts = [itemName(g.primary || g.secondary)];
  if (g.primary) parts.push(itemName(g.secondary));
  if (g.helmet) parts.push('Helmet');
  else if (g.armor) parts.push('Kevlar');
  if (g.kit) parts.push('Kit');
  return parts.join(' · ');
}

function renderHud() {
  const v = S.view;
  const me = v.you;
  const opp = 1 - me;
  const myName = S.lobby?.players?.[me]?.name ?? 'You';
  const oppName = S.lobby?.players?.[opp]?.name ?? 'Opponent';
  $('#hud-score').innerHTML = `<span class="score"><span class="side-${v.sideOf[me]}">${esc(myName)} ${v.score[me]}</span> <span class="muted">:</span> <span class="side-${v.sideOf[opp]}">${v.score[opp]} ${esc(oppName)}</span></span>
    <div class="muted">First to ${v.cfg.match.roundsToWin} · Round ${v.round}</div>`;
  const phase = { setup: 'Buy & place', planning: `Turn ${v.turn} / ${v.cfg.round.maxTurns}`, roundEnd: 'Round over', matchEnd: 'Match over' }[v.phase];
  let bomb = '';
  if (v.bomb?.state === 'planted') bomb = ` · <b style="color:var(--red)">BOMB ${v.bomb.site ?? ''} — ${v.bomb.timer} turn${v.bomb.timer === 1 ? '' : 's'}</b>`;
  $('#hud-mid').innerHTML = `<div class="side-${v.side}"><b>${SIDE_NAME[v.side]}</b></div><div>${phase}${bomb} <span class="timer" id="timer"></span></div>`;
  $('#hud-right').innerHTML = `<div class="money">$${v.money.toLocaleString()}</div><div class="muted">Enemies alive: ${v.enemyAlive}</div>`;
}

function updateTimer() {
  const el = document.getElementById('timer');
  if (!el) return;
  const d = S.view?.deadline;
  if (!d) return (el.textContent = '');
  const s = Math.max(0, Math.ceil((d - Date.now()) / 1000));
  el.textContent = `· ${s}s`;
  el.classList.toggle('low', s <= 10);
}

function unitCard(u, { sub = '', extra = '' } = {}) {
  const sel = u.id === S.sel;
  return `<div class="unit-card ${sel ? 'sel' : ''} ${u.alive ? '' : 'dead'}" data-unit="${u.id}">
    <div class="top"><b class="side-${u.side}">${u.side} ${u.n}</b><span>${u.alive ? `${u.hp} HP` : 'Dead'}</span></div>
    <div class="sub">${sub}</div>
    ${u.alive ? `<div class="hpbar"><i style="width:${u.hp}%"></i></div>` : ''}${extra}</div>`;
}

function renderPanel() {
  const v = S.view;
  const P = $('#panel');
  if (v.phase === 'setup') P.innerHTML = setupPanel();
  else if (v.phase === 'planning') P.innerHTML = planningPanel();
  else P.innerHTML = summaryPanel();
}

const SHOP_GROUPS = [
  ['Pistols', (i) => i.type === 'weapon' && i.slot === 'secondary'],
  ['SMGs & Shotguns', (i) => i.type === 'weapon' && i.slot === 'primary' && i.range <= 10],
  ['Rifles & Snipers', (i) => i.type === 'weapon' && i.slot === 'primary' && i.range > 10],
  ['Gear', (i) => ['kevlar', 'helmet', 'kit'].includes(i.type)],
  ['Grenades', (i) => i.type === 'grenade'],
];

function setupPanel() {
  const v = S.view;
  const locked = !!v.mine;
  const pv = setupPreview();
  let h = `<div class="row" style="justify-content:space-between"><span>Remaining</span><span class="money" style="color:${pv.left < 0 ? 'var(--red)' : ''}">$${pv.left.toLocaleString()}</span></div>`;
  h += `<p class="muted" style="margin:0">Select a unit, buy gear, then click a highlighted tile to place it. Units placed on cover can start Hidden.</p>`;
  h += '<h3>Your squad</h3>';
  for (const u of v.units) {
    const d = S.draft.units[u.id];
    const g = pv.gear[u.id];
    const chips = d.buy.map((it, i) => `<span class="chip">${esc(itemName(it))}${locked ? '' : `<button data-unbuy="${u.id}:${i}">×</button>`}</span>`).join('');
    const util = g.utility.length ? ` · ${g.utility.join(', ')}` : '';
    const placed = d.x != null ? `(${d.x},${d.y})` : '<span style="color:var(--red)">not placed</span>';
    let extra = chips ? `<div class="chips">${chips}</div>` : '';
    if (d.x != null && S.map.isCover(d.x, d.y)) extra += `<label class="inline"><input type="checkbox" data-hidden="${u.id}" ${d.hidden ? 'checked' : ''} ${locked ? 'disabled' : ''}/> Start hidden</label>`;
    if (v.side === 'T') extra += `<label class="inline"><input type="radio" name="carrier" data-carrier="${u.id}" ${S.draft.carrier === u.id ? 'checked' : ''} ${locked ? 'disabled' : ''}/> Bomb carrier</label>`;
    if (pv.errors[u.id]) extra += `<div class="error">${esc(pv.errors[u.id])}</div>`;
    h += unitCard(u, { sub: `${esc(gearSummary(g))}${esc(util)} · ${placed}`, extra });
  }
  if (!locked && S.sel) {
    h += `<h3>Shop — ${esc(S.sel)}</h3>`;
    const items = Object.entries(v.cfg.items).filter(([, it]) => !it.sides || it.sides.includes(v.side));
    for (const [title, pred] of SHOP_GROUPS) {
      const list = items.filter(([, it]) => pred(it));
      if (!list.length) continue;
      h += `<div class="muted" style="margin:8px 0 4px;font-size:12px">${title}</div><div class="shop">`;
      for (const [id, it] of list) {
        h += `<button data-buy="${id}" ${canBuy(id, S.sel, pv) ? '' : 'disabled'} title="${esc(tooltip(it))}">${esc(it.name)} <span>$${priceFor(id, pv.gear[S.sel])}</span></button>`;
      }
      h += '</div>';
    }
  }
  h += `<div class="row"><button data-act="autoplace" ${locked ? 'disabled' : ''}>Auto-place</button><button data-act="clearbuys" ${locked ? 'disabled' : ''}>Clear buys</button></div>`;
  h += locked
    ? `<button class="lock" data-act="unlock" ${v.opponentReady ? 'disabled' : ''}>Locked in — edit</button>`
    : `<button class="lock primary" data-act="locksetup">Lock in setup</button>`;
  h += `<div class="status">${v.opponentReady ? 'Opponent is ready.' : 'Opponent is still setting up…'}</div>`;
  return h;
}

function tooltip(it) {
  if (it.type !== 'weapon') return it.name;
  return `${it.name}: ${it.damage} dmg × ${it.shots}/step, range ${it.range}, acc ${it.accuracy.join('/')}%, armor pen ${Math.round(it.armorPen * 100)}%, HS ${Math.round(it.headshot * 100)}%`;
}

function orderText(o) {
  if (!o) return 'Hold';
  switch (o.action) {
    case 'run': return `Run → (${o.to.x},${o.to.y})`;
    case 'walk': return `Walk → (${o.to.x},${o.to.y})`;
    case 'throw': return `Throw ${o.util} → (${o.target.x},${o.target.y})`;
    default: return o.action[0].toUpperCase() + o.action.slice(1);
  }
}

function planningPanel() {
  const v = S.view;
  const locked = !!v.mine;
  let h = '';
  if (v.halftime && v.turn === 1) h += '<p class="muted">Halftime — sides swapped.</p>';
  h += '<h3>Your squad</h3>';
  for (const u of v.units) {
    const util = u.utility.length ? ` · ${u.utility.join(', ')}` : '';
    const flags = [u.hidden ? 'hidden' : '', u.hasBomb ? 'C4' : '', u.alive && isWounded(v.cfg, u) ? 'wounded' : ''].filter(Boolean).join(', ');
    const sub = `${esc(gearSummary(u))}${esc(util)}${flags ? ` · <b>${flags}</b>` : ''}`;
    const extra = u.alive ? `<div class="sub">Order: <b>${esc(orderText(orderOf(u.id)))}</b></div>` : '';
    h += unitCard(u, { sub, extra });
  }
  const u = S.sel && unitById(S.sel);
  if (u?.alive && !locked) {
    const cfg = v.cfg;
    const can = (o) => !checkOrder(cfg, S.map, u, o, v.bomb);
    const o = orderOf(u.id);
    h += `<h3>Orders — ${u.side} ${u.n}</h3><div class="actions">`;
    const btn = (a, label, k, enabled = true) =>
      `<button data-action="${a}" class="${S.mode === a || (!S.mode && o.action === a) ? 'on' : ''}" ${enabled ? '' : 'disabled'}>${label} <span class="kbd">${k}</span></button>`;
    h += btn('run', `Run ${moveAllowance(cfg, u, 'run')}`, 'R');
    h += btn('walk', `Walk ${moveAllowance(cfg, u, 'walk')}`, 'W');
    h += btn('hold', 'Hold', 'H');
    h += btn('hide', 'Hide', 'C', can({ action: 'hide' }));
    if (v.side === 'T') h += btn('plant', 'Plant', 'P', can({ action: 'plant' }));
    else h += btn('defuse', 'Defuse', 'D', can({ action: 'defuse' }));
    for (const kind of [...new Set(u.utility)]) h += btn(`throw:${kind}`, `Throw ${kind}`, '');
    h += '</div>';
    const soc = o.stopOnContact ?? cfg.movement.stopOnContactDefault;
    h += `<label class="inline"><input type="checkbox" data-soc="${u.id}" ${soc ? 'checked' : ''}/> Stop moving when an enemy is in sight & range</label>`;
    if (S.mode) h += `<p class="muted">${S.mode.startsWith('throw') ? 'Click a target tile' : 'Click a destination'} (right-click / Esc to cancel)</p>`;
    else h += `<p class="muted">Click map = run there, Shift+click = walk.</p>`;
  }
  if (v.enemies.length) {
    h += '<h3>Spotted</h3>';
    for (const e of v.enemies) h += `<div class="sub">${e.side} ${e.n} at (${e.x},${e.y}) — ${esc(itemName(e.weapon))}${e.helmet ? ', helmet' : e.armor ? ', kevlar' : ''}${e.wounded ? ', <b>wounded</b>' : ''}</div>`;
  }
  h += locked
    ? `<button class="lock" data-act="unlock" ${v.opponentReady ? 'disabled' : ''}>Locked in — edit</button>`
    : `<button class="lock primary" data-act="lockorders">Lock in turn ${v.turn}</button>`;
  h += `<div class="status">${v.opponentReady ? 'Opponent has locked in.' : 'Opponent is planning…'}</div>`;
  return h;
}

function summaryPanel() {
  const v = S.view;
  let h = '<h3>Round history</h3>';
  for (const r of v.history) {
    const mine = r.winnerPlayer === v.you;
    h += `<div class="sub">R${r.round}: <b class="side-${r.winner}">${r.winner}</b> — ${REASON[r.reason]} ${mine ? '(you)' : ''}</div>`;
  }
  h += '<h3>Your squad</h3>';
  for (const u of v.units) h += unitCard(u, { sub: esc(gearSummary(u)) });
  return h;
}

function renderOverlay() {
  const v = S.view;
  const el = $('#overlay');
  const replaying = S.replay && (S.replay.playing || S.replay.i < S.replay.res.frames.length - 1);
  if (!['roundEnd', 'matchEnd'].includes(v.phase) || replaying) return (el.hidden = true);
  const r = v.roundResult;
  const won = r.winnerPlayer === v.you;
  let h = `<div class="overlay-card"><h2 class="side-${r.winner}">${SIDE_NAME[r.winner]} win</h2><div>${REASON[r.reason]}</div>`;
  h += `<p class="score">${v.score[v.you]} : ${v.score[1 - v.you]}</p>`;
  if (v.phase === 'matchEnd') {
    h += `<h2>${v.matchWinner === v.you ? 'You win the match' : 'You lose the match'}</h2>`;
    if (S.lobby.host === S.lobby.seat) h += `<div class="row end" style="justify-content:center"><button data-act="lobby" class="primary">Back to lobby</button></div>`;
  } else {
    h += `<p class="muted">You earned $${r.rewards[v.side].toLocaleString()} ${won ? '(win)' : '(loss bonus)'}</p>`;
    if (v.round === v.cfg.match.halftimeAfterRound) h += '<p><b>Halftime next — sides swap, money resets.</b></p>';
    h += v.mine
      ? `<p class="muted">Waiting for opponent…</p>`
      : `<div class="row" style="justify-content:center"><button data-act="ack" class="primary">Next round</button></div>`;
  }
  h += `<button data-r2="replay" style="margin-top:6px">Watch last turn again</button></div>`;
  el.innerHTML = h;
  el.hidden = false;
}

$('#overlay').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.act === 'ack') send({ t: 'ack' });
  if (b.dataset.act === 'lobby') send({ t: 'leaveMatch' });
  if (b.dataset.r2 === 'replay' && S.replay) {
    Object.assign(S.replay, { i: 0, playing: true, t: performance.now() });
    renderAll();
  }
});

$('#panel').addEventListener('click', (e) => {
  const v = S.view;
  const t = e.target;
  const card = t.closest('[data-unit]');
  const b = t.closest('button');
  if (b?.dataset.buy) {
    S.draft.units[S.sel].buy.push(b.dataset.buy);
    return renderAll();
  }
  if (b?.dataset.unbuy) {
    const [id, i] = b.dataset.unbuy.split(':');
    S.draft.units[id].buy.splice(Number(i), 1);
    return renderAll();
  }
  if (b?.dataset.action) return actionClick(b.dataset.action);
  if (b?.dataset.act) {
    const a = b.dataset.act;
    if (a === 'locksetup') return send({ t: 'setup', spec: S.draft });
    if (a === 'lockorders') return send({ t: 'orders', orders: S.draft.orders });
    if (a === 'unlock') return send({ t: 'unlock' });
    if (a === 'clearbuys') {
      for (const d of Object.values(S.draft.units)) d.buy = [];
      return renderAll();
    }
    if (a === 'autoplace') {
      const taken = new Set(Object.values(S.draft.units).filter((d) => d.x != null).map((d) => `${d.x},${d.y}`));
      const tiles = [];
      for (let y = 0; y < S.map.h; y++)
        for (let x = 0; x < S.map.w; x++) if (inSetupZone(v.cfg, S.map, v.side, x, y) && !taken.has(`${x},${y}`)) tiles.push({ x, y });
      for (const d of Object.values(S.draft.units)) {
        if (d.x != null) continue;
        const p = tiles.splice(Math.floor(Math.random() * tiles.length), 1)[0];
        d.x = p.x;
        d.y = p.y;
      }
      return renderAll();
    }
  }
  if (card && !t.matches('input')) {
    S.sel = card.dataset.unit;
    S.mode = null;
    renderAll();
  }
});

$('#panel').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.hidden) S.draft.units[t.dataset.hidden].hidden = t.checked;
  if (t.dataset.carrier) S.draft.carrier = t.dataset.carrier;
  if (t.dataset.soc) {
    const o = { ...orderOf(t.dataset.soc), stopOnContact: t.checked };
    S.draft.orders[t.dataset.soc] = o;
  }
  renderAll();
});

// ---------------- log ----------------

function renderLog(res) {
  const el = $('#log');
  const v = S.view;
  if (S.logRound !== v?.round) {
    S.logRound = v?.round;
    S.logHtml = [];
  }
  if (!res) {
    el.innerHTML = S.logHtml.join('') || '<div class="muted">Combat log appears here after each turn.</div>';
    return;
  }
  const lines = [`<div class="hdr">═══ Round ${v.round} · Turn ${res.turn} ═══</div>`];
  let lastF = -1;
  for (const e of res.events) {
    if (e.f !== lastF) {
      lastF = e.f;
      const label = res.frames[e.f]?.label;
      if (label) lines.push(`<div class="muted">${esc(label)}</div>`);
    }
    const line = describe(e, v);
    if (line) lines.push(line);
  }
  if (res.end) lines.push(`<div class="kill">Round over: ${res.end.winner} — ${REASON[res.end.reason]}</div>`);
  if (lines.length === 1) lines.push('<div class="muted">No contact.</div>');
  S.logHtml.push(...lines);
  el.innerHTML = S.logHtml.join('');
  el.scrollTop = el.scrollHeight;
}

function describe(e, v) {
  const cfg = v.cfg;
  switch (e.k) {
    case 'shot':
      return `<div class="${e.hit ? 'hit' : 'miss'}">${unitLabel(e.s)} ${e.hidden ? '(hidden) ' : ''}fires ${esc(itemName(e.w))} at ${unitLabel(e.t)} — d100 ${e.roll} vs ${e.need}%: ${e.hit ? `HIT ${e.dmg}${e.hs ? ' (HEADSHOT)' : ''}` : 'miss'}</div>`;
    case 'kill':
      return `<div class="kill">☠ ${unitLabel(e.u)} killed${e.by ? ` by ${unitLabel(e.by)}` : ''} (${esc(cfg.items[e.cause]?.name ?? e.cause)})</div>`;
    case 'dmg':
      return e.cause === 'he' || e.cause === 'molotov' ? `<div class="hit">${unitLabel(e.u)} takes ${e.dmg} from ${e.cause}</div>` : '';
    case 'ping':
      return `<div class="ping">Heard ${e.kind === 'steps' ? 'footsteps' : e.kind === 'shot' ? 'gunfire' : 'utility'} at (${e.x},${e.y})</div>`;
    case 'util':
      return `<div class="info">${e.by ? `${unitLabel(e.by)} throws` : 'Enemy'} ${e.kind} at (${e.at.x},${e.at.y})</div>`;
    case 'blind':
      return `<div class="info">${unitLabel(e.u)} is blinded</div>`;
    case 'stop':
      return `<div class="info">${unitLabel(e.u)} stops on contact</div>`;
    case 'pickup':
      return `<div class="info">${unitLabel(e.u)} picks up ${esc(cfg.items[e.item]?.name ?? e.item)}</div>`;
    case 'bombDrop':
      return `<div class="info">Bomb dropped at (${e.x},${e.y})</div>`;
    case 'planting':
      return `<div class="info">${unitLabel(e.u)} planting… (${e.progress}/${cfg.bomb.plantTurns})</div>`;
    case 'plant':
      return `<div class="kill">💣 Bomb planted at ${e.site} (${e.x},${e.y})</div>`;
    case 'defusing':
      return `<div class="info">Defusing… ${e.progress}/${e.need}</div>`;
    case 'defused':
      return `<div class="kill">Bomb defused</div>`;
    case 'explode':
      return `<div class="kill">💥 Bomb detonated</div>`;
  }
  return '';
}

resize();
renderLog(null);
requestAnimationFrame(draw);
new ResizeObserver(resize).observe($('#board-wrap'));
