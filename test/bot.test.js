import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, submitSetup, submitOrders, ackRoundEnd, viewFor } from '../shared/engine.js';
import { botSetup, botOrders } from '../shared/bot.js';

// Plays a full match with a bot on each seat. Every bot submission must be valid.
export function botMatch(seed, diff = ['normal', 'normal'], config) {
  const state = createMatch({ seed, config });
  const mem = [{ rng: seed * 31 + 1 }, { rng: seed * 17 + 5 }];
  const outcomes = [];
  let guard = 0;
  while (state.phase !== 'matchEnd' && guard++ < 3000) {
    for (const seat of [0, 1]) {
      const side = state.sideOf[seat];
      if (state.pending[side]) continue;
      const view = viewFor(state, seat);
      if (state.phase === 'setup') {
        const r = submitSetup(state, side, botSetup(view, mem[seat], diff[seat]));
        assert.ok(r.ok, `setup rejected: ${r.error}`);
      } else if (state.phase === 'planning') {
        const r = submitOrders(state, side, botOrders(view, mem[seat], diff[seat]));
        assert.ok(r.ok, `orders rejected: ${r.error}`);
      } else if (state.phase === 'roundEnd') {
        if (seat === 1) outcomes.push(state.roundResult);
        ackRoundEnd(state, side);
      }
    }
  }
  if (state.roundResult) outcomes.push(state.roundResult);
  return { state, outcomes };
}

test('bot vs bot matches complete with only valid submissions', () => {
  const tally = {};
  let turns = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const { state, outcomes } = botMatch(seed);
    assert.equal(state.phase, 'matchEnd', `seed ${seed}`);
    for (const o of outcomes) tally[`${o.winner}:${o.reason}`] = (tally[`${o.winner}:${o.reason}`] || 0) + 1;
    turns += state.history.length;
  }
  console.log('normal vs normal outcomes:', tally);
});

test('normal bot beats easy bot more often than not', () => {
  let normalWins = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const { state } = botMatch(seed, ['normal', 'easy']);
    if (state.matchWinner === 0) normalWins++;
  }
  console.log(`normal beat easy in ${normalWins}/20 matches`);
  assert.ok(normalWins >= 11, `normal only won ${normalWins}/20`);
});
