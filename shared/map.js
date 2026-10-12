// Map definitions. Edit the ASCII to change the layout.
//
// Legend
//   #  wall (blocks movement and vision)
//   .  floor
//   c  cover (floor; a unit here can go Hidden)
//   A  bomb site A floor      a  bomb site A cover
//   B  bomb site B floor      b  bomb site B cover
//   T  terrorist spawn / setup zone       t  T spawn cover
//   C  counter-terrorist spawn / setup zone  k  CT spawn cover

export const MAPS = {
  dust: {
    name: 'Dust (v0)',
    // Where CPU Terrorists gather before hitting each site (one route is picked per round).
    stages: {
      A: [{ x: 22, y: 7 }, { x: 32, y: 11 }],
      B: [{ x: 13, y: 7 }, { x: 3, y: 11 }],
    },
    ascii: [
      '####################################',
      '#BBBBBBBBB####CCCCCCCC####AAAAAAAAA#',
      '#BBbbBBbBB.c..CCCkCCkC..c.AAaaAAAaA#',
      '#BBBB#BBBB....CCCCCCCC....AAAAAAAAA#',
      '#BBBB##BBB######....######AAAA##AAA#',
      '#BBBBBBBBB######....######AAAAA#AAA#',
      '#BbBBBBBbB..c..........c..AaAAAAAaA#',
      '#BBBBBBBBB................AAAAAAAAA#',
      '##...###########....###########...##',
      '##...###########....###########...##',
      '##..c#############..###########.c.##',
      '##...###########...c###########...##',
      '##.#.###########....###########...##',
      '##...###########..#############...##',
      '##...###########....###########..c##',
      '##...###########c...###########...##',
      '##......c.....##....##....c.......##',
      '##............##....##............##',
      '#############TTTTTTTTTT#############',
      '#############TTTTTTTTTT#############',
      '#############TtTTTTTTtT#############',
      '#############TTTTTTTTTT#############',
      '#############TTTTTTTTTT#############',
      '####################################',
    ],
  },
};

const cache = new Map();

export function getMap(id = 'dust') {
  if (cache.has(id)) return cache.get(id);
  const def = MAPS[id];
  if (!def) throw new Error(`Unknown map ${id}`);
  const rows = def.ascii;
  const h = rows.length;
  const w = rows[0].length;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? '#' : rows[y][x]);
  const map = {
    id,
    name: def.name,
    w,
    h,
    rows,
    at,
    stages: def.stages || null,
    walkable: (x, y) => at(x, y) !== '#',
    blocksLOS: (x, y) => at(x, y) === '#',
    isCover: (x, y) => 'cabtk'.includes(at(x, y)),
    siteAt: (x, y) => {
      const c = at(x, y);
      if (c === 'A' || c === 'a') return 'A';
      if (c === 'B' || c === 'b') return 'B';
      return null;
    },
    isSpawn: (x, y, side) => (side === 'T' ? 'Tt' : 'Ck').includes(at(x, y)),
  };
  cache.set(id, map);
  return map;
}
