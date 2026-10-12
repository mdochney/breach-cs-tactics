// Seeded RNG (mulberry32). State lives on the game object so resolution is reproducible.

export function nextRand(state) {
  let t = (state.rng = (state.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// 1..100
export const d100 = (state) => Math.floor(nextRand(state) * 100) + 1;
