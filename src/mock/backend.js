// In-memory stand-in for the Rust backend, used when the page runs in a plain
// browser (`npm run dev`, Playwright). Same method names and shapes as the
// Tauri commands wrapped in api.js. Seeded from src/data/sample.js.

import { LOBES, buildSampleGraph } from "../data/sample.js";
import { TYPE } from "../lib/types.js";
import { fileStem, linkIndex, renameWikilinks, resolve, wikilinks } from "../lib/wikilinks.js";

const MANAGED = new Set(["id", "path", "created", "updated", "degree"]);
const CORE = new Set(["id", "type", "lobe", "title", "tags", "body", "path", "created", "updated"]);
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Mirrors settings.rs defaults.
export const DEFAULT_SETTINGS = {
  vault: "", theme: "dark",
  ai: { provider: "", base_url: "", model: "", api_key: "" },
  embed: { base_url: "", model: "" },
  github: { token: "", auto_sync: true },
  shortcuts: { capture: "CommandOrControl+Shift+Space" },
};
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
let seq = 0;
const newId = () => `m${Date.now().toString(36)}${(++seq).toString(36)}`;

export function createMockBackend({ seed = true } = {}) {
  const items = new Map();
  let lobes = LOBES.map(l => ({ ...l }));
  let settings = structuredClone(DEFAULT_SETTINGS);
  const listeners = new Set();
  const emit = kind => listeners.forEach(fn => fn({ kind }));

  function uniquePath(type, title, selfId) {
    const dir = TYPE[type]?.dir || "notes";
    const stem = fileStem(title);
    const taken = new Set([...items.values()].filter(i => i.id !== selfId).map(i => i.path.toLowerCase()));
    let p = `${dir}/${stem}.md`;
    for (let n = 2; taken.has(p.toLowerCase()); n++) p = `${dir}/${stem} ${n}.md`;
    return p;
  }

  function applyPatch(item, patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (MANAGED.has(k)) continue;
      if (k === "type") {
        if (!TYPE[v]) throw new Error(`unknown type "${v}"`);
        item.type = v;
      } else if (k === "tags") {
        const raw = Array.isArray(v) ? v : String(v ?? "").split(/[,\s]+/);
        item.tags = [...new Set(raw.map(t => String(t).trim().replace(/^#+/, "")).filter(Boolean))];
      } else if (k === "title") item.title = String(v ?? "").trim();
      else if (k === "body") item.body = String(v ?? "").trimEnd();
      else if (k === "lobe") item.lobe = v || null;
      else if (v === null) delete item[k];
      else item[k] = v;
    }
  }

  function links() {
    const all = [...items.values()];
    const idx = linkIndex(all);
    const out = [];
    const seen = new Set();
    for (const it of all)
      for (const t of wikilinks(it.body)) {
        const target = resolve(idx, t);
        const key = `${it.id}|${target}`;
        if (target && target !== it.id && !seen.has(key)) {
          seen.add(key);
          out.push({ source: it.id, target, kind: "explicit" });
        }
      }
    return out;
  }

  const clone = x => structuredClone(x);

  const api = {
    async loadGraph() {
      return { nodes: [...items.values()].map(clone), links: links(), lobes: clone(lobes) };
    },
    async getItem(id) {
      return items.has(id) ? clone(items.get(id)) : null;
    },
    async createItem(input) {
      const t = now();
      const item = { id: newId(), type: "note", lobe: null, title: "", tags: [], body: "", created: t, updated: t };
      applyPatch(item, input);
      if (!item.title) throw new Error("title is required");
      item.path = uniquePath(item.type, item.title);
      items.set(item.id, item);
      emit("items");
      return clone(item);
    },
    async updateItem(id, patch) {
      const item = items.get(id);
      if (!item) throw new Error(`no item with id ${id}`);
      const oldTitle = item.title;
      const oldStem = item.path.split("/").pop().replace(/\.md$/, "");
      applyPatch(item, patch);
      if (!item.title) throw new Error("title can't be empty");
      item.updated = now();
      if (item.title !== oldTitle && fileStem(item.title) !== oldStem) {
        item.path = uniquePath(item.type, item.title, id);
        const newStem = item.path.split("/").pop().replace(/\.md$/, "");
        for (const other of items.values()) {
          let b = renameWikilinks(other.body, oldStem, newStem);
          if (oldTitle !== oldStem) b = renameWikilinks(b, oldTitle, newStem);
          other.body = b;
        }
      }
      emit("items");
      return clone(item);
    },
    async deleteItem(id) {
      items.delete(id);
      emit("items");
    },
    async listTags() {
      const counts = new Map();
      for (const it of items.values()) for (const t of it.tags) counts.set(t, (counts.get(t) || 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    },
    async importSample() {
      const { nodes, links: edges } = buildSampleGraph();
      const idMap = new Map();
      for (const n of nodes) {
        const { id, ...rest } = n;
        idMap.set(id, (await api.createItem(rest)).id);
      }
      const out = new Map();
      for (const e of edges) {
        const s = idMap.get(e.source), t = idMap.get(e.target);
        if (!s || !t) continue;
        const stem = items.get(t).path.split("/").pop().replace(/\.md$/, "");
        out.set(s, [...(out.get(s) || []), `[[${stem}]]`]);
      }
      for (const [id, ls] of out) {
        const it = items.get(id);
        it.body = (it.body ? it.body + "\n\n" : "") + "Related: " + ls.join(", ");
      }
      emit("items");
      return idMap.size;
    },
    async search(query, limit = 20) {
      // Rough stand-in for the backend's FTS5 bm25: every word must prefix-match a word.
      const words = query.toLowerCase().split(/[^\p{L}\p{N}_'-]+/u).filter(Boolean);
      if (!words.length) return [];
      const hits = [];
      for (const it of items.values()) {
        const fields = [
          [it.title, 10], [it.tags.join(" "), 4], [it.body, 1],
          [Object.entries(it).filter(([k]) => !CORE.has(k)).map(([, v]) => [].concat(v).join(" ")).join(" "), 0.5],
        ].map(([t, w]) => [String(t || "").toLowerCase(), w]);
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
        hits.push({ id: it.id, score, snippet });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    },
    async rebuildIndex() {
      emit("items");
      return { scanned: items.size, updated: items.size, removed: 0 };
    },
    async listLobes() {
      return clone(lobes);
    },
    async saveLobes(next) {
      const ids = new Set();
      for (const l of next) {
        if (!l.id?.trim() || !l.name?.trim()) throw new Error("every lobe needs an id and a name");
        if (ids.has(l.id)) throw new Error(`duplicate lobe id "${l.id}"`);
        ids.add(l.id);
      }
      lobes = clone(next);
      emit("lobes");
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
      return clone(settings);
    },
    async saveSettings(next) {
      settings = clone(next);
      return clone(settings);
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  const ready = seed ? api.importSample() : Promise.resolve();
  // every call waits for the seed, so nothing sees a half-filled vault
  const guarded = { onChange: api.onChange };
  for (const [k, fn] of Object.entries(api))
    if (k !== "onChange" && k !== "importSample") guarded[k] = async (...a) => { await ready; return fn(...a); };
  guarded.importSample = api.importSample;
  return guarded;
}
