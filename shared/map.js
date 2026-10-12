// Map definitions. Edit the ASCII to change the layout.
//
// Legend
//   #  wall (blocks movement and vision)
//   .  floor
//   c  cover (floor; a unit here can go Hidden)
//   A  bomb site A floor      a  bomb site A cover
//   B  bomb site B floor      b  bomb site B cover
//   T  terrorist spawn / setup zone
//   C  counter-terrorist spawn / setup zone

export const MAPS = {
  dust: {
    name: 'Dust (v0)',
    ascii: [
      '####################################',
      '#BBBBBBBBB####CCCCCCCC####AAAAAAAAA#',
      '#BBbbBBbBB.c..CCCcCCcC..c.AAaaAAAaA#',
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
      '#############TcTTTTTTcT#############',
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
    walkable: (x, y) => at(x, y) !== '#',
    blocksLOS: (x, y) => at(x, y) === '#',
    isCover: (x, y) => 'cab'.includes(at(x, y)),
    siteAt: (x, y) => {
      const c = at(x, y);
      if (c === 'A' || c === 'a') return 'A';
      if (c === 'B' || c === 'b') return 'B';
      return null;
    },
    isSpawn: (x, y, side) => at(x, y) === (side === 'T' ? 'T' : 'C'),
  };
  cache.set(id, map);
  return map;
}
