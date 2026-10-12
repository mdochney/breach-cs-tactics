// HTTP static server + WebSocket game rooms. Holds authoritative game state in memory.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { DEFAULT_CONFIG, mergeConfig } from '../shared/config.js';
import * as E from '../shared/engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  let rel = url.pathname === '/' ? '/public/index.html' : url.pathname;
  if (!rel.startsWith('/shared/')) rel = '/public' + (rel.startsWith('/public/') ? rel.slice(7) : rel);
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(path.join(ROOT, 'public')) && !file.startsWith(path.join(ROOT, 'shared'))) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, path: '/ws' });

/** @type {Map<string, any>} */
const rooms = new Map();

const newCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do c = Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join('');
  while (rooms.has(c));
  return c;
};

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function lobbyInfo(room, seat) {
  return {
    t: 'lobby',
    code: room.code,
    seat,
    host: room.host,
    players: room.seats.map((s) => (s ? { name: s.name, connected: !!s.ws } : null)),
    config: room.config,
    inMatch: !!room.state,
  };
}

function setDeadline(room) {
  const st = room.state;
  if (!st) return;
  const key = `${st.phase}:${st.round}:${st.turn}`;
  if (room.deadlineKey === key) return;
  room.deadlineKey = key;
  const secs = st.phase === 'setup' ? st.cfg.match.setupSeconds : st.phase === 'planning' ? st.cfg.match.planSeconds : 0;
  st.deadline = secs > 0 ? Date.now() + secs * 1000 : null;
}

function broadcast(room) {
  room.lastActive = Date.now();
  setDeadline(room);
  room.seats.forEach((s, i) => {
    if (!s) return;
    send(s.ws, lobbyInfo(room, i));
    if (room.state) send(s.ws, { t: 'state', view: E.viewFor(room.state, i) });
  });
}

function seatSide(room, seat) {
  return room.state.sideOf[seat];
}

function handle(ws, msg) {
  const ctx = ws.ctx || {};
  const room = ctx.code ? rooms.get(ctx.code) : null;
  const err = (m) => send(ws, { t: 'error', msg: m });

  switch (msg.t) {
    case 'create': {
      const code = newCode();
      const token = crypto.randomUUID();
      const r = { code, seats: [{ name: (msg.name || 'Player 1').slice(0, 24), token, ws }, null], host: 0, config: structuredClone(DEFAULT_CONFIG), state: null, lastActive: Date.now() };
      rooms.set(code, r);
      ws.ctx = { code, seat: 0 };
      send(ws, { t: 'joined', code, seat: 0, token });
      return broadcast(r);
    }
    case 'join': {
      const r = rooms.get(String(msg.code || '').toUpperCase());
      if (!r) return err('Room not found');
      let seat = r.seats.findIndex((s) => s && msg.token && s.token === msg.token);
      if (seat >= 0) {
        if (r.seats[seat].ws && r.seats[seat].ws !== ws) r.seats[seat].ws.close(4000, 'replaced');
        r.seats[seat].ws = ws;
      } else {
        seat = r.seats.findIndex((s) => !s);
        if (seat < 0) return err('Room is full');
        r.seats[seat] = { name: (msg.name || `Player ${seat + 1}`).slice(0, 24), token: crypto.randomUUID(), ws };
      }
      ws.ctx = { code: r.code, seat };
      send(ws, { t: 'joined', code: r.code, seat, token: r.seats[seat].token });
      return broadcast(r);
    }
  }

  if (!room) return err('Not in a room');
  const seat = ctx.seat;
  const isHost = room.host === seat;

  switch (msg.t) {
    case 'config': {
      if (!isHost) return err('Only the host can change levers');
      let cfg;
      try {
        cfg = mergeConfig(DEFAULT_CONFIG, msg.config);
      } catch (e) {
        return err(`Bad config: ${e.message}`);
      }
      room.config = cfg;
      if (room.state) E.setPendingConfig(room.state, cfg);
      return broadcast(room);
    }
    case 'start': {
      if (!isHost) return err('Only the host can start');
      if (!room.seats[0] || !room.seats[1]) return err('Waiting for a second player');
      let hostSide = msg.hostSide;
      if (hostSide !== 'T' && hostSide !== 'CT') hostSide = crypto.randomInt(2) ? 'T' : 'CT';
      const sides = room.host === 0 ? [hostSide, E.other(hostSide)] : [E.other(hostSide), hostSide];
      room.state = E.createMatch({ config: room.config, seed: crypto.randomInt(2 ** 31), firstSides: sides });
      room.deadlineKey = null;
      return broadcast(room);
    }
    case 'leaveMatch': {
      if (!isHost) return err('Only the host can end the match');
      room.state = null;
      return broadcast(room);
    }
  }

  const st = room.state;
  if (!st) return err('No match in progress');
  const side = seatSide(room, seat);
  let r;
  switch (msg.t) {
    case 'setup':
      r = E.submitSetup(st, side, msg.spec);
      break;
    case 'orders':
      r = E.submitOrders(st, side, msg.orders);
      break;
    case 'unlock':
      r = E.unlock(st, side);
      break;
    case 'ack':
      r = E.ackRoundEnd(st, side);
      break;
    default:
      return err(`Unknown message ${msg.t}`);
  }
  if (!r.ok) return err(r.error);
  broadcast(room);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    try {
      handle(ws, msg);
    } catch (e) {
      console.error(e);
      send(ws, { t: 'error', msg: `Server error: ${e.message}` });
    }
  });
  ws.on('close', () => {
    const room = ws.ctx && rooms.get(ws.ctx.code);
    if (!room) return;
    const s = room.seats[ws.ctx.seat];
    if (s && s.ws === ws) s.ws = null;
    broadcast(room);
  });
});

// Timers, heartbeats, idle cleanup.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const st = room.state;
    if (st && st.deadline && now >= st.deadline) {
      st.deadline = null;
      E.timeout(st);
      broadcast(room);
    }
    if (now - room.lastActive > ROOM_IDLE_MS && room.seats.every((s) => !s || !s.ws)) rooms.delete(room.code);
  }
}, 1000);

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log(`cs-tactics listening on :${PORT}`));
