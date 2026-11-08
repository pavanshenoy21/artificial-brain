// Shared app state: notes, links, folders and colours, selection, plus a tiny
// event bus. A note's id is its vault path (as in Obsidian). Node objects are
// kept across reloads (fields merged in place, carried over on rename/move)
// so the graph keeps its layout when the vault changes.

import { api } from "./api.js";
import { colorScheme } from "./lib/folders.js";
import { linkIndex, resolve } from "./lib/wikilinks.js";

const handlers = new Map();
const LAYOUT = /^(x|y|z|vx|vy|vz|fx|fy|fz|index|__.*)$/;
const neutral = () => getComputedStyle(document.documentElement).getPropertyValue("--unsorted").trim() || "#8a8a8a";

export const app = {
  items: new Map(),     // path -> note/canvas object (shared with the graph)
  folders: [],          // every folder path, empty ones too
  colors: { folders: {} },
  scheme: colorScheme([], {}),
  links: [],            // [[wikilinks]]: { source, target } paths
  adj: new Map(),       // path -> [{ id, dir: "out" | "in" }]
  selected: null,       // path shown in the right sidebar
  settings: null,
  linkIdx: new Map(),   // lowercase file name / path / alias -> path
  loaded: false,
  renamed: new Map(),   // old path -> new path, until the next reload

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
  colorOf: n => (n?.path ? app.scheme.note(n.path) : neutral()),
  outgoing: id => (app.adj.get(id) || []).filter(e => e.dir === "out"),
  backlinks: id => (app.adj.get(id) || []).filter(e => e.dir === "in"),

  // Files moved (rename, move, folder rename): open tabs and the selection
  // follow, and graph nodes keep their place.
  moved(pairs) {
    for (const [from, to] of pairs || []) app.renamed.set(from, to);
    if (pairs?.length) app.emit("moved", pairs);
  },

  async reload() {
    const g = await api.loadGraph();
    app.folders = g.folders || [];
    app.colors = g.colors || { folders: {} };
    app.scheme = colorScheme(app.folders, app.colors, neutral());
    const carried = new Map([...app.renamed].map(([from, to]) => [to, app.items.get(from)]));
    app.renamed.clear();
    const next = new Map();
    for (const raw of g.nodes) {
      const existing = app.items.get(raw.id) || carried.get(raw.id);
      if (existing) {
        for (const k of Object.keys(existing)) if (!(k in raw) && !LAYOUT.test(k)) delete existing[k];
        next.set(raw.id, Object.assign(existing, raw));
      } else next.set(raw.id, raw);
    }
    app.items = next;
    app.linkIdx = linkIndex([...next.values()]);
    app.links = g.links.filter(l => next.has(l.source) && next.has(l.target));
    app.adj = new Map([...next.keys()].map(id => [id, []]));
    for (const l of app.links) {
      app.adj.get(l.source).push({ id: l.target, dir: "out" });
      app.adj.get(l.target).push({ id: l.source, dir: "in" });
    }
    for (const n of next.values()) n.degree = app.adj.get(n.id).length;
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

app.on("moved", pairs => {
  for (const [from, to] of pairs) if (app.selected === from) app.selected = to;
});

// Reload when the backend says something changed (writes, file watcher).
let pending;
api.onChange(() => {
  clearTimeout(pending);
  pending = setTimeout(() => app.reload(), 60);
});
