// Geometry helpers: distance, line of sight, pathfinding. Pure and deterministic.

export const key = (x, y) => `${x},${y}`;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

// Tiles crossed by the segment between two tile centres, excluding both endpoints.
// Sampled symmetrically so LOS(a,b) === LOS(b,a).
export function lineTiles(x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 4));
  const out = [];
  const seen = new Set();
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const tx = Math.round(x0 + dx * t);
    const ty = Math.round(y0 + dy * t);
    if ((tx === x0 && ty === y0) || (tx === x1 && ty === y1)) continue;
    const k = key(tx, ty);
    if (!seen.has(k)) {
      seen.add(k);
      out.push([tx, ty]);
    }
  }
  return out;
}

// smoke: Set of "x,y" keys that block vision (may be null).
export function hasLOS(map, a, b, smoke) {
  for (const [x, y] of lineTiles(a.x, a.y, b.x, b.y)) {
    if (map.blocksLOS(x, y)) return false;
    if (smoke && smoke.has(key(x, y))) return false;
  }
  return true;
}

const DIRS = [
  [0, -1], [1, 0], [0, 1], [-1, 0],
  [1, -1], [1, 1], [-1, 1], [-1, -1],
];

// BFS, 8-directional, no cutting wall corners. Returns steps excluding start, or null.
export function findPath(map, from, to) {
  if (!map.walkable(to.x, to.y)) return null;
  if (from.x === to.x && from.y === to.y) return [];
  const prev = new Map();
  const start = key(from.x, from.y);
  prev.set(start, null);
  const queue = [[from.x, from.y]];
  let head = 0;
  while (head < queue.length) {
    const [x, y] = queue[head++];
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!map.walkable(nx, ny)) continue;
      if (dx && dy && (!map.walkable(x + dx, y) || !map.walkable(x, y + dy))) continue;
      const k = key(nx, ny);
      if (prev.has(k)) continue;
      prev.set(k, [x, y]);
      if (nx === to.x && ny === to.y) {
        const path = [];
        let cur = [nx, ny];
        while (cur && key(cur[0], cur[1]) !== start) {
          path.push({ x: cur[0], y: cur[1] });
          cur = prev.get(key(cur[0], cur[1]));
        }
        return path.reverse();
      }
      queue.push([nx, ny]);
    }
  }
  return null;
}

// Tiles within Euclidean radius r of a centre (walkable only).
export function tilesInRadius(map, cx, cy, r) {
  const out = [];
  const R = Math.ceil(r);
  for (let y = cy - R; y <= cy + R; y++) {
    for (let x = cx - R; x <= cx + R; x++) {
      if (map.walkable(x, y) && Math.hypot(x - cx, y - cy) <= r + 0.01) out.push([x, y]);
    }
  }
  return out;
}
