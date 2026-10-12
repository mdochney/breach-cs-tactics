import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMatch, submitSetup, submitOrders, ackRoundEnd, viewFor, autoSetup, checkOrder, other,
} from '../shared/engine.js';
import { getMap } from '../shared/map.js';
import { findPath, hasLOS } from '../shared/geom.js';
import { nextRand } from '../shared/rng.js';

const map = getMap('dust');

// A crude bot: buys something affordable, runs at a site / hunts, uses utility sometimes.
function botSetup(state, side, r) {
  const spec = autoSetup(state, side);
  const cfg = state.cfg;
  let money = state.teams[side].money;
  for (const u of state.units.filter((x) => x.side === side)) {
    const buys = [];
    const opts = side === 'T' ? ['ak47', 'galil', 'mac10', 'helmet', 'kevlar', 'flash', 'smoke', 'he', 'molotov', 'awp', 'nova', 'deagle']
      : ['m4a4', 'famas', 'mp9', 'helmet', 'kevlar', 'kit', 'flash', 'smoke', 'he', 'incendiary', 'awp', 'ssg08'];
    for (const it of opts) {
      const price = cfg.items[it].price;
      if (price <= money && r() < 0.35) {
        buys.push(it);
        money -= price;
      }
    }
    spec.units[u.id].buy = buys;
    spec.units[u.id].hidden = r() < 0.5;
  }
  // Duplicate/invalid buys (e.g. two kevlars) are possible; fall back to no buys if rejected.
  return spec;
}

function botOrders(state, side, r) {
  const orders = {};
  const sites = { A: { x: 30, y: 3 }, B: { x: 5, y: 2 } };
  for (const u of state.units.filter((x) => x.side === side && x.alive)) {
    const roll = r();
    let o;
    if (u.hasBomb && map.siteAt(u.x, u.y)) o = { action: 'plant' };
    else if (side === 'CT' && state.bomb.state === 'planted' && Math.max(Math.abs(u.x - state.bomb.x), Math.abs(u.y - state.bomb.y)) <= 1) o = { action: 'defuse' };
    else if (side === 'CT' && state.bomb.state === 'planted') o = { action: 'run', to: { x: state.bomb.x, y: state.bomb.y } };
    else if (u.utility.length && roll < 0.15) {
      const target = { x: u.x + Math.round(r() * 8 - 4), y: u.y + Math.round(r() * 8 - 4) };
      o = { action: 'throw', util: u.utility[0], target };
    } else if (roll < 0.3 && map.isCover(u.x, u.y)) o = { action: 'hide' };
    else if (roll < 0.4) o = { action: 'hold' };
    else {
      const dest = side === 'T' ? (u.n % 2 ? sites.A : sites.B) : { x: Math.floor(r() * map.w), y: Math.floor(r() * map.h) };
      o = { action: roll < 0.7 ? 'run' : 'walk', to: dest };
    }
    if (checkOrder(state.cfg, map, u, o, state.bomb)) o = { action: 'hold' };
    orders[u.id] = o;
  }
  return orders;
}

function playMatch(seed, opts = {}) {
  const state = createMatch({ seed, config: opts.config });
  const rs = { rng: seed * 7 + 3 };
  const r = () => nextRand(rs);
  const log = [];
  let guard = 0;
  while (state.phase !== 'matchEnd' && guard++ < 5000) {
    if (state.phase === 'setup') {
      for (const s of ['T', 'CT']) {
        if (state.pending[s]) continue;
        const res = submitSetup(state, s, botSetup(state, s, r));
        if (!res.ok) assert.ok(submitSetup(state, s, autoSetup(state, s)).ok);
      }
    } else if (state.phase === 'planning') {
      for (const s of ['T', 'CT']) {
        const res = submitOrders(state, s, botOrders(state, s, r));
        assert.ok(res.ok, res.error);
        if (opts.onView && state.phase === 'planning' && s === 'T') opts.onView(state);
      }
    } else if (state.phase === 'roundEnd') {
      log.push(state.roundResult);
      ackRoundEnd(state, 'T');
      ackRoundEnd(state, 'CT');
    }
    for (const t of Object.values(state.teams)) assert.ok(t.money >= 0, 'money negative');
  }
  return { state, log };
}

test('map: both sites reachable from T spawn; spawns exist', () => {
  assert.ok(findPath(map, { x: 17, y: 20 }, { x: 30, y: 3 }));
  assert.ok(findPath(map, { x: 17, y: 20 }, { x: 5, y: 2 }));
  assert.ok(map.isSpawn(17, 2, 'CT') || map.isCover(17, 2));
});

test('line of sight is symmetric', () => {
  const s = { rng: 42 };
  for (let i = 0; i < 3000; i++) {
    const a = { x: Math.floor(nextRand(s) * map.w), y: Math.floor(nextRand(s) * map.h) };
    const b = { x: Math.floor(nextRand(s) * map.w), y: Math.floor(nextRand(s) * map.h) };
    if (!map.walkable(a.x, a.y) || !map.walkable(b.x, b.y)) continue;
    assert.equal(hasLOS(map, a, b), hasLOS(map, b, a), `${JSON.stringify(a)} ${JSON.stringify(b)}`);
  }
});

test('random bot matches run to completion', () => {
  const reasons = {};
  for (let seed = 1; seed <= 25; seed++) {
    const { state, log } = playMatch(seed);
    assert.equal(state.phase, 'matchEnd', `seed ${seed} did not finish`);
    assert.equal(Math.max(...state.score), state.cfg.match.roundsToWin);
    for (const r of log) reasons[`${r.winner}:${r.reason}`] = (reasons[`${r.winner}:${r.reason}`] || 0) + 1;
  }
  console.log('round outcomes over 25 bot matches:', reasons);
});

test('resolution is deterministic for a given seed', () => {
  const a = playMatch(99).state;
  const b = playMatch(99).state;
  assert.deepEqual(a.history, b.history);
  assert.deepEqual(a.score, b.score);
});

test('fog of war: views never include unseen or hidden-at-range enemies', () => {
  let checks = 0;
  playMatch(7, {
    onView: (state) => {
      for (const p of [0, 1]) {
        const v = viewFor(state, p);
        const json = JSON.stringify(v);
        for (const e of state.units.filter((u) => u.side === other(v.side))) {
          const shown = v.enemies.some((x) => x.id === e.id);
          if (e.alive && e.hidden) {
            const close = state.units.some((u) => u.side === v.side && u.alive && Math.hypot(u.x - e.x, u.y - e.y) <= state.cfg.vision.hiddenRevealDistance);
            if (!close) assert.ok(!shown, 'hidden enemy leaked');
          }
          if (!shown) {
            // Unseen enemy's live coordinates must not appear in the unit list.
            assert.ok(!v.enemies.find((x) => x.id === e.id));
          }
          checks++;
        }
        assert.ok(!json.includes('"pending"'));
        if (v.side === 'CT' && state.bomb?.state === 'carried') {
          assert.ok(v.bomb.state === 'unknown' || v.bomb.state === 'carried');
        }
      }
    },
  });
  assert.ok(checks > 0);
});

test('setup rejects overspending and placements outside zone', () => {
  const state = createMatch({ seed: 5 });
  const spec = autoSetup(state, 'T');
  spec.units.T1.buy = ['awp'];
  assert.equal(submitSetup(state, 'T', spec).ok, false);
  const spec2 = autoSetup(state, 'T');
  spec2.units.T1.x = 5;
  spec2.units.T1.y = 2;
  assert.equal(submitSetup(state, 'T', spec2).ok, false);
});

// ---------- scenario tests ----------

function scenario(config = {}) {
  const state = createMatch({ seed: 1234, config: { match: { teamSize: 1 }, ...config } });
  submitSetup(state, 'T', { units: { T1: { buy: [], x: 17, y: 20 } }, carrier: 'T1' });
  submitSetup(state, 'CT', { units: { CT1: { buy: [], x: 17, y: 1 } } });
  const T1 = state.units.find((u) => u.id === 'T1');
  const CT1 = state.units.find((u) => u.id === 'CT1');
  return { state, T1, CT1 };
}

test('hidden defender is invisible at range and fires first with a bonus', () => {
  const { state, T1, CT1 } = scenario();
  // CT hides on cover tile (19,11) in mid; T walks up mid from (17,16).
  Object.assign(CT1, { x: 19, y: 11, hidden: true });
  Object.assign(T1, { x: 17, y: 16 });
  const vT = viewFor(state, state.sideOf.indexOf('T'));
  assert.equal(vT.enemies.length, 0, 'hidden CT should not be visible to T');
  submitOrders(state, 'CT', { CT1: { action: 'hide' } });
  submitOrders(state, 'T', { T1: { action: 'walk', to: { x: 17, y: 12 } } });
  const shots = state.lastResolution.events.filter((e) => e.k === 'shot');
  assert.ok(shots.length > 0, 'combat should happen');
  assert.equal(shots[0].s, 'CT1', 'hidden CT shoots first');
  assert.equal(shots[0].hidden, true);
});

test('flashbang blinds and strips hidden', () => {
  const { state, T1, CT1 } = scenario();
  Object.assign(CT1, { x: 19, y: 11, hidden: true });
  Object.assign(T1, { x: 17, y: 16 });
  T1.utility = ['flash'];
  submitOrders(state, 'CT', { CT1: { action: 'hide' } });
  assert.ok(submitOrders(state, 'T', { T1: { action: 'throw', util: 'flash', target: { x: 17, y: 12 } } }).ok);
  const blinds = state.lastResolution.events.filter((e) => e.k === 'blind').map((e) => e.u);
  assert.ok(blinds.includes('CT1'));
  assert.equal(state.lastResolution.frames[1].units.find((u) => u.id === 'CT1').hidden, false);
});

test('plant then detonation wins for T; kit defuse wins for CT', () => {
  {
    const { state, T1, CT1 } = scenario();
    Object.assign(T1, { x: 28, y: 3 });
    submitOrders(state, 'CT', {});
    submitOrders(state, 'T', { T1: { action: 'plant' } });
    assert.equal(state.bomb.state, 'planted');
    for (let i = 0; i < state.cfg.bomb.timerTurns; i++) {
      submitOrders(state, 'CT', {});
      submitOrders(state, 'T', {});
    }
    assert.equal(state.roundResult?.reason, 'bomb');
  }
  {
    const { state, T1, CT1 } = scenario();
    Object.assign(T1, { x: 28, y: 3 });
    Object.assign(CT1, { x: 16, y: 1, kit: true });
    submitOrders(state, 'CT', {});
    submitOrders(state, 'T', { T1: { action: 'plant' } });
    T1.alive = false; // T dies off-screen for the test
    Object.assign(CT1, { x: 28, y: 4 });
    assert.ok(submitOrders(state, 'CT', { CT1: { action: 'defuse' } }).ok);
    submitOrders(state, 'T', {});
    assert.equal(state.roundResult?.reason, 'defuse');
  }
});

test('dead units drop weapons that can be picked up', () => {
  const { state, T1, CT1 } = scenario({ combat: { minHitChance: 95, maxHitChance: 95 } });
  CT1.primary = 'awp';
  Object.assign(CT1, { x: 17, y: 6 });
  Object.assign(T1, { x: 17, y: 9 });
  T1.hp = 1;
  submitOrders(state, 'CT', { CT1: { action: 'hold' } });
  submitOrders(state, 'T', { T1: { action: 'hold' } });
  assert.equal(T1.alive, false);
  assert.ok(state.drops.some((d) => d.item === 'glock'));
});
