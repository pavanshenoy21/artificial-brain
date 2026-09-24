// Shared app state: items, links, lobes, selection, plus a tiny event bus.
// Node objects are kept stable across reloads (fields are merged in place) so
// the force layout keeps its positions when the vault changes.

import { api } from "./api.js";
import { similarityLinks } from "./data/similar.js";
import { UNSORTED } from "./lib/lobes.js";
import { linkIndex, resolve } from "./lib/wikilinks.js";

const handlers = new Map();

export const app = {
  items: new Map(),     // id -> node object (shared with the graph)
  links: [],            // explicit + similar, { source, target, kind } with ids
  lobes: [],
  lobe: new Map(),      // id -> lobe (includes Unsorted)
  adj: new Map(),       // id -> [{ id, kind, dir: "out" | "in" }]
  selected: null,       // id shown in the right sidebar
  linkIdx: new Map(),   // lowercase title / file name / path -> id
  loaded: false,

  on(evt, fn) {
    if (!handlers.has(evt)) handlers.set(evt, new Set());
    handlers.get(evt).add(fn);
    return () => handlers.get(evt).delete(fn);
  },
  emit(evt, payload) {
    for (const fn of handlers.get(evt) || []) {
      try { fn(payload); } catch (e) { console.error(`handler for ${evt} failed`, e); }
    }
  },

  resolve: target => resolve(app.linkIdx, target),

  lobeOf(n) {
    return app.lobe.get(n?.lobe) || app.lobe.get(UNSORTED.id);
  },
  outgoing: id => (app.adj.get(id) || []).filter(e => e.kind === "explicit" && e.dir === "out"),
  backlinks: id => (app.adj.get(id) || []).filter(e => e.kind === "explicit" && e.dir === "in"),
  similar: id => (app.adj.get(id) || []).filter(e => e.kind === "similar"),

  async reload() {
    const g = await api.loadGraph();
    app.lobes = g.lobes;
    app.lobe = new Map(g.lobes.map(l => [l.id, l]));
    const unsorted = { ...UNSORTED, color: getComputedStyle(document.documentElement).getPropertyValue("--unsorted").trim() || "#8a8a8a" };
    app.lobe.set(UNSORTED.id, unsorted);

    const next = new Map();
    for (const raw of g.nodes) {
      if (!app.lobe.has(raw.lobe) || raw.lobe === UNSORTED.id) raw.lobe = UNSORTED.id;
      const existing = app.items.get(raw.id);
      if (existing) {
        // drop fields that disappeared, keep layout/three.js state (x, y, z, vx, __*)
        for (const k of Object.keys(existing)) if (!(k in raw) && !/^(x|y|z|vx|vy|vz|fx|fy|fz|index|__.*)$/.test(k)) delete existing[k];
        next.set(raw.id, Object.assign(existing, raw));
      } else next.set(raw.id, raw);
    }
    app.items = next;
    app.linkIdx = linkIndex([...next.values()]);

    const nodes = [...next.values()];
    const explicit = g.links.filter(l => next.has(l.source) && next.has(l.target));
    const similar = g.similar ?? similarityLinks(nodes, explicit);
    app.links = [...explicit, ...similar];
    app.adj = new Map(nodes.map(n => [n.id, []]));
    for (const l of app.links) {
      app.adj.get(l.source).push({ id: l.target, kind: l.kind, dir: "out" });
      app.adj.get(l.target).push({ id: l.source, kind: l.kind, dir: "in" });
    }
    for (const n of nodes) n.degree = app.adj.get(n.id).filter(e => e.kind === "explicit").length;
    if (app.selected && !next.has(app.selected)) app.selected = null;
    app.loaded = true;
    app.emit("data");
  },

  select(id, opts = {}) {
    app.selected = id;
    app.emit("select", { id, ...opts });
  },
  open(id, opts = {}) {
    app.emit("open", { id, ...opts });
  },
};

// Reload when the backend says something changed (writes, file watcher).
let pending;
api.onChange(() => {
  clearTimeout(pending);
  pending = setTimeout(() => app.reload(), 60);
});
