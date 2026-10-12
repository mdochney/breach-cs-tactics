# Breach — turn-based CS tactics

Live: https://breach-cs-tactics.fly.dev

Two-player, browser-based, simultaneous-turn strategy game in the style of Counter-Strike. One player commands the Terrorists (plant the bomb and hold the site until it detonates), the other the Counter-Terrorists (defend sites A and B).

## Run it

```bash
npm install
npm start            # http://localhost:8080
npm run dev          # same, restarts on file changes
npm test             # engine tests: bot matches, fog-of-war leak checks, scenarios
```

Open the page, **Create room**, and send the link to your opponent (or open it in a second browser/incognito window to play both sides).

## Playing the CPU

Use **Quick game vs CPU** on the start screen, or **Play vs CPU** in a room (Easy or Normal).

The CPU runs on the server and only sees its side's fog-of-war view, so it can't cheat.

- **Normal T**: picks a site and a route each round, groups up out of sight, then executes with flashes, molotovs and smokes. It plants and plays post-plant from cover.
- **Normal CT**: holds hidden on cover across both sites with a mid rotator. It rotates on sightings and sounds, and retakes and defuses after a plant.
- **Easy**: no utility, no hiding, everyone runs.

## Balance simulator

```bash
npm run sim                      # 50 CPU-vs-CPU matches with default levers
npm run sim -- 200 levers.json   # with levers JSON copied out of the in-game editor
```

It prints the T round win rate, the average turns per round and how rounds end. Use it to see what a lever change does before playing it.

## How a round works

1. **Setup** (simultaneous, timed). Buy gear from the team bank, place units in your zone, pick the bomb carrier (T). Units placed on cover can start **Hidden**. The CT zone includes both sites by default.
2. **Planning** (simultaneous, timed). Give each unit one order, then lock in.
   - **Run**: full move, noisy. Enemies within `noise.runRadius` hear footsteps.
   - **Walk**: half move, silent.
   - **Hold**: stand still and fire first.
   - **Hide**: on a cover tile, invisible unless an enemy is adjacent or utility reveals you. Fires first with a large accuracy bonus. Firing breaks Hidden.
   - **Plant / Defuse**: stand still for the whole turn.
   - **Throw**: smoke, flash, HE, molotov/incendiary. Resolves before anyone moves.
3. **Resolution**. The turn is split into `round.ticksPerTurn` steps. Each step runs in this order:
   1. Movers advance. A unit with "stop on contact" set halts when it can see an enemy in range.
   2. Fire damage applies.
   3. Combat resolves. Hold/Hide units shoot before movers. Shots within each group are simultaneous, so trades happen.
   4. Each shot is a d100 roll against a hit chance built from:
      - weapon accuracy by range band
      - movement penalties
      - hold, hidden and cover modifiers
      - wounds

   Headshots and armor modify damage. Dead units drop their weapon, utility and kit (and the bomb). Units auto-pick up better guns by walking over them.
4. **Round end**:

   | Condition | Winner |
   |---|---|
   | All CTs dead | T |
   | All Ts dead before a plant | CT |
   | Bomb defused | CT |
   | Bomb detonates | T |
   | Turn limit reached with no plant | CT |

   Money is paid out CS-style: win reward, loss-bonus ladder, kill rewards, plant bonus. Survivors keep their gear. Sides swap at halftime.

The combat log after each turn shows every roll ("d100 34 vs 62%: HIT 28").

## Combat mechanics page

`/rules.html` (the **Mechanics** buttons in the lobby and in-game HUD) spells out every rule with live numbers. It includes:

- the hit-chance and damage formulas
- a shot calculator: weapon, distance, stances, armor and cover → d100 target, damage range and kill odds
- the full weapon table
- a weapon-vs-armor kill-odds matrix
- utility damage tables, and the turn order, vision, bomb and economy rules

It renders from the levers in effect for your room, using the same functions the engine uses (`hitChanceBreakdown`, `computeDamage`, `heDamage`, `fireDamage` in `shared/engine.js`), so it can't drift from the actual rules.

## Fog of war

The server holds the full state. Each client receives only `viewFor(state, player)`, which contains:

- its own units
- enemies currently in line of sight (and not hidden at range)
- noise pings
- a per-turn replay filtered to what that side could perceive

Enemy money, orders and positions are never sent. At round end all positions are revealed.

## Levers

Every number lives in `shared/config.js`. The host can edit it in-game via the **Levers…** button. In the lobby, changes apply immediately. Mid-match, they apply from the next round; `teamSize` only changes at match start.

| Section | What it controls |
|---|---|
| `match` | team size, rounds to win, halftime, setup/plan timers |
| `round` | turn limit, ticks per turn, CT setup zone |
| `movement` | run/walk distance, wound penalty, stop-on-contact default |
| `vision` | sight range, how close you must be to see a hidden unit |
| `noise` | footstep / gunfire / utility hearing radii |
| `combat` | HP, range bands, every accuracy modifier, headshots, initiative |
| `bomb` | plant/defuse turns, timer, kit, blast radius |
| `utility` | carry limits, throw range, smoke/flash/HE/molotov stats, damage vs hidden |
| `economy` | start money, cap, win rewards, loss ladder, plant bonus |
| `items` | full shop: price, damage, armor pen, range, accuracy by band, shots per tick, headshot %, kill reward, move penalty |

The map is ASCII in `shared/map.js`:

| Char | Tile |
|---|---|
| `#` | wall |
| `c` | cover |
| `A` / `B` | site floor |
| `a` / `b` | site cover |
| `T` / `C` | spawn zones |
| `t` / `k` | cover inside T / CT spawn |

## Deploy to fly.io

### Automatic (GitHub Actions)

`.github/workflows/deploy.yml` runs the tests on every push to `main`, then deploys to fly.io.

1. Create a Fly org token: fly.io dashboard → Tokens, or run `fly tokens create org`.
2. Add it as a repository secret named `FLY_API_TOKEN` (GitHub → Settings → Secrets and variables → Actions).
3. Push to `main`.

On the first run, the workflow creates the app named in `fly.toml` if it doesn't exist yet. To use an org other than `personal`, set a repo variable `FLY_ORG`. Without the secret, the deploy job is skipped and only the tests run.

### Manual


```bash
fly launch --no-deploy --copy-config   # pick a unique app name; keeps fly.toml
fly deploy --ha=false                  # ONE machine: games are in memory
fly scale count 1                      # if a second machine was created anyway
```

Constraints:

- Games live in server memory, so the app must run on a single machine.
- A deploy or restart ends games in progress.
- Idle machines auto-stop, but never while a WebSocket is connected.

## Layout

```
shared/   engine.js (rules + views), config.js (levers), map.js, geom.js (LOS/pathing), rng.js (seeded)
server/   index.js — static files + WebSocket rooms, reconnect tokens, timers
public/   index.html, style.css, client.js — canvas board, setup/shop, orders, replay, log
test/     node:test suite
```

`shared/` is imported by both the server and the browser. The client uses it for path previews and order validation; the server re-validates everything.

## Next ideas

- Persistence (SQLite/Volume) so deploys don't kill games
- More maps and a map editor
- Per-unit target priority, facing / vision cones, crouch
- Spectator mode and full-match replays (resolution is already deterministic per seed)
