// CPU opponent. Decides only from viewFor(state, seat) — the same fog-of-war view a
// human gets — plus the public map. `mem` is a small per-room object the server keeps
// between calls (target site, posts, what utility has been used).

import { getMap } from './map.js';
import { findPath, dist, cheb } from './geom.js';
import { nextRand } from './rng.js';
import { applyBuy, pickGear, inSetupZone, checkOrder, weaponOf, defaultOrder } from './engine.js';

export const DIFFICULTIES = ['easy', 'normal'];

// ---------- map knowledge ----------

const siteCache = new Map();
function sites(map) {
  if (siteCache.has(map.id)) return siteCache.get(map.id);
  const out = {};
  for (const s of ['A', 'B']) {
    const tiles = [];
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) if (map.siteAt(x, y) === s) tiles.push({ x, y });
    const mx = tiles.reduce((a, t) => a + t.x, 0) / tiles.length;
    const my = tiles.reduce((a, t) => a + t.y, 0) / tiles.length;
    const center = tiles.reduce((best, t) => (Math.hypot(t.x - mx, t.y - my) < Math.hypot(best.x - mx, best.y - my) ? t : best));
    out[s] = { tiles, cover: tiles.filter((t) => map.isCover(t.x, t.y)), center };
  }
  siteCache.set(map.id, out);
  return out;
}

const coverTiles = (map) => {
  const out = [];
  for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) if (map.isCover(x, y)) out.push({ x, y });
  return out;
};

// A gathering point on the T route to a site, just outside the site, used to group up
// before executing together.
const stageCache = new Map();
function stagingFor(map, site, from) {
  const k = `${map.id}:${site.center.x},${site.center.y}`;
  if (stageCache.has(k)) return stageCache.get(k);
  const path = findPath(map, from, site.center) || [];
  const away = (t) => Math.min(...site.tiles.map((s) => cheb(s, t)));
  let stage = from;
  for (const t of path) {
    if (away(t) >= 4) stage = t;
    else break;
  }
  stageCache.set(k, stage);
  return stage;
}

const pathLen = (map, a, b) => {
  const p = findPath(map, a, b);
  return p ? p.length : Infinity;
};

function nearestSite(map, p) {
  const S = sites(map);
  const dA = dist(p, S.A.center);
  const dB = dist(p, S.B.center);
  const d = Math.min(dA, dB);
  return d <= 9 ? (dA <= dB ? 'A' : 'B') : null;
}

// ---------- memory / rng ----------

function roundMem(mem, view) {
  if (mem.round !== view.round || mem.side !== view.side) {
    const rng = mem.rng ?? ((Date.now() ^ 0x9e3779b9) >>> 0);
    for (const k of Object.keys(mem)) delete mem[k];
    Object.assign(mem, { round: view.round, side: view.side, rng, thrown: {}, posts: {}, threat: null, threatTurn: 0 });
  }
  return mem;
}
const rand = (mem) => nextRand(mem);
const pick = (mem, arr) => arr[Math.floor(rand(mem) * arr.length)];
function shuffle(mem, arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand(mem) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- setup ----------

export function botSetup(view, mem = {}, difficulty = 'normal') {
  roundMem(mem, view);
  const cfg = view.cfg;
  const map = getMap(view.mapId);
  const side = view.side;
  const units = view.units;
  const spec = { units: {}, carrier: undefined };
  for (const u of units) spec.units[u.id] = { buy: [], x: null, y: null, hidden: true };

  // --- buying ---
  const gear = Object.fromEntries(units.map((u) => [u.id, pickGear(u)]));
  let budget = view.money;
  const tryBuy = (u, id) => {
    if (!cfg.items[id]) return false;
    const g = structuredClone(gear[u.id]);
    let cost;
    try {
      cost = applyBuy(cfg, side, g, id);
    } catch {
      return false;
    }
    if (cost > budget) return false;
    budget -= cost;
    gear[u.id] = g;
    spec.units[u.id].buy.push(id);
    return true;
  };
  const n = units.length;
  const per = view.money / n;
  const rifle = side === 'T' ? 'ak47' : 'm4a4';
  const cheapRifle = side === 'T' ? 'galil' : 'famas';
  const smg = side === 'T' ? 'mac10' : 'mp9';
  const molly = side === 'T' ? 'molotov' : 'incendiary';
  const fullCost = cfg.items[rifle].price + cfg.items.helmet.price;
  const pistolRound = units.every((u) => !u.primary) && per <= cfg.economy.startMoney;
  const easy = difficulty === 'easy';

  if (pistolRound) {
    units.forEach((u, i) => {
      if (i % 2 === 0) tryBuy(u, 'kevlar');
      else {
        tryBuy(u, 'p250');
        if (!easy) tryBuy(u, 'flash');
      }
    });
  } else if (per >= fullCost * (easy ? 1.2 : 0.95)) {
    // Full buy: guns first, then armor, then kits & utility.
    units.forEach((u, i) => {
      if (gear[u.id].primary) return;
      if (i === 0 && per >= 6000 && !easy && rand(mem) < 0.5 && tryBuy(u, 'awp')) return;
      tryBuy(u, rifle) || tryBuy(u, cheapRifle) || tryBuy(u, smg);
    });
    units.forEach((u) => tryBuy(u, 'helmet') || tryBuy(u, 'kevlar'));
    if (side === 'CT') units.slice(0, 2).forEach((u) => tryBuy(u, 'kit'));
    if (!easy) for (const id of ['flash', 'smoke', side === 'T' ? molly : 'he', 'flash', side === 'T' ? 'he' : molly]) units.forEach((u) => tryBuy(u, id));
  } else if (per >= 2000 || (!easy && per >= 1500 && rand(mem) < 0.4)) {
    // Force buy.
    units.forEach((u) => {
      if (!gear[u.id].primary) tryBuy(u, smg) || tryBuy(u, 'nova');
    });
    units.forEach((u) => tryBuy(u, 'kevlar'));
    if (!easy) units.forEach((u) => tryBuy(u, 'flash'));
  } else {
    // Eco: save, but survivors top up armor.
    units.forEach((u) => {
      if (gear[u.id].primary) tryBuy(u, 'kevlar');
    });
  }

  // --- placement ---
  const zone = [];
  for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) if (inSetupZone(cfg, map, side, x, y)) zone.push({ x, y });
  const used = new Set();
  const take = (t) => {
    used.add(`${t.x},${t.y}`);
    return t;
  };
  const free = (t) => !used.has(`${t.x},${t.y}`);

  if (side === 'T') {
    const spots = shuffle(mem, zone);
    units.forEach((u) => Object.assign(spec.units[u.id], take(spots.find(free))));
    // Carrier: the unit with the cheapest gun (best guns lead the entry).
    const sorted = [...units].sort((a, b) => cfg.items[gear[a.id].primary || gear[a.id].secondary].price - cfg.items[gear[b.id].primary || gear[b.id].secondary].price);
    spec.carrier = sorted[0].id;
    mem.target = pick(mem, ['A', 'B']);
  } else {
    const S = sites(map);
    const posts = [];
    for (let i = 0; i < n; i++) posts.push(i % 2 === 0 ? 'A' : 'B');
    if (n >= 4 && !easy) posts[n - 1] = 'mid';
    const ordered = shuffle(mem, posts);
    units.forEach((u, i) => {
      const post = ordered[i];
      mem.posts[u.id] = post;
      let spot;
      if (post === 'mid') {
        spot = zone.filter(free).filter((t) => map.isSpawn(t.x, t.y, 'CT')).sort((a, b) => (map.isCover(b.x, b.y) - map.isCover(a.x, a.y)) || dist(a, { x: 17, y: 4 }) - dist(b, { x: 17, y: 4 }))[0];
      } else {
        const cover = shuffle(mem, S[post].cover.filter((t) => inSetupZone(cfg, map, side, t.x, t.y))).filter(free);
        spot = (easy ? null : cover[0]) || shuffle(mem, S[post].tiles).find(free);
      }
      spot = spot || zone.find(free);
      Object.assign(spec.units[u.id], take(spot), { hidden: !easy });
    });
  }
  return spec;
}

// ---------- orders ----------

export function botOrders(view, mem = {}, difficulty = 'normal') {
  roundMem(mem, view);
  const cfg = view.cfg;
  const map = getMap(view.mapId);
  const easy = difficulty === 'easy';
  const S = sites(map);
  const alive = view.units.filter((u) => u.alive);
  const enemies = view.enemies.filter((e) => e.alive);
  const res = view.lastResolution && view.lastResolution.turn === view.turn - 1 ? view.lastResolution : null;
  const pings = res ? res.events.filter((e) => e.k === 'ping') : [];
  const turnsLeft = cfg.round.maxTurns - view.turn + 1;
  const orders = {};
  let throwsThisTurn = 0;
  const maxThrows = easy ? 0 : 2;

  const valid = (u, o) => !checkOrder(cfg, map, u, o, view.bomb);
  const set = (u, o) => {
    if (o && valid(u, o)) {
      orders[u.id] = o;
      return true;
    }
    return false;
  };
  const tryThrow = (u, kinds, target) => {
    if (throwsThisTurn >= maxThrows || !target) return false;
    for (const kind of kinds) {
      if (!u.utility.includes(kind)) continue;
      const o = { action: 'throw', util: kind, target: { x: target.x, y: target.y } };
      if (set(u, o)) {
        throwsThisTurn++;
        return true;
      }
    }
    return false;
  };
  const inRange = (u, e) => dist(u, e) <= weaponOf(cfg, u).range;
  const engage = (u) => {
    const visible = enemies.filter((e) => inRange(u, e));
    if (!visible.length) return false;
    const e = visible.sort((a, b) => dist(u, a) - dist(u, b))[0];
    const d = dist(u, e);
    if (!easy && d > 2.5 && d <= cfg.utility.throwRange && rand(mem) < 0.5 && tryThrow(u, ['molotov', 'he', 'flash'], e)) return true;
    return set(u, map.isCover(u.x, u.y) && !easy ? { action: 'hide' } : { action: 'hold' });
  };
  const move = (u, to, mode) => {
    if (!to || (u.x === to.x && u.y === to.y)) return false;
    return set(u, { action: mode, to: { x: to.x, y: to.y } });
  };
  const nearestCover = (p, within, exclude = new Set()) =>
    coverTiles(map)
      .filter((t) => dist(t, p) <= within && !exclude.has(`${t.x},${t.y}`))
      .sort((a, b) => dist(a, p) - dist(b, p))[0];

  if (view.side === 'T') {
    const bomb = view.bomb;
    const planted = bomb?.state === 'planted';
    const target = mem.target || (mem.target = pick(mem, ['A', 'B']));
    const site = S[target];
    const claimed = new Set();
    // Whoever is closest goes for a dropped bomb.
    let fetcher = null;
    if (bomb?.state === 'dropped') fetcher = [...alive].sort((a, b) => pathLen(map, a, bomb) - pathLen(map, b, bomb))[0];
    // Destinations: carrier to the site centre, others spread over cover tiles in the site.
    const spread = shuffle(mem, site.cover.length ? site.cover : site.tiles);
    const spawn = { x: 17, y: 20 };
    const options = map.stages?.[target] || [stagingFor(map, site, map.isSpawn(spawn.x, spawn.y, 'T') ? spawn : alive[0] || spawn)];
    if (mem.stageIdx == null) mem.stageIdx = Math.floor(rand(mem) * options.length);
    const stage = options[mem.stageIdx % options.length];
    if (!easy && mem.phase !== 'execute') {
      const grouped = alive.every((u) => pathLen(map, u, stage) <= 4);
      const spotted = enemies.length > 0 || pings.some((p) => p.kind === 'shot');
      if (grouped || spotted || turnsLeft <= 7 || bomb?.state !== 'carried') mem.phase = 'execute';
    }

    alive.forEach((u, i) => {
      if (u.hasBomb && map.siteAt(u.x, u.y) && !planted) {
        // Plant unless an enemy is right on top of us and we have teammates to trade.
        const danger = enemies.some((e) => dist(u, e) <= 3);
        if (!danger || alive.length === 1 || turnsLeft <= 2) return set(u, { action: 'plant' });
      }
      if (fetcher && u.id === fetcher.id) return move(u, bomb, 'run');
      if (engage(u)) return;
      if (planted) {
        // Post-plant: get to cover near the bomb and hide.
        if (map.isCover(u.x, u.y) && dist(u, bomb) <= 6) return set(u, easy ? { action: 'hold' } : { action: 'hide' });
        const spot = nearestCover(bomb, 6, claimed);
        if (spot) {
          claimed.add(`${spot.x},${spot.y}`);
          return move(u, spot, dist(u, spot) > 4 ? 'run' : 'walk') || set(u, { action: 'hold' });
        }
        return dist(u, bomb) > 3 ? move(u, bomb, 'walk') : set(u, { action: 'hold' });
      }
      // Normal: gather at a staging point out of sight of the site, then execute together.
      if (!easy && mem.phase !== 'execute') {
        const L = pathLen(map, u, stage);
        if (L <= 2) return set(u, map.isCover(u.x, u.y) ? { action: 'hide' } : { action: 'hold' });
        const ring = [stage, ...[[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, 1]].map(([dx, dy]) => ({ x: stage.x + dx, y: stage.y + dy }))].filter((t) => map.walkable(t.x, t.y));
        const spot = ring[i % ring.length];
        return move(u, spot, L > 8 || turnsLeft <= 5 ? 'run' : 'walk') || set(u, { action: 'hold' });
      }
      const dest = u.hasBomb ? site.center : spread[i % spread.length];
      const L = pathLen(map, u, dest);
      // Utility on the execute: flash the site, burn/HE likely hiding spots, smoke the CT-side approach.
      if (!easy && !u.hasBomb) {
        const hidingSpot = site.cover.filter((t) => dist(u, t) <= cfg.utility.throwRange).sort((a, b) => dist(u, a) - dist(u, b))[0];
        const ctSide = site.tiles.filter((t) => dist(u, t) <= cfg.utility.throwRange).sort((a, b) => a.y - b.y || dist(a, { x: 17, y: 2 }) - dist(b, { x: 17, y: 2 }))[0];
        const flashAt = site.tiles.filter((t) => dist(u, t) <= cfg.utility.throwRange).sort((a, b) => dist(a, site.center) - dist(b, site.center))[0];
        const plans = [
          ['flash', flashAt],
          ['molotov', hidingSpot],
          ['he', hidingSpot],
          ['smoke', ctSide],
        ];
        for (const [kind, t] of plans) {
          if ((mem.thrown[kind] || 0) >= 2) continue;
          if (tryThrow(u, [kind], t)) {
            mem.thrown[kind] = (mem.thrown[kind] || 0) + 1;
            return;
          }
        }
      }
      const run = easy || mem.phase === 'execute' || L > 10 || turnsLeft <= Math.ceil(L / cfg.movement.run) + 2;
      // The carrier hangs back a step so entry fraggers go first.
      if (u.hasBomb && !easy && alive.length > 1) {
        const lead = Math.min(...alive.filter((x) => !x.hasBomb).map((x) => pathLen(map, x, site.center)));
        if (L <= lead && L > 0 && turnsLeft > 3 && (mem.carrierHeld || 0) < 1) {
          mem.carrierHeld = (mem.carrierHeld || 0) + 1;
          return set(u, { action: 'hold' });
        }
      }
      return move(u, dest, run ? 'run' : 'walk') || set(u, { action: 'hold' });
    });
  } else {
    const bomb = view.bomb;
    const planted = bomb?.state === 'planted';
    // Threat tracking from sightings and sounds.
    const evidence = [...enemies, ...pings];
    for (const p of evidence) {
      const s = nearestSite(map, p);
      if (s) {
        mem.threat = s;
        mem.threatTurn = view.turn;
      }
    }
    if (planted) {
      mem.threat = bomb.site;
      mem.threatTurn = view.turn;
    }
    const threat = mem.threat && view.turn - mem.threatTurn <= 3 ? mem.threat : null;
    const anchors = new Set();
    for (const s of ['A', 'B']) {
      const a = alive.find((u) => mem.posts[u.id] === s);
      if (a) anchors.add(a.id);
    }
    const claimed = new Set();
    const needTurns = alive.some((u) => u.kit) ? cfg.bomb.defuseTurnsWithKit : cfg.bomb.defuseTurns;

    for (const u of alive) {
      if (planted) {
        const near = cheb(u, bomb) <= cfg.bomb.defuseRange;
        if (near && (!enemies.length || bomb.timer <= needTurns)) {
          set(u, { action: 'defuse' });
          continue;
        }
        if (engage(u)) continue;
        if (!easy && dist(u, bomb) <= cfg.utility.throwRange && tryThrow(u, ['smoke', 'flash', 'he'], bomb)) continue;
        // Retake: get adjacent to the bomb.
        const adj = [{ x: bomb.x, y: bomb.y }, ...[[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]].map(([dx, dy]) => ({ x: bomb.x + dx, y: bomb.y + dy }))].filter(
          (t) => map.walkable(t.x, t.y) && !claimed.has(`${t.x},${t.y}`),
        );
        const spot = adj.sort((a, b) => pathLen(map, u, a) - pathLen(map, u, b))[0];
        if (spot) claimed.add(`${spot.x},${spot.y}`);
        const L = spot ? pathLen(map, u, spot) : 0;
        const hurry = bomb.timer <= Math.ceil(L / cfg.movement.run) + needTurns;
        move(u, spot, easy || hurry || L > 6 ? 'run' : 'walk') || set(u, { action: 'hold' });
        continue;
      }
      if (engage(u)) continue;
      // Rotate toward a threatened site (anchors stay home).
      const post = mem.posts[u.id] || nearestSite(map, u) || 'mid';
      if (threat && post !== threat && !anchors.has(u.id) && !easy) {
        const spot = shuffle(mem, S[threat].cover).find((t) => !claimed.has(`${t.x},${t.y}`)) || S[threat].center;
        claimed.add(`${spot.x},${spot.y}`);
        if (u.x === spot.x && u.y === spot.y) set(u, { action: 'hide' });
        else move(u, spot, pathLen(map, u, spot) > 6 ? 'run' : 'walk');
        mem.posts[u.id] = threat;
        continue;
      }
      // Hold the post from cover.
      if (map.isCover(u.x, u.y)) {
        set(u, easy ? { action: 'hold' } : { action: 'hide' });
        continue;
      }
      // Sounds nearby? Burn them if we can.
      if (!easy) {
        const ping = pings.filter((p) => dist(u, p) <= cfg.utility.throwRange && dist(u, p) > 2).sort((a, b) => dist(u, a) - dist(u, b))[0];
        if (ping && rand(mem) < 0.4 && tryThrow(u, ['molotov', 'he'], ping)) continue;
      }
      const spot = !easy && nearestCover(u, 5, claimed);
      if (spot) {
        claimed.add(`${spot.x},${spot.y}`);
        if (move(u, spot, 'walk')) continue;
      }
      set(u, { action: 'hold' });
    }
  }

  for (const u of alive) if (!orders[u.id]) orders[u.id] = defaultOrder(map, u);
  return orders;
}
