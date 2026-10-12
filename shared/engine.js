// Rules engine. Pure state transitions on a JSON-serializable state object.
// The server is the only thing that holds full state; clients get viewFor(state, player).

import { DEFAULT_CONFIG, mergeConfig } from './config.js';
import { getMap } from './map.js';
import { key, dist, cheb, hasLOS, findPath, tilesInRadius } from './geom.js';
import { nextRand, d100 } from './rng.js';

export const SIDES = ['T', 'CT'];
export const other = (s) => (s === 'T' ? 'CT' : 'T');
export const ACTIONS = ['run', 'walk', 'hold', 'hide', 'plant', 'defuse', 'throw'];

const mapOf = (state) => getMap(state.mapId);
const fail = (error) => ({ ok: false, error });
const OK = { ok: true };

// ---------- gear helpers (shared with client) ----------

export const weaponId = (u) => u.primary || u.secondary;
export const weaponOf = (cfg, u) => cfg.items[weaponId(u)];
export const isWounded = (cfg, u) => u.hp <= cfg.combat.woundThreshold;

export function defaultGear(cfg, side) {
  return { primary: null, secondary: cfg.defaultPistol[side], armor: false, helmet: false, kit: false, utility: [] };
}

export const pickGear = (u) => ({
  primary: u.primary,
  secondary: u.secondary,
  armor: u.armor,
  helmet: u.helmet,
  kit: u.kit,
  utility: [...u.utility],
});

export function canCarry(cfg, gear, kind) {
  if (gear.utility.length >= cfg.utility.maxTotal) return false;
  const n = gear.utility.filter((k) => k === kind).length;
  return n < (cfg.utility.maxPerType[kind] ?? 1);
}

// Mutates gear; returns cost or throws.
export function applyBuy(cfg, side, gear, itemId) {
  const item = cfg.items[itemId];
  if (!item) throw new Error(`Unknown item ${itemId}`);
  if (item.sides && !item.sides.includes(side)) throw new Error(`${item.name} not available to ${side}`);
  switch (item.type) {
    case 'weapon':
      if (item.slot === 'primary') gear.primary = itemId;
      else gear.secondary = itemId;
      return item.price;
    case 'kevlar':
      if (gear.armor) throw new Error('Already has kevlar');
      gear.armor = true;
      return item.price;
    case 'helmet': {
      if (gear.helmet) throw new Error('Already has a helmet');
      const cost = gear.armor ? item.priceIfArmored : item.price;
      gear.armor = gear.helmet = true;
      return cost;
    }
    case 'kit':
      if (gear.kit) throw new Error('Already has a kit');
      gear.kit = true;
      return item.price;
    case 'grenade':
      if (!canCarry(cfg, gear, item.kind)) throw new Error(`Can't carry another ${item.name}`);
      gear.utility.push(item.kind);
      return item.price;
    default:
      throw new Error(`Bad item type ${item.type}`);
  }
}

export function inSetupZone(cfg, map, side, x, y) {
  if (!map.walkable(x, y)) return false;
  if (map.isSpawn(x, y, side)) return true;
  return side === 'CT' && cfg.round.ctSetupZone === 'spawnAndSites' && !!map.siteAt(x, y);
}

// What a unit does if its player gives no order: stay hidden if already hidden on cover, else hold.
export const defaultOrder = (map, u) => (u.hidden && map.isCover(u.x, u.y) ? { action: 'hide' } : { action: 'hold' });

export const moveAllowance = (cfg, u, action) =>
  Math.max(0, cfg.movement[action] - (isWounded(cfg, u) ? cfg.movement.woundedPenalty : 0));

// spec: { units: { [id]: { buy: [itemId], x, y, hidden } }, carrier: unitId }
export function checkSetup(cfg, map, side, units, money, spec) {
  const out = { cost: 0, gear: {}, error: null };
  try {
    const used = new Set();
    for (const u of units) {
      const s = spec?.units?.[u.id] || {};
      const g = pickGear(u);
      for (const it of s.buy || []) out.cost += applyBuy(cfg, side, g, it);
      out.gear[u.id] = g;
      if (!Number.isInteger(s.x) || !Number.isInteger(s.y)) throw new Error(`Unit ${u.n} not placed`);
      if (!inSetupZone(cfg, map, side, s.x, s.y)) throw new Error(`Unit ${u.n} is outside the setup zone`);
      const k = key(s.x, s.y);
      if (used.has(k)) throw new Error('Two units on one tile');
      used.add(k);
    }
    if (out.cost > money) throw new Error(`Not enough money ($${out.cost} > $${money})`);
    if (side === 'T' && !units.some((u) => u.id === spec?.carrier)) throw new Error('Pick a bomb carrier');
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// bomb: what this side knows about the bomb (view.bomb on the client, state.bomb on the server).
export function checkOrder(cfg, map, u, o, bomb) {
  if (!o || !ACTIONS.includes(o.action)) return 'Unknown action';
  switch (o.action) {
    case 'run':
    case 'walk':
      if (!o.to || !Number.isInteger(o.to.x) || !Number.isInteger(o.to.y)) return 'Missing destination';
      if (!findPath(map, u, o.to)) return 'No path to destination';
      return null;
    case 'hold':
      return null;
    case 'hide':
      return map.isCover(u.x, u.y) ? null : 'Hide requires a cover tile';
    case 'plant':
      if (!u.hasBomb) return 'Unit does not carry the bomb';
      return map.siteAt(u.x, u.y) ? null : 'Must be on a bomb site to plant';
    case 'defuse':
      if (u.side !== 'CT') return 'Only CTs defuse';
      if (!bomb || bomb.state !== 'planted') return 'Bomb is not planted';
      return cheb(u, bomb) <= cfg.bomb.defuseRange ? null : 'Too far from the bomb';
    case 'throw':
      if (!u.utility.includes(o.util)) return `No ${o.util} to throw`;
      if (!o.target || !Number.isInteger(o.target.x) || !Number.isInteger(o.target.y)) return 'Missing target';
      if (map.blocksLOS(o.target.x, o.target.y)) return 'Cannot throw into a wall';
      if (dist(u, o.target) > cfg.utility.throwRange) return 'Out of throw range';
      return hasLOS(map, u, o.target, null) ? null : 'No clear throw line';
  }
  return 'Unknown action';
}

export function smokeTiles(state, map = mapOf(state)) {
  const s = new Set();
  for (const sm of state.smokes) for (const [x, y] of tilesInRadius(map, sm.x, sm.y, sm.r)) s.add(key(x, y));
  return s;
}

function canSee(cfg, map, smoke, a, b) {
  const d = dist(a, b);
  if (d > cfg.vision.range) return false;
  if (b.alive && b.hidden && d > cfg.vision.hiddenRevealDistance) return false;
  return hasLOS(map, a, b, smoke);
}

function visibleEnemyIds(state, side, map, smoke) {
  const eyes = state.units.filter((u) => u.side === side && u.alive && u.x != null);
  return state.units
    .filter((v) => v.side !== side && v.x != null && eyes.some((e) => canSee(state.cfg, map, smoke, e, v)))
    .map((v) => v.id);
}

function visibleTileString(state, side, map, smoke) {
  const eyes = state.units.filter((u) => u.side === side && u.alive && u.x != null);
  let s = '';
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      const p = { x, y };
      const seen = eyes.some((e) => dist(e, p) <= state.cfg.vision.range && (map.blocksLOS(x, y) ? false : hasLOS(map, e, p, smoke)));
      s += seen ? '1' : '0';
    }
  }
  return s;
}

// ---------- match lifecycle ----------

function newTeam(cfg, side) {
  return {
    money: cfg.economy.startMoney * cfg.match.teamSize,
    lossStreak: 0,
    gear: Array.from({ length: cfg.match.teamSize }, () => defaultGear(cfg, side)),
  };
}

export function createMatch({ config, seed = Date.now(), mapId = 'dust', firstSides = ['T', 'CT'] } = {}) {
  const cfg = mergeConfig(DEFAULT_CONFIG, config);
  const state = {
    cfg,
    pendingCfg: null,
    mapId,
    rng: seed >>> 0 || 1,
    phase: 'setup',
    round: 1,
    score: [0, 0],
    sideOf: [...firstSides],
    teams: { T: newTeam(cfg, 'T'), CT: newTeam(cfg, 'CT') },
    units: [],
    drops: [],
    bomb: null,
    smokes: [],
    fires: [],
    turn: 0,
    pending: { T: null, CT: null },
    deadline: null,
    lastResolution: null,
    roundResult: null,
    matchWinner: null,
    history: [],
    halftime: false,
    dropSeq: 0,
  };
  startSetup(state);
  return state;
}

function startSetup(state) {
  const cfg = state.cfg;
  Object.assign(state, {
    phase: 'setup',
    turn: 0,
    drops: [],
    smokes: [],
    fires: [],
    bomb: null,
    pending: { T: null, CT: null },
    lastResolution: null,
    roundResult: null,
    units: [],
  });
  for (const side of SIDES) {
    state.teams[side].gear.forEach((g, i) =>
      state.units.push({
        id: `${side}${i + 1}`,
        side,
        n: i + 1,
        x: null,
        y: null,
        hp: cfg.combat.hp,
        alive: true,
        ...structuredClone(g),
        hidden: false,
        blind: 0,
        hasBomb: false,
      }),
    );
  }
}

export function submitSetup(state, side, spec) {
  if (state.phase !== 'setup') return fail('Not in setup phase');
  if (state.pending[side]) return fail('Already locked in');
  const units = state.units.filter((u) => u.side === side);
  const r = checkSetup(state.cfg, mapOf(state), side, units, state.teams[side].money, spec);
  if (r.error) return fail(r.error);
  state.pending[side] = { spec: structuredClone(spec), check: r };
  if (state.pending.T && state.pending.CT) beginLive(state);
  return OK;
}

export function autoSetup(state, side) {
  const cfg = state.cfg;
  const map = mapOf(state);
  const tiles = [];
  for (let y = 0; y < map.h; y++)
    for (let x = 0; x < map.w; x++) if (inSetupZone(cfg, map, side, x, y)) tiles.push({ x, y });
  const units = state.units.filter((u) => u.side === side);
  const spec = { units: {}, carrier: side === 'T' ? units[0].id : undefined };
  for (const u of units) {
    const t = tiles.splice(Math.floor(nextRand(state) * tiles.length), 1)[0];
    spec.units[u.id] = { buy: [], x: t.x, y: t.y };
  }
  return spec;
}

function beginLive(state) {
  const map = mapOf(state);
  for (const side of SIDES) {
    const { spec, check } = state.pending[side];
    state.teams[side].money -= check.cost;
    for (const u of state.units.filter((v) => v.side === side)) {
      Object.assign(u, check.gear[u.id]);
      const s = spec.units[u.id];
      u.x = s.x;
      u.y = s.y;
      u.hidden = !!s.hidden && map.isCover(u.x, u.y);
      if (side === 'T' && u.id === spec.carrier) u.hasBomb = true;
    }
  }
  const carrier = state.units.find((u) => u.hasBomb);
  state.bomb = { state: 'carried', carrierId: carrier.id, x: carrier.x, y: carrier.y, timer: null, plantProgress: 0, defuseProgress: 0, site: null };
  state.turn = 1;
  state.phase = 'planning';
  state.pending = { T: null, CT: null };
}

// orders: { [unitId]: { action, to?, util?, target?, stopOnContact? } }
export function submitOrders(state, side, orders) {
  if (state.phase !== 'planning') return fail('Not in planning phase');
  if (state.pending[side]) return fail('Already locked in');
  const map = mapOf(state);
  const clean = {};
  for (const u of state.units.filter((v) => v.side === side && v.alive)) {
    const o = orders?.[u.id] || defaultOrder(map, u);
    const err = checkOrder(state.cfg, map, u, o, state.bomb);
    if (err) return fail(`Unit ${u.n}: ${err}`);
    clean[u.id] = {
      action: o.action,
      to: o.to ? { x: o.to.x, y: o.to.y } : undefined,
      util: o.util,
      target: o.target ? { x: o.target.x, y: o.target.y } : undefined,
      stopOnContact: o.stopOnContact,
    };
  }
  state.pending[side] = { orders: clean };
  if (state.pending.T && state.pending.CT) resolveTurn(state);
  return OK;
}

export function unlock(state, side) {
  if (!['setup', 'planning'].includes(state.phase)) return fail('Nothing to unlock');
  if (!state.pending[side]) return fail('Not locked');
  state.pending[side] = null;
  return OK;
}

// Called by the server when a timer expires.
export function timeout(state) {
  if (state.phase === 'setup') {
    for (const s of SIDES) if (!state.pending[s]) submitSetup(state, s, autoSetup(state, s));
  } else if (state.phase === 'planning') {
    for (const s of SIDES) if (!state.pending[s]) submitOrders(state, s, {});
  } else if (state.phase === 'roundEnd') {
    for (const s of SIDES) if (!state.pending[s]) ackRoundEnd(state, s);
  }
}

export function ackRoundEnd(state, side) {
  if (state.phase !== 'roundEnd') return fail('Round not over');
  state.pending[side] = true;
  if (state.pending.T && state.pending.CT) nextRound(state);
  return OK;
}

export function setPendingConfig(state, config) {
  state.pendingCfg = config;
}

function nextRound(state) {
  state.round++;
  state.halftime = false;
  if (state.pendingCfg) {
    const teamSize = state.cfg.match.teamSize;
    state.cfg = mergeConfig(DEFAULT_CONFIG, state.pendingCfg);
    state.cfg.match.teamSize = teamSize;
    state.pendingCfg = null;
  }
  if (state.round - 1 === state.cfg.match.halftimeAfterRound) {
    state.sideOf = [state.sideOf[1], state.sideOf[0]];
    state.teams = { T: newTeam(state.cfg, 'T'), CT: newTeam(state.cfg, 'CT') };
    state.halftime = true;
  }
  startSetup(state);
}

// ---------- turn resolution ----------

function resolveTurn(state) {
  const cfg = state.cfg;
  const map = mapOf(state);
  const T = cfg.round.ticksPerTurn;
  const orders = { ...state.pending.T.orders, ...state.pending.CT.orders };
  state.pending = { T: null, CT: null };
  const res = { turn: state.turn, frames: [], events: [], end: null };
  let tick = -1;
  let smoke = smokeTiles(state, map);
  let ended = null;

  const alive = () => state.units.filter((u) => u.alive);
  const ev = (e) => res.events.push({ ...e, tick, f: res.frames.length });
  const holding = (u) => u._o.action === 'hold' || u._o.action === 'hide';
  const capMoney = (side) => {
    const t = state.teams[side];
    t.money = Math.min(t.money, cfg.economy.maxMoney * cfg.match.teamSize);
  };

  const snapshot = (label) => {
    if (state.bomb.state === 'carried') {
      const c = state.units.find((u) => u.id === state.bomb.carrierId);
      state.bomb.x = c.x;
      state.bomb.y = c.y;
    }
    res.frames.push({
      label,
      tick,
      units: state.units.map((u) => ({ id: u.id, side: u.side, n: u.n, x: u.x, y: u.y, hp: u.hp, alive: u.alive, hidden: u.hidden, blind: u.blind, hasBomb: u.hasBomb })),
      vis: { T: visibleEnemyIds(state, 'T', map, smoke), CT: visibleEnemyIds(state, 'CT', map, smoke) },
      smokes: structuredClone(state.smokes),
      fires: structuredClone(state.fires),
      bomb: { ...state.bomb },
    });
  };

  const noise = (u, radius, kind) => {
    const heard = new Set();
    for (const v of alive()) if (v.side !== u.side && dist(u, v) <= radius) heard.add(v.side);
    for (const side of heard) ev({ k: 'ping', to: side, x: u.x, y: u.y, kind });
  };

  const drop = (x, y, type, item) => state.drops.push({ id: ++state.dropSeq, x, y, type, item });

  const kill = (v, killer, cause) => {
    v.alive = false;
    v.hp = 0;
    v.hidden = false;
    ev({ k: 'kill', u: v.id, by: killer?.id ?? null, bySide: killer?.side ?? null, cause });
    if (v.primary) drop(v.x, v.y, 'weapon', v.primary);
    else drop(v.x, v.y, 'weapon', v.secondary);
    for (const g of v.utility) drop(v.x, v.y, 'grenade', g);
    if (v.kit) drop(v.x, v.y, 'kit', 'kit');
    if (v.hasBomb) {
      v.hasBomb = false;
      Object.assign(state.bomb, { state: 'dropped', carrierId: null, x: v.x, y: v.y, plantProgress: 0 });
      ev({ k: 'bombDrop', x: v.x, y: v.y });
    }
    if (killer && killer.side !== v.side) {
      const reward = cfg.items[cause]?.killReward ?? cfg.utility[cause]?.killReward ?? 0;
      state.teams[killer.side].money += reward;
      capMoney(killer.side);
    }
  };

  const damage = (v, dmg, by, cause) => {
    if (!v.alive || dmg <= 0) return;
    v.hp -= dmg;
    ev({ k: 'dmg', u: v.id, dmg, by: by?.id ?? null, bySide: by?.side ?? null, cause });
    if (v.hp <= 0) kill(v, by, cause);
  };

  const targetsFor = (u) => {
    const w = weaponOf(cfg, u);
    return alive().filter((v) => v.side !== u.side && dist(u, v) <= w.range && canSee(cfg, map, smoke, u, v));
  };

  const hitChance = (u, tgt, w, shooterHidden) => {
    const c = cfg.combat;
    const d = dist(u, tgt);
    const band = d <= c.rangeBands[0] ? 0 : d <= c.rangeBands[1] ? 1 : 2;
    let p = w.accuracy[band];
    const mv = w.movePenaltyMult ?? 1;
    if (u._movedTick === 'run') p -= c.runPenalty * mv;
    else if (u._movedTick === 'walk') p -= c.walkPenalty * mv;
    if (holding(u)) p += c.holdBonus;
    if (shooterHidden) p += c.hiddenShooterBonus;
    if (map.isCover(tgt.x, tgt.y)) p -= c.targetInCoverPenalty;
    if (tgt._movedTick === 'run') p -= c.targetRunningPenalty;
    if (isWounded(cfg, u)) p -= c.woundedAccuracyPenalty;
    return Math.max(c.minHitChance, Math.min(c.maxHitChance, Math.round(p)));
  };

  const rollDamage = (w, tgt, hs) => {
    const c = cfg.combat;
    let dmg = w.damage * (1 + (nextRand(state) * 2 - 1) * c.damageVariance);
    if (hs) {
      dmg *= tgt.helmet ? c.headshotMultiplierHelmet : c.headshotMultiplier;
      if (tgt.helmet) dmg *= w.armorPen;
    } else if (tgt.armor) dmg *= w.armorPen;
    return Math.max(1, Math.round(dmg));
  };

  const combat = () => {
    const canFire = (u) => u.alive && u.blind <= 0 && (cfg.combat.plantDefuseCanFire || !['plant', 'defuse'].includes(u._o.action));
    const shooters = alive().filter(canFire);
    const groups = cfg.combat.initiative ? [shooters.filter(holding), shooters.filter((u) => !holding(u))] : [shooters];
    for (const group of groups) {
      // Targets are locked in before anyone in this group fires: shots within a group are simultaneous.
      const plans = [];
      for (const u of group) {
        if (!u.alive) continue;
        const ts = targetsFor(u);
        if (!ts.length) continue;
        ts.sort((a, b) => dist(u, a) - dist(u, b) || a.hp - b.hp || a.id.localeCompare(b.id));
        plans.push({ u, tgt: ts[0], hidden: u.hidden });
      }
      const pendingHp = new Map();
      const hits = [];
      for (const { u, tgt, hidden } of plans) {
        const w = weaponOf(cfg, u);
        const wid = weaponId(u);
        const need = hitChance(u, tgt, w, hidden);
        for (let s = 0; s < w.shots; s++) {
          if ((pendingHp.get(tgt.id) ?? tgt.hp) <= 0) break;
          const roll = d100(state);
          const hit = roll <= need;
          let dmg = 0;
          let hs = false;
          if (hit) {
            hs = nextRand(state) < w.headshot;
            dmg = rollDamage(w, tgt, hs);
            pendingHp.set(tgt.id, (pendingHp.get(tgt.id) ?? tgt.hp) - dmg);
            hits.push({ u, tgt, dmg, wid });
          }
          ev({ k: 'shot', s: u.id, t: tgt.id, w: wid, need, roll, hit, hs, dmg, from: { x: u.x, y: u.y }, to: { x: tgt.x, y: tgt.y }, hidden });
        }
        noise(u, cfg.noise.gunfireRadius, 'shot');
      }
      for (const { u } of plans) if (cfg.combat.hiddenBreaksOnFire) u.hidden = false;
      for (const h of hits) {
        if (!h.tgt.alive) continue;
        h.tgt.hp -= h.dmg;
        if (h.tgt.hp <= 0) kill(h.tgt, h.u, h.wid);
      }
    }
  };

  const pickups = () => {
    for (const u of alive()) {
      const b = state.bomb;
      if (u.side === 'T' && b.state === 'dropped' && b.x === u.x && b.y === u.y) {
        u.hasBomb = true;
        Object.assign(b, { state: 'carried', carrierId: u.id });
        ev({ k: 'pickup', u: u.id, side: u.side, item: 'bomb' });
      }
      for (const d of state.drops.filter((d) => d.x === u.x && d.y === u.y)) {
        let took = false;
        if (d.type === 'weapon') {
          const w = cfg.items[d.item];
          if (w.slot === 'primary') {
            const cur = u.primary ? cfg.items[u.primary].price : 0;
            if (w.price > cur) {
              if (u.primary) drop(u.x, u.y, 'weapon', u.primary);
              u.primary = d.item;
              took = true;
            }
          } else if (!u.primary && w.price > cfg.items[u.secondary].price) {
            drop(u.x, u.y, 'weapon', u.secondary);
            u.secondary = d.item;
            took = true;
          }
        } else if (d.type === 'grenade' && canCarry(cfg, u, d.item)) {
          u.utility.push(d.item);
          took = true;
        } else if (d.type === 'kit' && u.side === 'CT' && !u.kit) {
          u.kit = true;
          took = true;
        }
        if (took) {
          state.drops = state.drops.filter((x) => x !== d);
          ev({ k: 'pickup', u: u.id, side: u.side, item: d.item });
        }
      }
    }
  };

  const throwUtility = (u, kind, at) => {
    const i = u.utility.indexOf(kind);
    if (i < 0) return;
    u.utility.splice(i, 1);
    const U = cfg.utility;
    ev({ k: 'util', kind, by: u.id, side: u.side, from: { x: u.x, y: u.y }, at: { ...at } });
    noise(u, cfg.noise.utilityRadius, 'utility');
    if (kind === 'smoke') {
      state.smokes.push({ x: at.x, y: at.y, r: U.smoke.radius, turns: U.smoke.turns });
    } else if (kind === 'flash') {
      for (const v of alive()) {
        if (!U.flash.friendlyFire && v.side === u.side) continue;
        if (dist(v, at) <= U.flash.radius && hasLOS(map, at, v, smoke)) {
          v.blind = U.flash.blindTicks;
          v.hidden = false;
          ev({ k: 'blind', u: v.id, side: v.side, bySide: u.side });
        }
      }
    } else if (kind === 'he') {
      for (const v of alive()) {
        const d = dist(v, at);
        if (d <= U.he.radius && hasLOS(map, at, v, null)) {
          const dmg = Math.round(U.he.damage * (1 - d / (U.he.radius + 1)) * (v.hidden ? U.hiddenDamageMultiplier : 1) * (v.armor ? U.armorMultiplier : 1));
          v.hidden = false;
          damage(v, dmg, u, 'he');
        }
      }
    } else if (kind === 'molotov') {
      state.fires.push({ x: at.x, y: at.y, r: U.molotov.radius, turns: U.molotov.turns, owner: u.id, side: u.side });
    }
  };

  const checkEnd = () => {
    const aT = state.units.some((u) => u.side === 'T' && u.alive);
    const aCT = state.units.some((u) => u.side === 'CT' && u.alive);
    if (state.bomb.state === 'exploded') return { winner: 'T', reason: 'bomb' };
    if (state.bomb.state === 'defused') return { winner: 'CT', reason: 'defuse' };
    if (!aCT) return { winner: 'T', reason: 'elimination' };
    if (!aT && state.bomb.state !== 'planted') return { winner: 'CT', reason: 'elimination' };
    return null;
  };

  // --- prepare orders ---
  for (const u of alive()) {
    const o = orders[u.id] || defaultOrder(map, u);
    u._o = o;
    u._stopped = false;
    u._movedTick = null;
    u._path = null;
    u._stationary = true;
    if (o.action === 'run' || o.action === 'walk') {
      const p = (findPath(map, u, o.to) || []).slice(0, moveAllowance(cfg, u, o.action));
      u._path = p;
      u._plan = Array.from({ length: T }, (_, k) => Math.floor(((k + 1) * p.length) / T) - Math.floor((k * p.length) / T));
      u._stationary = p.length === 0;
    }
    u.hidden = o.action === 'hide' && map.isCover(u.x, u.y);
    u.blind = 0;
  }
  snapshot('start');

  // --- utility (thrown before anyone moves) ---
  tick = 0;
  const throwers = alive().filter((u) => u._o.action === 'throw');
  if (throwers.length) {
    for (const u of throwers) throwUtility(u, u._o.util, u._o.target);
    smoke = smokeTiles(state, map);
    snapshot('utility');
    ended = checkEnd();
  }

  // --- ticks ---
  for (let t = 0; t < T && !ended; t++) {
    tick = t;
    for (const u of alive()) {
      if (!u._path || u._stopped) continue;
      const soc = u._o.stopOnContact ?? cfg.movement.stopOnContactDefault;
      if (soc && targetsFor(u).length) {
        u._stopped = true;
        ev({ k: 'stop', u: u.id, side: u.side });
      }
    }
    for (const u of alive()) {
      u._movedTick = null;
      if (!u._path || u._stopped) continue;
      const n = u._plan[t];
      if (n <= 0) continue;
      const steps = u._path.splice(0, n);
      const last = steps[steps.length - 1];
      u.x = last.x;
      u.y = last.y;
      u._movedTick = u._o.action;
      if (u._o.action === 'run') noise(u, cfg.noise.runRadius, 'steps');
    }
    for (const f of state.fires) {
      const owner = state.units.find((x) => x.id === f.owner);
      for (const v of alive()) {
        if (dist(v, f) <= f.r) {
          const dmg = Math.round(cfg.utility.molotov.damagePerTick * (v.hidden ? cfg.utility.hiddenDamageMultiplier : 1) * (v.armor ? cfg.utility.armorMultiplier : 1));
          v.hidden = false;
          damage(v, dmg, owner, 'molotov');
        }
      }
    }
    combat();
    pickups();
    for (const u of alive()) if (u.blind > 0) u.blind--;
    snapshot(`Step ${t + 1}`);
    ended = checkEnd();
  }

  // --- end of turn: plant, defuse, bomb timer ---
  tick = T;
  const b = state.bomb;
  if (!ended) {
    const plantedBefore = b.state === 'planted';
    const carrier = state.units.find((u) => u.hasBomb && u.alive);
    if (carrier && carrier._o.action === 'plant' && carrier._stationary && map.siteAt(carrier.x, carrier.y)) {
      b.plantProgress++;
      if (b.plantProgress >= cfg.bomb.plantTurns) {
        carrier.hasBomb = false;
        Object.assign(b, { state: 'planted', carrierId: null, x: carrier.x, y: carrier.y, site: map.siteAt(carrier.x, carrier.y), timer: cfg.bomb.timerTurns, defuseProgress: 0 });
        state.bombEverPlanted = true;
        ev({ k: 'plant', u: carrier.id, x: b.x, y: b.y, site: b.site });
      } else ev({ k: 'planting', u: carrier.id, progress: b.plantProgress });
    } else if (b.state === 'carried') b.plantProgress = 0;

    if (plantedBefore) {
      const defusers = alive().filter((u) => u.side === 'CT' && u._o.action === 'defuse' && u._stationary && cheb(u, b) <= cfg.bomb.defuseRange);
      if (defusers.length) {
        b.defuseProgress++;
        const need = defusers.some((u) => u.kit) ? cfg.bomb.defuseTurnsWithKit : cfg.bomb.defuseTurns;
        ev({ k: 'defusing', progress: b.defuseProgress, need });
        if (b.defuseProgress >= need) {
          b.state = 'defused';
          ev({ k: 'defused' });
        }
      } else if (cfg.bomb.defuseResetsIfInterrupted) b.defuseProgress = 0;
      if (b.state === 'planted') {
        b.timer--;
        if (b.timer <= 0) {
          b.state = 'exploded';
          ev({ k: 'explode', x: b.x, y: b.y });
          for (const v of alive()) if (dist(v, b) <= cfg.bomb.blastRadius) kill(v, null, 'bomb');
        }
      }
    }
    ended = checkEnd();
    if (!ended && state.turn >= cfg.round.maxTurns && b.state !== 'planted') ended = { winner: 'CT', reason: 'time' };
  }

  for (const s of state.smokes) s.turns--;
  for (const f of state.fires) f.turns--;
  state.smokes = state.smokes.filter((s) => s.turns > 0);
  state.fires = state.fires.filter((f) => f.turns > 0);
  smoke = smokeTiles(state, map);
  snapshot('End of turn');

  for (const u of state.units) {
    for (const k of Object.keys(u)) if (k.startsWith('_')) delete u[k];
    u.blind = 0;
  }

  res.end = ended;
  state.lastResolution = res;
  if (ended) endRound(state, ended.winner, ended.reason);
  else {
    state.turn++;
    state.phase = 'planning';
  }
}

function endRound(state, winner, reason) {
  const cfg = state.cfg;
  const k = cfg.match.teamSize;
  const loser = other(winner);
  const rewards = { T: 0, CT: 0 };
  rewards[winner] += cfg.economy.winReward[reason] * k;
  const lb = cfg.economy.lossBonus;
  rewards[loser] += lb[Math.min(state.teams[loser].lossStreak, lb.length - 1)] * k;
  if (loser === 'T' && state.bombEverPlanted) rewards.T += cfg.economy.plantBonus * k;
  state.teams[loser].lossStreak++;
  state.teams[winner].lossStreak = 0;
  for (const side of SIDES) {
    const t = state.teams[side];
    t.money = Math.min(t.money + rewards[side], cfg.economy.maxMoney * k);
  }
  for (const u of state.units) state.teams[u.side].gear[u.n - 1] = u.alive ? pickGear(u) : defaultGear(cfg, u.side);
  const wp = state.sideOf.indexOf(winner);
  state.score[wp]++;
  state.history.push({ round: state.round, winner, reason, winnerPlayer: wp, turns: state.turn });
  state.roundResult = { winner, reason, rewards, winnerPlayer: wp };
  state.pending = { T: null, CT: null };
  state.phase = 'roundEnd';
  if (state.score[wp] >= cfg.match.roundsToWin) {
    state.phase = 'matchEnd';
    state.matchWinner = wp;
  }
}

// ---------- fog-of-war views ----------

const ownUnit = (u) => ({
  id: u.id, side: u.side, n: u.n, x: u.x, y: u.y, hp: u.hp, alive: u.alive,
  primary: u.primary, secondary: u.secondary, armor: u.armor, helmet: u.helmet, kit: u.kit,
  utility: [...u.utility], hidden: u.hidden, hasBomb: u.hasBomb,
});

const enemyUnit = (cfg, u) => ({
  id: u.id, side: u.side, n: u.n, x: u.x, y: u.y, alive: u.alive, hp: u.hp,
  weapon: weaponId(u), armor: u.armor, helmet: u.helmet, wounded: isWounded(cfg, u),
});

function bombFor(state, side, bomb, visibleIds, visibleTile) {
  if (!bomb) return null;
  if (side === 'T' || state.phase === 'roundEnd' || state.phase === 'matchEnd') return { ...bomb };
  const pub = { state: 'unknown' };
  if (['defused', 'exploded'].includes(bomb.state)) return { state: bomb.state, x: bomb.x, y: bomb.y };
  if (bomb.state === 'planted' && (state.cfg.bomb.plantRevealsToCT || visibleTile(bomb.x, bomb.y)))
    return { state: 'planted', x: bomb.x, y: bomb.y, site: bomb.site, timer: bomb.timer, defuseProgress: bomb.defuseProgress };
  if (bomb.state === 'dropped' && visibleTile(bomb.x, bomb.y)) return { state: 'dropped', x: bomb.x, y: bomb.y };
  if (bomb.state === 'carried' && visibleIds.includes(bomb.carrierId)) return { state: 'carried', carrierId: bomb.carrierId };
  return pub;
}

function filterResolution(state, res, side) {
  if (!res) return null;
  const cfg = state.cfg;
  const frames = res.frames.map((f) => {
    const vis = f.vis[side];
    return {
      label: f.label,
      tick: f.tick,
      units: f.units.filter((u) => u.side === side || vis.includes(u.id)).map((u) => (u.side === side ? u : { id: u.id, side: u.side, n: u.n, x: u.x, y: u.y, hp: u.hp, alive: u.alive })),
      smokes: f.smokes,
      fires: f.fires.map(({ x, y, r, turns }) => ({ x, y, r, turns })),
      bomb: side === 'T' ? f.bomb : f.bomb.state === 'planted' || ['defused', 'exploded'].includes(f.bomb.state) ? { state: f.bomb.state, x: f.bomb.x, y: f.bomb.y, timer: f.bomb.timer } : null,
    };
  });
  const own = (id) => !!id && id.startsWith(side);
  const visAt = (e, id) => res.frames[Math.min(e.f, res.frames.length - 1)].vis[side].includes(id);
  const events = res.events.filter((e) => {
    switch (e.k) {
      case 'shot': return true;
      case 'dmg': return own(e.u) || e.bySide === side;
      case 'kill': return own(e.u) || e.bySide === side || visAt(e, e.u);
      case 'ping': return e.to === side;
      case 'util': return true;
      case 'blind': return e.side === side || e.bySide === side;
      case 'pickup': case 'stop': return e.side === side;
      case 'bombDrop': case 'planting': return side === 'T';
      case 'plant': return side === 'T' || cfg.bomb.plantRevealsToCT;
      default: return true;
    }
  }).map((e) => {
    if (e.k === 'util' && e.side !== side) {
      const { by, from, ...rest } = e;
      return rest;
    }
    return e;
  });
  return { turn: res.turn, frames, events, end: res.end };
}

export function viewFor(state, playerIdx) {
  const cfg = state.cfg;
  const map = mapOf(state);
  const side = state.sideOf[playerIdx];
  const enemySide = other(side);
  const smoke = smokeTiles(state, map);
  const reveal = state.phase === 'roundEnd' || state.phase === 'matchEnd';
  const live = state.phase === 'planning';

  const visibleIds = live ? visibleEnemyIds(state, side, map, smoke) : reveal ? state.units.filter((u) => u.side === enemySide && u.x != null).map((u) => u.id) : [];
  const visibleTiles = live ? visibleTileString(state, side, map, smoke) : null;
  const visibleTile = (x, y) => reveal || (visibleTiles ? visibleTiles[y * map.w + x] === '1' : false);

  return {
    you: playerIdx,
    side,
    phase: state.phase,
    round: state.round,
    turn: state.turn,
    score: state.score,
    sideOf: state.sideOf,
    history: state.history,
    halftime: state.halftime,
    cfg,
    pendingCfg: state.pendingCfg,
    mapId: state.mapId,
    money: state.teams[side].money,
    lossStreak: state.teams[side].lossStreak,
    units: state.units.filter((u) => u.side === side).map(ownUnit),
    enemies: state.units.filter((u) => visibleIds.includes(u.id)).map((u) => enemyUnit(cfg, u)),
    enemyAlive: state.units.filter((u) => u.side === enemySide && u.alive).length,
    visibleTiles,
    drops: state.drops.filter((d) => visibleTile(d.x, d.y)),
    bomb: bombFor(state, side, state.bomb, visibleIds, visibleTile),
    smokes: state.smokes,
    fires: state.fires.map(({ x, y, r, turns }) => ({ x, y, r, turns })),
    mine: state.pending[side] ? (state.phase === 'setup' ? state.pending[side].spec : state.pending[side].orders ?? true) : null,
    opponentReady: !!state.pending[enemySide],
    deadline: state.deadline,
    lastResolution: filterResolution(state, state.lastResolution, side),
    roundResult: state.roundResult,
    matchWinner: state.matchWinner,
  };
}
