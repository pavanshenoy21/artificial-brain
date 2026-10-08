// JSON Canvas 1.0 helpers (the format Obsidian's .canvas files use).
// Pure functions only: geometry, colours, ids. The view lives in view.js.

// Obsidian's preset colours "1"…"6"; any other value is a hex colour.
export const PRESETS = { 1: "#e5484d", 2: "#e98a3f", 3: "#d9c84e", 4: "#46a758", 5: "#3fb6c4", 6: "#9b7bf0" };
export const PRESET_NAMES = { 1: "red", 2: "orange", 3: "yellow", 4: "green", 5: "cyan", 6: "purple" };

export const colorOf = c => (c ? PRESETS[c] || (/^#[0-9a-f]{3,8}$/i.test(c) ? c : null) : null);

export const SIDES = ["top", "right", "bottom", "left"];

// 16 hex chars, like Obsidian's own ids.
export function newId(taken = new Set()) {
  for (;;) {
    const id = [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, "0")).join("");
    if (!taken.has(id)) return id;
  }
}

export function normalize(data) {
  const d = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  if (!Array.isArray(d.nodes)) d.nodes = [];
  if (!Array.isArray(d.edges)) d.edges = [];
  for (const n of d.nodes) {
    for (const k of ["x", "y"]) n[k] = Number.isFinite(+n[k]) ? Math.round(+n[k]) : 0;
    n.width = Number.isFinite(+n.width) && +n.width > 0 ? Math.round(+n.width) : 250;
    n.height = Number.isFinite(+n.height) && +n.height > 0 ? Math.round(+n.height) : 60;
  }
  const ids = new Set(d.nodes.map(n => n.id));
  d.edges = d.edges.filter(e => ids.has(e.fromNode) && ids.has(e.toNode));
  return d;
}

export const center = n => ({ x: n.x + n.width / 2, y: n.y + n.height / 2 });

// Point on the middle of a node's side.
export function anchor(n, side) {
  switch (side) {
    case "top": return { x: n.x + n.width / 2, y: n.y };
    case "bottom": return { x: n.x + n.width / 2, y: n.y + n.height };
    case "left": return { x: n.x, y: n.y + n.height / 2 };
    default: return { x: n.x + n.width, y: n.y + n.height / 2 };
  }
}

const NORMAL = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };

// Side of `n` facing point p (for edges without a stored side).
export function facingSide(n, p) {
  const c = center(n);
  const dx = (p.x - c.x) / Math.max(1, n.width), dy = (p.y - c.y) / Math.max(1, n.height);
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "bottom" : "top");
}

// Nearest side to a point (when dropping an edge onto a node).
export function nearestSide(n, p) {
  let best = "top", bestD = Infinity;
  for (const s of SIDES) {
    const a = anchor(n, s);
    const d = (a.x - p.x) ** 2 + (a.y - p.y) ** 2;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

// Cubic bezier for an edge: { d (svg path), mid (label point), end, endDir }.
export function edgePath(from, fromSide, to, toSide) {
  const a = anchor(from, fromSide || facingSide(from, center(to)));
  const b = anchor(to, toSide || facingSide(to, center(from)));
  return curve(a, fromSide || facingSide(from, center(to)), b, toSide || facingSide(to, center(from)));
}

export function curve(a, sa, b, sb) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const k = Math.min(150, Math.max(30, dist * 0.4));
  const [ax, ay] = NORMAL[sa] || [0, 0];
  const [bx, by] = NORMAL[sb] || [0, 0];
  const c1 = { x: a.x + ax * k, y: a.y + ay * k };
  const c2 = { x: b.x + bx * k, y: b.y + by * k };
  const at = t => {
    const u = 1 - t;
    return {
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    };
  };
  return {
    d: `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`,
    mid: at(0.5),
    start: a, end: b,
    // arrowheads point along the curve's tangent at each end
    endDir: unit(b.x - c2.x, b.y - c2.y, -bx, -by),
    startDir: unit(a.x - c1.x, a.y - c1.y, -ax, -ay),
  };
}

function unit(x, y, fx, fy) {
  const l = Math.hypot(x, y);
  return l > 1e-6 ? { x: x / l, y: y / l } : { x: fx, y: fy };
}

// Triangle at point p pointing along dir.
export function arrowHead(p, dir, size = 9) {
  const bx = p.x - dir.x * size, by = p.y - dir.y * size;
  const nx = -dir.y * size * 0.5, ny = dir.x * size * 0.5;
  return `M${p.x},${p.y} L${bx + nx},${by + ny} L${bx - nx},${by - ny} Z`;
}

export function bounds(nodes) {
  if (!nodes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + n.width); y1 = Math.max(y1, n.y + n.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export const inside = (n, g) => n !== g && n.x >= g.x && n.y >= g.y && n.x + n.width <= g.x + g.width && n.y + n.height <= g.y + g.height;

export const intersects = (n, r) => n.x < r.x + r.width && n.x + n.width > r.x && n.y < r.y + r.height && n.y + n.height > r.y;

// Nodes that move with a group: everything fully inside it (recursively).
export function groupContents(data, group) {
  return data.nodes.filter(n => inside(n, group));
}

// Groups first (drawn underneath), larger groups below smaller ones.
export function drawOrder(nodes) {
  const groups = nodes.filter(n => n.type === "group").sort((a, b) => b.width * b.height - a.width * a.height);
  return [...groups, ...nodes.filter(n => n.type !== "group")];
}

// Camera that fits a rectangle into a w×h viewport.
export function fitView(rect, w, h, pad = 60, maxZoom = 1) {
  if (!rect || !w || !h) return { x: w / 2, y: h / 2, z: 1 };
  const z = Math.min(maxZoom, Math.max(0.1, Math.min((w - pad * 2) / Math.max(1, rect.width), (h - pad * 2) / Math.max(1, rect.height))));
  return { z, x: w / 2 - (rect.x + rect.width / 2) * z, y: h / 2 - (rect.y + rect.height / 2) * z };
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
export const isImage = path => IMAGE.test(path || "");
