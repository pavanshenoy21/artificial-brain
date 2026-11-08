// In-memory stand-in for the Rust backend, used when the page runs in a plain
// browser (`npm run dev`, Playwright). Same method names and shapes as the
// Tauri commands wrapped in api.js, same rules as store.rs: a note's id is its
// path, its title is its file name, renames and moves rewrite links.

import { sampleFiles } from "../data/sample.js";
import { fileStem, linkIndex, renameWikilinks, resolve, wikilinks } from "../lib/wikilinks.js";
import { inlineTags, allTags } from "../lib/tags.js";

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const IGNORED = new Set(["id", "path", "type", "title", "degree", "inline_tags"]);
const folderOf = p => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const nameOf = p => p.split("/").pop();
const stemOf = p => nameOf(p).replace(/\.(md|canvas)$/i, "");
const extOf = p => (/\.canvas$/i.test(p) ? "canvas" : "md");

// Same checks as store.rs safe_rel: no absolute paths, "..", or dot-folders.
function safeRel(p) {
  const parts = String(p ?? "").split(/[\\/]/).map(x => x.trim()).filter(Boolean);
  if (!parts.length || parts.some(x => x.startsWith(".") || x.includes(":"))) throw new Error(`bad path "${p}"`);
  return parts.join("/");
}
const folderArg = f => (f && String(f).trim() && String(f).trim() !== "/" ? safeRel(f) : "");

// Tiny frontmatter reader for the sample files ("key: value", "[a, b]", "- item").
function parseNote(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const fields = {};
  if (m) {
    let list = null;
    for (const line of m[1].split(/\r?\n/)) {
      const item = /^\s*-\s+(.*)$/.exec(line);
      if (item && list) { fields[list].push(item[1].trim()); continue; }
      const kv = /^([^:#][^:]*):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const [, k, v] = kv;
      if (!v) { fields[k.trim()] = []; list = k.trim(); continue; }
      list = null;
      fields[k.trim()] = /^\[.*\]$/.test(v.trim()) ? v.trim().slice(1, -1).split(",").map(x => x.trim()).filter(Boolean) : v.trim();
    }
  }
  const tags = [].concat(fields.tags ?? []).flatMap(t => String(t).split(/[,\s]+/)).map(t => t.replace(/^#+/, "")).filter(Boolean);
  delete fields.tags;
  return { fields, tags, body: (m ? text.slice(m[0].length) : text).replace(/^[\r\n]+/, "").trimEnd() };
}

function canvasText(data) {
  return (data.nodes || []).map(n =>
    n.type === "text" ? (n.text || "").trim()
    : n.type === "file" && n.file ? `[[${n.file}]]`
    : n.type === "link" ? (n.url || "").trim()
    : n.type === "group" ? (n.label || "").trim() : "").filter(Boolean).join("\n\n");
}

function validateCanvas(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("a canvas must be a JSON object");
  const ids = new Set();
  for (const n of d.nodes || []) {
    if (typeof n.id !== "string" || typeof n.type !== "string") throw new Error("every canvas node needs an id and a type");
    if (ids.has(n.id)) throw new Error(`duplicate canvas node id "${n.id}"`);
    ids.add(n.id);
  }
  for (const e of d.edges || []) if (!ids.has(e.fromNode) || !ids.has(e.toNode)) throw new Error("every canvas edge needs fromNode and toNode on this canvas");
}

export const DEFAULT_SETTINGS = { vault: "", theme: "dark" };

export function createMockBackend({ seed = true } = {}) {
  const items = new Map();      // path -> { path, type, tags, body, fields, canvas? }
  const folders = new Set();    // explicit folders (empty ones survive)
  let colors = { folders: {} };
  let settings = { ...DEFAULT_SETTINGS };
  try { Object.assign(settings, JSON.parse(localStorage.getItem("brain.mock.settings")) || {}); } catch {}
  const listeners = new Set();
  const emit = kind => listeners.forEach(fn => fn({ kind }));

  const addParents = p => { for (let f = folderOf(p); f; f = folderOf(f)) folders.add(f); };
  function put(path, it) {
    it.path = path;
    items.set(path, it);
    addParents(path);
    return it;
  }
  function setCanvas(it, data) {
    it.canvas = structuredClone(data);
    it.body = canvasText(data);
  }
  function view(it) {
    const props = structuredClone(it.fields || {});
    if (it.type === "canvas") props.cards = (it.canvas.nodes || []).length;
    return { id: it.path, type: it.type, title: stemOf(it.path), tags: [...(it.tags || [])], inline_tags: inlineTags(it.body), body: it.body, path: it.path, props };
  }
  function uniquePath(dir, stem, ext, self) {
    const taken = p => [...items.keys()].some(k => k.toLowerCase() === p.toLowerCase() && k !== self);
    const at = s => (dir ? `${dir}/` : "") + `${s}.${ext}`;
    let p = at(stem);
    for (let n = 1; taken(p); n++) p = at(`${stem} ${n}`);
    return p;
  }
  function links() {
    const all = [...items.values()].map(view);
    const idx = linkIndex(all);
    const out = [];
    const seen = new Set();
    const fieldText = it => Object.values(it.fields || {}).flatMap(v => [].concat(v)).filter(x => typeof x === "string").join("\n");
    for (const it of items.values())
      for (const t of [...wikilinks(it.body), ...wikilinks(fieldText(it))]) {
        const target = resolve(idx, t);
        const key = `${it.path}|${target}`;
        if (target && target !== it.path && !seen.has(key)) {
          seen.add(key);
          out.push({ source: it.path, target });
        }
      }
    return out.sort((a, b) => (a.source + a.target).localeCompare(b.source + b.target));
  }
  // After files moved: rewrite [[links]] (name pairs + path pairs) and canvas file cards.
  function finishMoves(moves, pairs = []) {
    for (const [o, n] of moves) {
      if (o.endsWith(".md") && n.endsWith(".md")) pairs.push([o.slice(0, -3), n.slice(0, -3)]);
      pairs.push([o, n]);
    }
    const rn = t => pairs.reduce((b, [o, n]) => renameWikilinks(b, o, n), t);
    for (const it of items.values()) {
      if (it.type === "canvas") {
        let hit = false;
        for (const n of it.canvas.nodes || []) {
          const m = moves.find(([o]) => o === n.file);
          if (n.type === "file" && m) { n.file = m[1]; hit = true; }
          if (n.type === "text" && n.text) { const t = rn(n.text); if (t !== n.text) { n.text = t; hit = true; } }
        }
        if (hit) setCanvas(it, it.canvas);
        continue;
      }
      it.body = rn(it.body);
      for (const [k, v] of Object.entries(it.fields || {}))
        it.fields[k] = Array.isArray(v) ? v.map(x => (typeof x === "string" ? rn(x) : x)) : typeof v === "string" ? rn(v) : v;
    }
  }
  function move(from, to) {
    const it = items.get(from);
    items.delete(from);
    put(to, it);
  }
  const normTags = v => [...new Set((Array.isArray(v) ? v : String(v ?? "").split(/[,\s]+/)).map(t => String(t).trim().replace(/^#+/, "")).filter(Boolean))];
  // same as store.rs apply_patch: { tags?, body?, props?: { name: value | null } }
  function applyPatch(it, patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === "tags") it.tags = normTags(v);
      else if (k === "body") it.body = String(v ?? "").trimEnd();
      else if (k === "props") {
        for (const [name, val] of Object.entries(v || {}))
          if (name === "tags") it.tags = normTags(val);
          else if (val === null) delete it.fields[name];
          else it.fields[name] = val;
      } else if (IGNORED.has(k)) continue;
      else throw new Error(`unknown field "${k}" (properties go in props)`);
    }
  }
  const must = id => { const it = items.get(id); if (!it) throw new Error(`no file "${id}"`); return it; };

  const api = {
    async loadGraph() {
      return { nodes: [...items.values()].map(view), folders: [...folders].sort(), links: links(), colors: structuredClone(colors) };
    },
    async getItem(id) {
      return items.has(id) ? view(items.get(id)) : null;
    },
    async createItem(input = {}) {
      const { folder, title, ...rest } = input;
      const dir = folderArg(folder);
      const path = uniquePath(dir, fileStem(String(title || "").trim() || "Untitled"), "md");
      const it = put(path, { type: "note", tags: [], body: "", fields: {} });
      applyPatch(it, rest);
      emit("items");
      return view(it);
    },
    async updateItem(id, patch = {}) {
      const it = must(id);
      const { title, ...rest } = patch;
      if (it.type === "canvas") {
        if (Object.keys(rest).some(k => !IGNORED.has(k))) throw new Error("a canvas has no properties; only its name can change");
      } else applyPatch(it, rest);
      let path = id;
      if (title !== undefined) {
        const t = String(title).trim();
        if (!t) throw new Error("the name can't be empty");
        if (t !== stemOf(id)) {
          const ext = extOf(id);
          path = uniquePath(folderOf(id), fileStem(t), ext, id);
          if (path !== id) {
            move(id, path);
            const pairs = ext === "md" ? [[stemOf(id), stemOf(path)]] : [[nameOf(id), nameOf(path)]];
            finishMoves([[id, path]], pairs);
          }
        }
      }
      emit("items");
      return view(items.get(path));
    },
    async deleteItem(id) {
      must(id);
      items.delete(id);
      emit("items");
    },
    async listTags() {
      const counts = new Map();
      for (const it of items.values()) for (const t of allTags(view(it))) counts.set(t, (counts.get(t) || 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    },
    async search(query, limit = 20) {
      // Rough stand-in for FTS5 bm25: every word must prefix-match a word.
      const words = query.toLowerCase().split(/[^\p{L}\p{N}_'-]+/u).filter(Boolean);
      if (!words.length) return [];
      const hits = [];
      for (const it of items.values()) {
        const v = view(it);
        const fields = [[v.title, 10], [allTags(v).join(" "), 4], [it.body, 1],
          [Object.values(it.fields || {}).map(x => [].concat(x).join(" ")).join(" "), 0.5]].map(([t, w]) => [String(t || "").toLowerCase(), w]);
        let score = 0;
        const ok = words.every(w => {
          let best = 0;
          for (const [t, wt] of fields) if (new RegExp(`(^|[^\\p{L}\\p{N}])${escRe(w)}`, "u").test(t)) best = Math.max(best, wt);
          score += best;
          return best > 0;
        });
        if (!ok) continue;
        const body = it.body || "";
        const at = Math.max(0, body.toLowerCase().indexOf(words[0]));
        const start = Math.max(0, at - 40);
        let snippet = (start ? "…" : "") + body.slice(start, start + 120) + (start + 120 < body.length ? "…" : "");
        snippet = snippet.replace(new RegExp(`(${words.map(escRe).join("|")})`, "gi"), "\u0001$1\u0002");
        hits.push({ id: it.path, score, snippet });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    },
    async importSample() {
      let n = 0;
      for (const f of sampleFiles()) {
        const path = safeRel(f.path);
        if (items.has(path)) continue;
        if (extOf(path) === "canvas") {
          const it = put(path, { type: "canvas", tags: [], body: "", fields: {} });
          setCanvas(it, JSON.parse(f.content));
        } else put(path, { type: "note", ...parseNote(f.content) });
        n++;
      }
      emit("items");
      return n;
    },
    async rebuildIndex() {
      emit("items");
      return { scanned: items.size, updated: items.size, removed: 0 };
    },
    async vaultInfo() {
      return { path: "~/Brain (browser preview)", items: items.size, error: null, mock: true };
    },
    async openVault() {
      return api.vaultInfo();
    },
    async pickFolder() {
      return null;
    },
    async getSettings() {
      return { ...settings };
    },
    async saveSettings(next) {
      settings = { vault: next.vault ?? "", theme: next.theme ?? "dark" };
      try { localStorage.setItem("brain.mock.settings", JSON.stringify(settings)); } catch {}
      return { ...settings };
    },
    fileUrl: () => null,

    // ---- canvases
    async createCanvas(title, folder) {
      const path = uniquePath(folderArg(folder), fileStem(String(title || "").trim() || "Untitled"), "canvas");
      const it = put(path, { type: "canvas", tags: [], body: "", fields: {} });
      setCanvas(it, { nodes: [], edges: [] });
      emit("items");
      return view(it);
    },
    async getCanvas(id) {
      const it = must(id);
      if (it.type !== "canvas") throw new Error("not a canvas");
      return structuredClone(it.canvas);
    },
    async saveCanvas(id, data) {
      const it = must(id);
      if (it.type !== "canvas") throw new Error("not a canvas");
      validateCanvas(data);
      setCanvas(it, data);
      emit("canvas");
      return view(it);
    },

    // ---- folders
    async createFolder(path) {
      const rel = safeRel(path);
      if (folders.has(rel)) throw new Error(`"${rel}" already exists`);
      folders.add(rel);
      addParents(`${rel}/x`);
      emit("folders");
      return rel;
    },
    async renameFolder(from, to) {
      from = safeRel(from); to = safeRel(to);
      if (!folders.has(from)) throw new Error(`no folder "${from}"`);
      if (from === to) return [];
      if (to.startsWith(`${from}/`)) throw new Error("a folder can't be moved into itself");
      if (folders.has(to) && from.toLowerCase() !== to.toLowerCase()) throw new Error(`"${to}" already exists`);
      const inside = [...items.keys()].filter(p => p.startsWith(`${from}/`));
      const moves = inside.map(p => [p, to + p.slice(from.length)]);
      for (const f of [...folders]) if (f === from || f.startsWith(`${from}/`)) { folders.delete(f); folders.add(to + f.slice(from.length)); }
      addParents(`${to}/x`);
      for (const [k, v] of Object.entries(colors.folders))
        if (k === from || k.startsWith(`${from}/`)) { delete colors.folders[k]; colors.folders[to + k.slice(from.length)] = v; }
      for (const [o, n] of moves) move(o, n);
      finishMoves(moves);
      emit("folders");
      return moves;
    },
    async deleteFolder(path) {
      const rel = safeRel(path);
      if (!folders.has(rel)) throw new Error(`no folder "${rel}"`);
      for (const p of [...items.keys()]) if (p.startsWith(`${rel}/`)) items.delete(p);
      for (const f of [...folders]) if (f === rel || f.startsWith(`${rel}/`)) folders.delete(f);
      emit("folders");
    },
    async moveItem(id, folder) {
      must(id);
      const dir = folderArg(folder);
      if (folderOf(id) === dir) return [];
      const dest = uniquePath(dir, stemOf(id), extOf(id));
      move(id, dest);
      const pairs = stemOf(id) !== stemOf(dest) ? [[stemOf(id), stemOf(dest)]] : [];
      finishMoves([[id, dest]], pairs);
      if (dir) folders.add(dir);
      emit("items");
      return [[id, dest]];
    },
    async setFolderColor(folder, color) {
      const f = safeRel(folder);
      if (color == null) delete colors.folders[f];
      else if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) colors.folders[f] = color.toLowerCase();
      else throw new Error(`not a colour: "${color}"`);
      emit("colors");
      return structuredClone(colors);
    },

    on(event, fn) {
      if (event === "vault-changed") return api.onChange(fn);
      return () => {};
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  const ready = seed ? api.importSample() : Promise.resolve();
  // every call waits for the seed, so nothing sees a half-filled vault
  const guarded = {};
  for (const [k, fn] of Object.entries(api))
    guarded[k] = ["onChange", "on", "importSample", "fileUrl"].includes(k) ? fn : async (...a) => { await ready; return fn(...a); };
  return guarded;
}
