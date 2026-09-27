// Lobe layout: centres are computed, not hand-written. Lobes are placed on a
// sunflower (golden-angle) spiral in the XY plane: the biggest lobe sits in
// the middle and the rest spiral outwards by size, so the graph is a filled
// disc instead of a ring with an empty centre. XY stays distinct for 2D; a
// little alternating depth gives 3D some volume.

export const UNSORTED = { id: "unsorted", name: "Unsorted", color: null };

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/**
 * @param {{id:string}[]} lobes
 * @param {Map<string, number>} [counts]  items per lobe id (Unsorted included)
 */
export function lobeCenters(lobes, counts = new Map()) {
  const all = [...lobes.map(l => l.id), UNSORTED.id];
  const n = id => counts.get(id) || 0;
  // lobes with items first (biggest in the middle), empty ones last
  const order = all
    .map((id, i) => ({ id, i }))
    .sort((a, b) => n(b.id) - n(a.id) || a.i - b.i)
    .map(x => x.id);
  const used = order.filter(id => n(id) > 0).map(n).sort((a, b) => a - b);
  const typical = used.length ? used[Math.floor(used.length / 2)] : 8;
  const step = 34 + 5 * Math.sqrt(typical); // room for a typical cluster
  const out = new Map();
  order.forEach((id, i) => {
    const r = step * Math.sqrt(i);
    const a = i * GOLDEN;
    out.set(id, [Math.cos(a) * r, Math.sin(a) * r, (i % 2 ? -1 : 1) * Math.min(40, r * 0.25)]);
  });
  return out;
}
