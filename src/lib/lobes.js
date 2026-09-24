// Lobe layout: centres are computed, not hand-written. Lobes sit on a ring in
// the XY plane (so 2D keeps them apart) with alternating depth for 3D.

export const UNSORTED = { id: "unsorted", name: "Unsorted", color: null };

export function lobeCenters(lobes) {
  const n = lobes.length;
  const r = 60 + 13 * n;
  const out = new Map();
  lobes.forEach((l, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    out.set(l.id, [Math.cos(a) * r, Math.sin(a) * r, (i % 2 ? -1 : 1) * r * 0.35]);
  });
  out.set(UNSORTED.id, [0, 0, 0]);
  return out;
}
