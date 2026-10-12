// Every tunable number in the game lives here. The host can override any of these
// from the lobby ("Levers"), either before the match or between rounds.
// Distances are in tiles. Percentages are d100 targets (roll <= chance hits).

export const DEFAULT_CONFIG = {
  match: {
    teamSize: 4, // units per side (only changes at match start)
    roundsToWin: 5,
    halftimeAfterRound: 4, // sides swap after this round; money & gear reset
    setupSeconds: 120, // 0 = no timer
    planSeconds: 60, // 0 = no timer
  },

  round: {
    maxTurns: 12, // CTs win if no plant by end of this turn
    ticksPerTurn: 4, // movement is split into this many simultaneous steps
    ctSetupZone: 'spawnAndSites', // 'spawn' | 'spawnAndSites'
  },

  movement: {
    run: 8, // tiles per turn, makes noise
    walk: 4, // tiles per turn, silent
    woundedPenalty: 2, // tiles lost when wounded
    stopOnContactDefault: true, // movers halt once an enemy is visible and in range
  },

  vision: {
    range: 30, // max sight distance (line of sight still required)
    hiddenRevealDistance: 1.5, // hidden units are seen only this close (1.5 = adjacent incl. diagonal)
  },

  noise: {
    runRadius: 8, // enemies within this radius hear a running unit (footstep ping)
    gunfireRadius: 16,
    utilityRadius: 10, // throwing utility pings the thrower's position
  },

  combat: {
    hp: 100,
    woundThreshold: 50, // at or below this HP a unit is Wounded
    woundedAccuracyPenalty: 10,
    rangeBands: [4, 10], // <= first = close, <= second = mid, else far
    runPenalty: 30, // accuracy lost if the shooter moved (running) this tick
    walkPenalty: 10,
    holdBonus: 10, // Hold / Hide stance accuracy bonus
    hiddenShooterBonus: 25, // extra accuracy when firing from Hidden
    targetInCoverPenalty: 15, // target standing on a cover tile (not hidden)
    targetRunningPenalty: 10,
    minHitChance: 5,
    maxHitChance: 95,
    damageVariance: 0.15, // +/- fraction applied to each hit
    headshotMultiplier: 4,
    headshotMultiplierHelmet: 2,
    initiative: true, // Hold/Hide units fire before movers within a tick
    hiddenBreaksOnFire: true,
    plantDefuseCanFire: false,
  },

  bomb: {
    plantTurns: 1, // full stationary turns on site to plant
    timerTurns: 4, // turns after the plant turn until detonation
    defuseTurns: 2,
    defuseTurnsWithKit: 1,
    defuseRange: 1, // tiles (Chebyshev) from the bomb
    defuseResetsIfInterrupted: true,
    plantRevealsToCT: true,
    blastRadius: 6, // units inside die on detonation
  },

  utility: {
    maxTotal: 3,
    maxPerType: { smoke: 1, flash: 2, he: 1, molotov: 1 },
    throwRange: 8,
    hiddenDamageMultiplier: 1.5, // HE / fire damage vs hidden units
    armorMultiplier: 0.6, // HE / fire damage vs armored units
    smoke: { radius: 2, turns: 2 },
    flash: { radius: 7, blindTicks: 3, friendlyFire: true },
    he: { radius: 2.5, damage: 70, killReward: 300 },
    molotov: { radius: 1.5, turns: 2, damagePerTick: 12, killReward: 300 },
  },

  economy: {
    // Per-unit amounts; the team bank receives amount x teamSize.
    startMoney: 800,
    maxMoney: 16000,
    winReward: { elimination: 3250, bomb: 3500, defuse: 3500, time: 3250 },
    lossBonus: [1400, 1900, 2400, 2900, 3400],
    plantBonus: 800, // to Ts if the bomb was planted but they lost
  },

  // Shop. accuracy = [close, mid, far] hit chance before modifiers.
  items: {
    glock: { name: 'Glock-18', type: 'weapon', slot: 'secondary', sides: ['T'], price: 200, damage: 26, armorPen: 0.47, range: 10, accuracy: [70, 48, 25], shots: 2, headshot: 0.12, killReward: 300, movePenaltyMult: 0.6 },
    usp: { name: 'USP-S', type: 'weapon', slot: 'secondary', sides: ['CT'], price: 200, damage: 30, armorPen: 0.5, range: 11, accuracy: [72, 52, 30], shots: 2, headshot: 0.14, killReward: 300, movePenaltyMult: 0.6 },
    p250: { name: 'P250', type: 'weapon', slot: 'secondary', price: 300, damage: 34, armorPen: 0.64, range: 11, accuracy: [70, 50, 28], shots: 2, headshot: 0.12, killReward: 300, movePenaltyMult: 0.6 },
    deagle: { name: 'Desert Eagle', type: 'weapon', slot: 'secondary', price: 700, damage: 55, armorPen: 0.93, range: 14, accuracy: [62, 55, 40], shots: 1, headshot: 0.2, killReward: 300, movePenaltyMult: 1.2 },
    mac10: { name: 'MAC-10', type: 'weapon', slot: 'primary', sides: ['T'], price: 1050, damage: 26, armorPen: 0.58, range: 10, accuracy: [74, 52, 25], shots: 3, headshot: 0.08, killReward: 600, movePenaltyMult: 0.5 },
    mp9: { name: 'MP9', type: 'weapon', slot: 'primary', sides: ['CT'], price: 1250, damage: 26, armorPen: 0.6, range: 10, accuracy: [76, 54, 28], shots: 3, headshot: 0.08, killReward: 600, movePenaltyMult: 0.5 },
    nova: { name: 'Nova', type: 'weapon', slot: 'primary', price: 1050, damage: 75, armorPen: 0.5, range: 5, accuracy: [82, 35, 0], shots: 1, headshot: 0.1, killReward: 900, movePenaltyMult: 0.7 },
    galil: { name: 'Galil AR', type: 'weapon', slot: 'primary', sides: ['T'], price: 1800, damage: 30, armorPen: 0.77, range: 16, accuracy: [66, 56, 42], shots: 2, headshot: 0.12, killReward: 300, movePenaltyMult: 1 },
    famas: { name: 'FAMAS', type: 'weapon', slot: 'primary', sides: ['CT'], price: 2050, damage: 30, armorPen: 0.7, range: 16, accuracy: [68, 58, 44], shots: 2, headshot: 0.12, killReward: 300, movePenaltyMult: 1 },
    ak47: { name: 'AK-47', type: 'weapon', slot: 'primary', sides: ['T'], price: 2700, damage: 36, armorPen: 0.77, range: 20, accuracy: [70, 62, 50], shots: 2, headshot: 0.16, killReward: 300, movePenaltyMult: 1 },
    m4a4: { name: 'M4A4', type: 'weapon', slot: 'primary', sides: ['CT'], price: 3100, damage: 33, armorPen: 0.7, range: 20, accuracy: [72, 64, 52], shots: 2, headshot: 0.15, killReward: 300, movePenaltyMult: 1 },
    ssg08: { name: 'SSG 08', type: 'weapon', slot: 'primary', price: 1700, damage: 88, armorPen: 0.85, range: 26, accuracy: [45, 72, 78], shots: 1, headshot: 0.2, killReward: 300, movePenaltyMult: 1.5 },
    awp: { name: 'AWP', type: 'weapon', slot: 'primary', price: 4750, damage: 115, armorPen: 0.97, range: 28, accuracy: [40, 78, 85], shots: 1, headshot: 0.2, killReward: 100, movePenaltyMult: 2.2 },
    kevlar: { name: 'Kevlar', type: 'kevlar', price: 650 },
    helmet: { name: 'Kevlar + Helmet', type: 'helmet', price: 1000, priceIfArmored: 350 },
    kit: { name: 'Defuse Kit', type: 'kit', sides: ['CT'], price: 400 },
    smoke: { name: 'Smoke', type: 'grenade', kind: 'smoke', price: 300 },
    flash: { name: 'Flashbang', type: 'grenade', kind: 'flash', price: 200 },
    he: { name: 'HE Grenade', type: 'grenade', kind: 'he', price: 300 },
    molotov: { name: 'Molotov', type: 'grenade', kind: 'molotov', sides: ['T'], price: 400 },
    incendiary: { name: 'Incendiary', type: 'grenade', kind: 'molotov', sides: ['CT'], price: 500 },
  },

  defaultPistol: { T: 'glock', CT: 'usp' },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Deep merge: overrides win; arrays replaced wholesale.
export function mergeConfig(base, over) {
  if (!isObj(over)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(out[k]) ? mergeConfig(out[k], v) : structuredClone(v);
  }
  return out;
}
