// Balance simulator: CPU vs CPU matches under the current (or a given) lever config.
//   npm run sim                        # 50 matches, normal vs normal, default levers
//   npm run sim -- 200 levers.json     # 200 matches with a levers JSON exported from the game
import fs from 'node:fs';
import { createMatch, submitSetup, submitOrders, ackRoundEnd, viewFor, autoSetup } from '../shared/engine.js';
import { botSetup, botOrders } from '../shared/bot.js';

const matches = Number(process.argv[2] || 50);
const config = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : undefined;

const tally = {};
let rounds = 0;
let turns = 0;
let tWins = 0;
for (let seed = 1; seed <= matches; seed++) {
  const state = createMatch({ seed, config });
  const mem = [{ rng: seed * 31 + 1 }, { rng: seed * 17 + 5 }];
  let guard = 0;
  while (state.phase !== 'matchEnd' && guard++ < 5000) {
    for (const seat of [0, 1]) {
      const side = state.sideOf[seat];
      if (state.pending[side]) continue;
      const view = viewFor(state, seat);
      if (state.phase === 'setup') {
        if (!submitSetup(state, side, botSetup(view, mem[seat])).ok) submitSetup(state, side, autoSetup(state, side));
      } else if (state.phase === 'planning') {
        submitOrders(state, side, botOrders(view, mem[seat]));
        if (state.phase === 'planning' && !state.pending[side]) submitOrders(state, side, {});
      } else if (state.phase === 'roundEnd') ackRoundEnd(state, side);
    }
  }
  for (const h of state.history) {
    rounds++;
    turns += h.turns;
    tally[`${h.winner} ${h.reason}`] = (tally[`${h.winner} ${h.reason}`] || 0) + 1;
    if (h.winner === 'T') tWins++;
  }
}
console.log(`${matches} matches, ${rounds} rounds`);
console.log(`T round win rate: ${((100 * tWins) / rounds).toFixed(1)}%`);
console.log(`avg turns per round: ${(turns / rounds).toFixed(1)}`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(16)} ${v} (${((100 * v) / rounds).toFixed(0)}%)`);
