// Mechanics reference. Everything here is computed from the live lever config with the
// same functions the engine uses, so it stays correct as levers change.
import { DEFAULT_CONFIG, mergeConfig } from '/shared/config.js';
import { hitChanceBreakdown, computeDamage, rangeBand, heDamage, fireDamage } from '/shared/engine.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pct = (x, d = 0) => `${(100 * x).toFixed(d)}%`;
const sign = (v) => (v > 0 ? `<span class="pos">+${v}</span>` : v < 0 ? `<span class="neg">${v}</span>` : '0');

// ---------- which levers ----------
let cfg = DEFAULT_CONFIG;
let srcLabel = 'Default levers';
try {
  if (new URLSearchParams(location.search).get('src') === 'match') {
    const raw = localStorage.getItem('breach:rulesCfg');
    if (raw) {
      cfg = mergeConfig(DEFAULT_CONFIG, JSON.parse(raw));
      srcLabel = 'Levers from your current room / match';
    }
  }
} catch {}
$('#src').textContent = srcLabel;

const C = cfg.combat;
const weapons = Object.entries(cfg.items).filter(([, it]) => it.type === 'weapon');
const BAND = ['Close', 'Mid', 'Far'];
const bandRange = (b, w) => {
  const [a, m] = C.rangeBands;
  if (b === 0) return `0–${a}`;
  if (b === 1) return `${a}–${m}`;
  return w ? (w.range > m ? `${m}–${w.range}` : '—') : `${m}+`;
};
const sides = (it) => (it.sides ? it.sides.join('/') : 'Both');

// ---------- Monte Carlo of repeated steps ----------
function simulate(w, chance, target, steps, trials = 20000) {
  const killBy = new Array(steps).fill(0);
  let dmgSum = 0;
  for (let t = 0; t < trials; t++) {
    let hp = target.hp;
    let dealt = 0;
    for (let s = 0; s < steps; s++) {
      for (let k = 0; k < w.shots && hp > 0; k++) {
        if (Math.random() * 100 < chance) {
          const d = computeDamage(cfg, w, target, Math.random() < w.headshot, Math.random());
          hp -= d;
          if (s === 0) dealt += d;
        }
      }
      if (hp <= 0) {
        for (let r = s; r < steps; r++) killBy[r]++;
        break;
      }
    }
    dmgSum += dealt;
  }
  return { killBy: killBy.map((k) => k / trials), avgStep1: dmgSum / trials };
}

const dmgRange = (w, target, hs) => [computeDamage(cfg, w, target, hs, 0), computeDamage(cfg, w, target, hs, 0.5), computeDamage(cfg, w, target, hs, 0.999999)];

// ---------- calculator ----------
const inputs = {
  weapon: 'ak47',
  distance: 7,
  stance: 'hold',
  hidden: false,
  wounded: false,
  armor: 'helmet',
  hp: C.hp,
  cover: false,
  ran: false,
};

function renderInputs() {
  const opts = weapons.map(([id, w]) => `<option value="${id}" ${id === inputs.weapon ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
  $('#calc-inputs').innerHTML = `
    <h3 style="margin-top:0">Shooter</h3>
    <label>Weapon <select data-k="weapon">${opts}</select></label>
    <label>Distance <span><input type="range" min="1" max="30" step="1" data-k="distance" value="${inputs.distance}"/> <b id="dist-v">${inputs.distance}</b></span></label>
    <label>This step the shooter…
      <select data-k="stance">
        <option value="hold">Held / Hid (+${C.holdBonus})</option>
        <option value="still">Stood still, other order</option>
        <option value="walk">Walked</option>
        <option value="run">Ran</option>
      </select></label>
    <label class="cb"><input type="checkbox" data-k="hidden"/> Firing from Hidden (+${C.hiddenShooterBonus})</label>
    <label class="cb"><input type="checkbox" data-k="wounded"/> Shooter wounded (−${C.woundedAccuracyPenalty})</label>
    <h3>Target</h3>
    <label>Armor
      <select data-k="armor">
        <option value="none">None</option>
        <option value="kevlar">Kevlar</option>
        <option value="helmet">Kevlar + Helmet</option>
      </select></label>
    <label>HP <input type="number" min="1" max="${C.hp}" data-k="hp" value="${inputs.hp}"/></label>
    <label class="cb"><input type="checkbox" data-k="cover"/> Target on a cover tile (−${C.targetInCoverPenalty})</label>
    <label class="cb"><input type="checkbox" data-k="ran"/> Target ran this step (−${C.targetRunningPenalty})</label>`;
  $('#calc-inputs').querySelector('[data-k=stance]').value = inputs.stance;
  $('#calc-inputs').querySelector('[data-k=armor]').value = inputs.armor;
  for (const k of ['hidden', 'wounded', 'cover', 'ran']) $('#calc-inputs').querySelector(`[data-k=${k}]`).checked = inputs[k];
}

$('#calc-inputs').addEventListener('input', (e) => {
  const k = e.target.dataset.k;
  if (!k) return;
  inputs[k] = e.target.type === 'checkbox' ? e.target.checked : ['distance', 'hp'].includes(k) ? Number(e.target.value) : e.target.value;
  if (k === 'hidden' && inputs.hidden) inputs.stance = 'hold';
  if (k === 'distance') $('#dist-v').textContent = inputs.distance;
  if (k === 'hidden') $('#calc-inputs').querySelector('[data-k=stance]').value = inputs.stance;
  renderCalc();
});

function renderCalc() {
  const w = cfg.items[inputs.weapon];
  const target = { armor: inputs.armor !== 'none', helmet: inputs.armor === 'helmet', hp: inputs.hp };
  const bd = hitChanceBreakdown(cfg, w, {
    distance: inputs.distance,
    shooterMove: inputs.stance === 'run' ? 'run' : inputs.stance === 'walk' ? 'walk' : null,
    shooterHolding: inputs.stance === 'hold',
    shooterHidden: inputs.hidden,
    shooterWounded: inputs.wounded,
    targetInCover: inputs.cover,
    targetRan: inputs.ran,
  });
  const out = $('#calc-out');
  if (inputs.distance > w.range) {
    out.innerHTML = `<p class="warn">Out of range — the ${esc(w.name)} reaches ${w.range} tiles. A unit only fires at enemies it can see within its weapon's range.</p>`;
    return;
  }
  const p = bd.chance / 100;
  const body = dmgRange(w, target, false);
  const head = dmgRange(w, target, true);
  const sim = simulate(w, bd.chance, target, cfg.round.ticksPerTurn);
  const pAnyHit = 1 - (1 - p) ** w.shots;
  const clampNote = bd.raw !== bd.chance ? ` <span class="note">(raw ${bd.raw}, clamped to ${C.minHitChance}–${C.maxHitChance})</span>` : '';
  out.innerHTML = `
    <div class="big">Hit on d100 ≤ ${bd.chance}</div>
    <div class="bar"><i style="width:${bd.chance}%;background:var(--green)"></i><i style="flex:1;background:#3a2523"></i></div>
    <div class="note">Rolls 1–${bd.chance} hit, ${bd.chance + 1}–100 miss. ${esc(w.name)} fires ${w.shots} shot${w.shots > 1 ? 's' : ''} per step; each shot rolls separately.</div>
    <table>
      <tr><th class="l">Hit chance</th><th>Points</th></tr>
      ${bd.parts.map(([k, v], i) => `<tr><td class="l">${esc(k)}</td><td>${i === 0 ? v : sign(v)}</td></tr>`).join('')}
      <tr class="total"><td class="l">d100 target</td><td>${bd.chance}${clampNote}</td></tr>
    </table>
    <table>
      <tr><th class="l">On a hit</th><th>Chance</th><th>Min</th><th>Avg</th><th>Max</th></tr>
      <tr><td class="l">Body hit</td><td>${pct(1 - w.headshot)}</td><td>${body[0]}</td><td>${body[1]}</td><td>${body[2]}</td></tr>
      <tr><td class="l">Headshot</td><td>${pct(w.headshot)}</td><td>${head[0]}</td><td>${head[1]}</td><td>${head[2]}</td></tr>
    </table>
    <div class="kpis">
      <div class="kpi"><div class="v">${pct(pAnyHit)}</div><div class="k">≥1 hit this step</div></div>
      <div class="kpi"><div class="v">${sim.avgStep1.toFixed(1)}</div><div class="k">avg damage per step</div></div>
      <div class="kpi"><div class="v">${pct(sim.killBy[0])}</div><div class="k">kill this step (${inputs.hp} HP)</div></div>
      <div class="kpi"><div class="v">${pct(sim.killBy[sim.killBy.length - 1])}</div><div class="k">kill within a turn (${cfg.round.ticksPerTurn} steps)</div></div>
    </div>
    <div class="note">Kill odds are a 20,000-trial simulation assuming the same conditions every step and an uninterrupted duel (no return fire). By step: ${sim.killBy.map((k, i) => `${i + 1}: ${pct(k)}`).join(' · ')}.</div>`;
}

// ---------- static sections ----------

function shotSection() {
  $('#shot-body').innerHTML = `
  <p>Units fire automatically during resolution. In each step, every unit that can fire picks a target, then rolls once per shot.</p>
  <ol>
    <li><b>Can it fire?</b> It must be alive, not blinded${C.plantDefuseCanFire ? '' : ', and not planting or defusing'}, with at least one enemy it can <a href="#vision">see</a> within its weapon's range.</li>
    <li><b>Target.</b> The closest visible enemy in range. Ties go to the lower-HP enemy, then by unit ID. A unit fires at one target per step.</li>
    <li><b>Hit chance</b> (the d100 target number):
      <pre class="formula">band   = Close if distance ≤ ${C.rangeBands[0]}, Mid if ≤ ${C.rangeBands[1]}, else Far
target = weapon.accuracy[band]
         − ${C.runPenalty} × weapon.movePenaltyMult   if the shooter ran this step
         − ${C.walkPenalty} × weapon.movePenaltyMult   if the shooter walked this step
         + ${C.holdBonus}   if the shooter's order is Hold or Hide
         + ${C.hiddenShooterBonus}   if the shooter is Hidden when it fires
         − ${C.targetInCoverPenalty}   if the target stands on a cover tile
         − ${C.targetRunningPenalty}   if the target ran this step
         − ${C.woundedAccuracyPenalty}   if the shooter is wounded (HP ≤ ${C.woundThreshold})
target = round(target), clamped to ${C.minHitChance}–${C.maxHitChance}
hit    = d100 roll ≤ target</pre>
      Distance is straight-line between tile centres: <code>√(dx² + dy²)</code>, so a diagonal neighbour is 1.41.</li>
    <li><b>Headshot.</b> Each hit has a <code>weapon.headshot</code> chance of being a headshot.</li>
    <li><b>Damage</b> per hit:
      <pre class="formula">dmg = weapon.damage × uniform(${1 - C.damageVariance}, ${1 + C.damageVariance})
body hit:  × weapon.armorPen  if the target has Kevlar
headshot:  × ${C.headshotMultiplier}  with no helmet
           × ${C.headshotMultiplierHelmet} × weapon.armorPen  with a helmet
dmg = max(1, round(dmg))</pre></li>
    <li><b>Burst.</b> A weapon fires <code>weapon.shots</code> shots per step at the same target. It stops early once that target's pending damage would kill it.</li>
    <li><b>Simultaneity.</b> ${C.initiative ? `Units on <b>Hold</b> or <b>Hide</b> fire first, as one group; damage applies and casualties are removed. Then everyone else fires as a second group. Within a group all shots are simultaneous, so two units can kill each other in the same group.` : 'All units fire simultaneously; damage is applied after everyone has fired.'}</li>
    <li><b>Aftermath.</b> ${C.hiddenBreaksOnFire ? 'Firing breaks Hidden. ' : ''}Every shot makes gunfire noise: enemies within ${cfg.noise.gunfireRadius} tiles get a ping at the shooter's tile. A unit at HP ≤ ${C.woundThreshold} is <b>wounded</b>: −${C.woundedAccuracyPenalty} accuracy and −${cfg.movement.woundedPenalty} tiles of movement. At 0 HP it dies and drops its main gun (or pistol), grenades, kit and the bomb.</li>
  </ol>`;
}

function modsSection() {
  const rows = [
    ['Shooter ran this step', `−${C.runPenalty} × move mult`, 'Only steps in which the unit actually moved. A unit that stopped on contact counts as still.'],
    ['Shooter walked this step', `−${C.walkPenalty} × move mult`, 'Each weapon has its own move multiplier (weapon table): low for SMGs and pistols, high for snipers.'],
    ['Shooter on Hold / Hide', `+${C.holdBonus}`, 'Also fires in the first initiative group.'],
    ['Shooter firing from Hidden', `+${C.hiddenShooterBonus}`, 'Stacks with Hold/Hide. Hidden is lost after firing.'],
    ['Target on a cover tile', `−${C.targetInCoverPenalty}`, 'Applies whether or not the target is Hidden.'],
    ['Target ran this step', `−${C.targetRunningPenalty}`, 'Walking targets are not harder to hit.'],
    ['Shooter wounded', `−${C.woundedAccuracyPenalty}`, `HP ≤ ${C.woundThreshold}.`],
    ['Floor / ceiling', `${C.minHitChance}% / ${C.maxHitChance}%`, 'Applied after all modifiers.'],
  ];
  $('#mods-body').innerHTML = `<table><tr><th class="l">Condition</th><th>Effect</th><th class="l">Notes</th></tr>${rows.map(([a, b, c]) => `<tr><td class="l">${a}</td><td>${b}</td><td class="l note">${c}</td></tr>`).join('')}</table>
  <p class="note">Range bands: Close ${bandRange(0)}, Mid ${bandRange(1)}, Far ${bandRange(2)} tiles (up to each weapon's max range).</p>`;
}

function weaponsSection() {
  const head = ['Weapon', 'Side', 'Price', 'Dmg', 'Shots/step', 'Range', 'Acc close', 'Acc mid', 'Acc far', 'Armor pen', 'HS %', 'Move mult', 'Kill $'];
  const rows = weapons.map(([, w]) => [esc(w.name), sides(w), `$${w.price}`, w.damage, w.shots, w.range, `${w.accuracy[0]}%`, w.range > C.rangeBands[0] ? `${w.accuracy[1]}%` : '—', w.range > C.rangeBands[1] ? `${w.accuracy[2]}%` : '—', pct(w.armorPen), pct(w.headshot), `×${w.movePenaltyMult ?? 1}`, `$${w.killReward}`]);
  $('#weapons-body').innerHTML = `<table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>
  <p class="note">Each unit always fires its primary if it has one, otherwise its pistol. Armor pen is the fraction of damage that gets through Kevlar (body) or a helmet (head).</p>`;
}

function matrixSection() {
  const reps = [Math.max(1, C.rangeBands[0] - 1), Math.round((C.rangeBands[0] + C.rangeBands[1]) / 2), C.rangeBands[1] + 4];
  const armors = [
    ['No armor', { armor: false, helmet: false, hp: C.hp }],
    ['Kevlar', { armor: true, helmet: false, hp: C.hp }],
    ['Helmet', { armor: true, helmet: true, hp: C.hp }],
  ];
  const steps = cfg.round.ticksPerTurn;
  let h = `<p>Baseline: shooter standing still on a non-Hold order (no bonuses), target in the open and not running, full HP. Each cell shows the hit chance, then the chance of killing the target within one turn (${steps} steps) of uninterrupted fire. Use the calculator for any other situation.</p>`;
  h += `<table><tr><th>Weapon</th>${reps.map((d, b) => `<th colspan="${armors.length + 1}">${BAND[b]} · ${d} tiles</th>`).join('')}</tr>`;
  h += `<tr><th></th>${reps.map(() => `<th>Hit</th>${armors.map(([a]) => `<th>${a}</th>`).join('')}`).join('')}</tr>`;
  for (const [, w] of weapons) {
    h += `<tr><td>${esc(w.name)}</td>`;
    for (const d of reps) {
      if (d > w.range) {
        h += `<td>—</td>${armors.map(() => '<td>—</td>').join('')}`;
        continue;
      }
      const ch = hitChanceBreakdown(cfg, w, { distance: d }).chance;
      h += `<td>${ch}%</td>`;
      for (const [, t] of armors) {
        const s = simulate(w, ch, t, steps, 4000);
        h += `<td>${pct(s.killBy[steps - 1])}</td>`;
      }
    }
    h += '</tr>';
  }
  h += '</table><p class="note">Kill odds are 4,000-trial simulations, so expect ±1–2% noise between page loads.</p>';
  $('#matrix-body').innerHTML = h;
}

function turnSection() {
  const T = cfg.round.ticksPerTurn;
  const split = (L) => Array.from({ length: T }, (_, k) => Math.floor(((k + 1) * L) / T) - Math.floor((k * L) / T)).join('-');
  $('#turn-body').innerHTML = `
  <p>Both players lock in orders, then the turn resolves in this order:</p>
  <ol>
    <li><b>Orders take effect.</b> Hide makes a unit on cover Hidden for the turn. Any other order (including Hold) clears Hidden.</li>
    <li><b>Utility.</b> All grenades land before anyone moves (see <a href="#utility">Utility</a>).</li>
    <li><b>${T} steps.</b> Each step runs:
      <ol type="a">
        <li><b>Stop on contact.</b> A moving unit with the option on halts for the rest of the turn once it can see an enemy within its weapon's range.</li>
        <li><b>Move.</b> Run = ${cfg.movement.run} tiles, Walk = ${cfg.movement.walk} (−${cfg.movement.woundedPenalty} when wounded), spread evenly over the steps. For example, a full run is ${split(cfg.movement.run)} tiles and a full walk is ${split(cfg.movement.walk)}. Running makes footstep noise every step it moves. Diagonal steps cost 1 but can't cut wall corners.</li>
        <li><b>Fire damage</b> (molotov / incendiary) to anyone standing in flames.</li>
        <li><b>Combat</b>: the two initiative groups, as in <a href="#shot">How a shot resolves</a>.</li>
        <li><b>Pickups.</b> Ts grab a dropped bomb. Units swap to a more expensive primary (or pistol, if they have no primary) and take grenades and kits that fit.</li>
        <li>Blindness counts down one step. The round ends immediately if one side is eliminated.</li>
      </ol></li>
    <li><b>End of turn.</b> Plant or defuse progress for units that stayed still all turn, then the bomb timer ticks. Smokes and fires lose a turn. CTs win if turn ${cfg.round.maxTurns} ends with no plant.</li>
  </ol>`;
}

function visionSection() {
  const V = cfg.vision;
  const N = cfg.noise;
  $('#vision-body').innerHTML = `
  <ul>
    <li><b>Seeing</b> needs a clear straight line between tile centres: no wall or smoke tile in between. Range is ${V.range} tiles. Vision is all-around (no facing). Fog of war hides everything your units can't currently see.</li>
    <li><b>Hidden</b>: a unit with a Hide order on a cover tile can only be seen by enemies within ${V.hiddenRevealDistance} tiles${V.hiddenRevealDistance >= 1.41 && V.hiddenRevealDistance < 2 ? ' (adjacent, including diagonal)' : ''}. Hidden ends when the unit fires${C.hiddenBreaksOnFire ? '' : ' (off with current levers)'}, is flashed, takes HE damage, or stands in fire. Units placed on cover during setup can start Hidden, and stay Hidden if their order is Hide (the default for them).</li>
    <li><b>Noise pings</b> reveal a tile, not a unit: running steps heard within ${N.runRadius} tiles, gunfire within ${N.gunfireRadius}, grenade throws within ${N.utilityRadius} (at the thrower's tile). Walls don't block sound. Walking is silent.</li>
  </ul>`;
}

function utilitySection() {
  const U = cfg.utility;
  const R = Math.ceil(U.he.radius);
  let heRows = '';
  for (let d = 0; d <= R; d += 0.5) {
    if (d > U.he.radius) break;
    heRows += `<tr><td>${d}</td><td>${heDamage(cfg, d, {})}</td><td>${heDamage(cfg, d, { armor: true })}</td><td>${heDamage(cfg, d, { hidden: true })}</td><td>${heDamage(cfg, d, { hidden: true, armor: true })}</td></tr>`;
  }
  $('#utility-body').innerHTML = `
  <p>Grenades are thrown at the start of the turn, before movement, by a unit that stays still that turn. The target tile must be within ${U.throwRange} tiles with a clear throw line (walls block; smoke doesn't). A unit carries up to ${U.maxTotal} grenades (max per type: ${Object.entries(U.maxPerType).map(([k, v]) => `${k} ${v}`).join(', ')}).</p>
  <h3>Smoke</h3><p>Fills a radius of ${U.smoke.radius} for ${U.smoke.turns} turns (the throw turn counts). Blocks sight lines through it, both ways.</p>
  <h3>Flashbang</h3><p>Blinds every unit within ${U.flash.radius} tiles that has line of sight to the burst${U.flash.friendlyFire ? ', <b>including your own</b>' : ''}. A blinded unit can't fire for ${U.flash.blindTicks} steps and loses Hidden.</p>
  <h3>HE grenade</h3>
  <p>Damages everyone within ${U.he.radius} tiles with line of sight to the blast (walls block):</p>
  <pre class="formula">dmg = ${U.he.damage} × (1 − distance / ${U.he.radius + 1}) × ${U.hiddenDamageMultiplier} if Hidden × ${U.armorMultiplier} if armored</pre>
  <table style="max-width:560px"><tr><th>Distance</th><th>Open</th><th>Armored</th><th>Hidden</th><th>Hidden + armored</th></tr>${heRows}</table>
  <p>It reveals Hidden units it hits. Kill reward $${U.he.killReward}.</p>
  <h3>Molotov / Incendiary</h3>
  <p>Burns a radius of ${U.molotov.radius} for ${U.molotov.turns} turns. Anyone inside at a step takes ${fireDamage(cfg, {})} damage (${fireDamage(cfg, { armor: true })} armored, ${fireDamage(cfg, { hidden: true })} Hidden). Fire reveals Hidden units. Over a full turn in the fire that's ${fireDamage(cfg, {}) * cfg.round.ticksPerTurn} damage unarmored. Kill reward $${U.molotov.killReward}.</p>`;
}

function bombSection() {
  const B = cfg.bomb;
  $('#bomb-body').innerHTML = `<ul>
    <li><b>Plant</b>: the carrier spends ${B.plantTurns} full turn${B.plantTurns > 1 ? 's' : ''} on a site tile with the Plant order, without moving. If the carrier dies, the bomb drops; Ts always know where it is.</li>
    <li><b>Timer</b>: detonates at the end of the ${B.timerTurns}th turn after the plant turn. Anyone within ${B.blastRadius} tiles dies. ${B.plantRevealsToCT ? 'CTs are told where it was planted.' : 'CTs must find it.'}</li>
    <li><b>Defuse</b>: a CT within ${B.defuseRange} tile${B.defuseRange > 1 ? 's' : ''} on Defuse, stationary for the whole turn: ${B.defuseTurns} turns, or ${B.defuseTurnsWithKit} with a kit. Defusing completes before the timer ticks, so finishing on the last turn wins. ${B.defuseResetsIfInterrupted ? 'Progress resets if no one defuses for a turn.' : ''}</li>
    <li>Ts win by detonation or eliminating all CTs. CTs win by defusing, eliminating all Ts before a plant, or reaching turn ${cfg.round.maxTurns} with no plant.</li>
  </ul>`;
}

function economySection() {
  const E = cfg.economy;
  const n = cfg.match.teamSize;
  $('#economy-body').innerHTML = `
  <p>Money is a single team bank. The per-unit amounts below are multiplied by the team size (${n}).</p>
  <table style="max-width:560px">
    <tr><th class="l">Item</th><th>Per unit</th><th>Team (×${n})</th></tr>
    <tr><td class="l">Start of each half</td><td>$${E.startMoney}</td><td>$${E.startMoney * n}</td></tr>
    <tr><td class="l">Win — elimination / time</td><td>$${E.winReward.elimination} / $${E.winReward.time}</td><td>$${E.winReward.elimination * n} / $${E.winReward.time * n}</td></tr>
    <tr><td class="l">Win — bomb / defuse</td><td>$${E.winReward.bomb} / $${E.winReward.defuse}</td><td>$${E.winReward.bomb * n} / $${E.winReward.defuse * n}</td></tr>
    ${E.lossBonus.map((v, i) => `<tr><td class="l">Loss ${i + 1}${i === E.lossBonus.length - 1 ? '+' : ''} in a row</td><td>$${v}</td><td>$${v * n}</td></tr>`).join('')}
    <tr><td class="l">Ts lose after planting</td><td>+$${E.plantBonus}</td><td>+$${E.plantBonus * n}</td></tr>
    <tr><td class="l">Bank cap</td><td>$${E.maxMoney}</td><td>$${E.maxMoney * n}</td></tr>
  </table>
  <p>Kill rewards (per weapon, in the weapon table) go to the team bank immediately. Survivors keep all their gear into the next round; dead units respawn with only the default pistol. A win resets the loss streak. Sides swap after round ${cfg.match.halftimeAfterRound}, and money and gear reset. First to ${cfg.match.roundsToWin} wins.</p>`;
}

renderInputs();
renderCalc();
shotSection();
modsSection();
weaponsSection();
turnSection();
visionSection();
utilitySection();
bombSection();
economySection();
setTimeout(matrixSection, 0);
$('#matrix-body').innerHTML = '<p class="note">Simulating…</p>';
