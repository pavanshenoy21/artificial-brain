// In-memory stand-in for the Rust backend, used when the page runs in a plain
// browser (`npm run dev`, Playwright). Same method names and shapes as the
// Tauri commands wrapped in api.js. Seeded from src/data/sample.js.

import { LOBES, buildSampleGraph } from "../data/sample.js";
import { TYPE } from "../lib/types.js";
import { fileStem, linkIndex, renameWikilinks, resolve, wikilinks } from "../lib/wikilinks.js";
import { inlineTags, allTags } from "../lib/tags.js";

const MANAGED = new Set(["id", "path", "created", "updated", "degree", "inline_tags"]);
const CORE = new Set(["id", "type", "lobe", "title", "tags", "inline_tags", "body", "path", "created", "updated"]);
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function normalizeUrl(text) {
  if (/\s/.test(text)) return null;
  let c = text;
  if (!/^https?:\/\//.test(c)) {
    if (!c.includes(".") || c.startsWith(".") || c.includes("://")) return null;
    c = "https://" + c;
  }
  try {
    const u = new URL(c);
    return u.hostname.includes(".") || u.hostname === "localhost" ? u.href : null;
  } catch {
    return null;
  }
}

// Mirrors settings.rs defaults.
export const DEFAULT_SETTINGS = {
  vault: "", theme: "dark",
  ai: { provider: "", base_url: "", model: "", api_key: "" },
  embed: { base_url: "", model: "", top_k: 3, min_score: 0.55 },
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
  const history = [];   // originals kept by AI actions (.brain/history in the real app)
  const needAi = () => { if (!settings.ai.provider) throw new Error("No AI provider set up (Settings → AI provider)."); };
  const listeners = new Set();
  const emit = kind => listeners.forEach(fn => fn({ kind }));
  const eventListeners = new Map();
  const emitEvent = (event, payload) => eventListeners.get(event)?.forEach(fn => fn(payload));

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
    // links in the body and in frontmatter values (e.g. used_in: ["[[Project]]"]), like index.rs
    const fieldText = it => Object.entries(it).filter(([k]) => !CORE.has(k)).map(([, v]) => [].concat(v).filter(x => typeof x === "string").join("\n")).join("\n");
    for (const it of all)
      for (const t of [...wikilinks(it.body), ...wikilinks(fieldText(it))]) {
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
  // what the backend returns for an item: plus its inline #tags (like vault.rs)
  const view = it => ({ ...structuredClone(it), inline_tags: inlineTags(it.body) });
  const tagsOf = it => allTags(view(it));

  const api = {
    async loadGraph() {
      return { nodes: [...items.values()].map(view), links: links(), lobes: clone(lobes) };
    },
    async getItem(id) {
      return items.has(id) ? view(items.get(id)) : null;
    },
    async createItem(input) {
      const t = now();
      const item = { id: newId(), type: "note", lobe: null, title: "", tags: [], body: "", created: t, updated: t };
      applyPatch(item, input);
      if (!item.title) throw new Error("title is required");
      item.path = uniquePath(item.type, item.title);
      items.set(item.id, item);
      emit("items");
      return view(item);
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
        const rn = t => {
          let b = renameWikilinks(t, oldStem, newStem);
          return oldTitle !== oldStem ? renameWikilinks(b, oldTitle, newStem) : b;
        };
        for (const other of items.values()) {
          other.body = rn(other.body);
          for (const [k, v] of Object.entries(other))
            if (!CORE.has(k) && Array.isArray(v)) other[k] = v.map(x => (typeof x === "string" ? rn(x) : x));
            else if (!CORE.has(k) && typeof v === "string") other[k] = rn(v);
        }
      }
      emit("items");
      return view(item);
    },
    async deleteItem(id) {
      items.delete(id);
      emit("items");
    },
    async listTags() {
      const counts = new Map();
      for (const it of items.values()) for (const t of tagsOf(it)) counts.set(t, (counts.get(t) || 0) + 1);
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
          [it.title, 10], [tagsOf(it).join(" "), 4], [it.body, 1],
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
    // Mirrors capture.rs, minus the network: the "fetch" finishes after a moment
    // with the host as title (pages aren't fetched in the browser preview).
    async capture(text) {
      text = text.trim();
      if (!text) throw new Error("nothing to save");
      const url = normalizeUrl(text);
      if (!url) {
        const [first, ...rest] = text.split("\n");
        return { item: await api.createItem({ type: "note", title: first.trim().slice(0, 80), body: rest.join("\n").trim() }), existing: false };
      }
      const dup = [...items.values()].find(i => i.url === url);
      if (dup) return { item: clone(dup), existing: true };
      const host = new URL(url).hostname.replace(/^www\./, "");
      const item = await api.createItem({ type: "link", title: (host + new URL(url).pathname).replace(/\/$/, ""), url, site: host, status: "pending" });
      setTimeout(() => {
        const it = items.get(item.id);
        if (!it) return;
        Object.assign(it, { status: "ok", fetched: now(), summary: "Browser preview: pages aren't fetched here." });
        emit("items");
      }, 800);
      return { item, existing: false };
    },
    async refetchLink(id) {
      const it = items.get(id);
      if (it) { it.status = "ok"; delete it.error; emit("items"); }
    },
    async openCapture() {
      window.open("/capture.html", "capture", "width=480,height=120");
    },
    async hideCapture() {},
    async getSettings() {
      return clone(settings);
    },
    async saveSettings(next) {
      settings = clone(next);
      emitEvent("settings-changed", clone(settings));
      return clone(settings);
    },
    async testAi() {
      return { ok: false, message: "Browser preview: no network calls. Test this in the desktop app." };
    },
    async testEmbed() {
      return { ok: false, message: "Browser preview: no network calls. Test this in the desktop app." };
    },
    async semanticSearch() {
      return [];
    },
    async embedStatus() {
      return { state: settings.embed.base_url ? "idle" : "off", done: 0, total: 0, message: "" };
    },
    async embedAll() {},
    // Fake AI for the browser preview (enabled when a provider is picked in
    // Settings): deterministic, never adds facts, good enough to exercise the UI.
    async aiPolish(text) {
      needAi();
      return text.replace(/[ \t]{2,}/g, " ").replace(/\bteh\b/g, "the").replace(/(^|[.!?]\s+)([a-z])/g, (m, a, b) => a + b.toUpperCase());
    },
    async aiSummarize(text) {
      needAi();
      const plain = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, a) => a || t).replace(/\s+/g, " ").trim();
      return (plain.match(/^.*?[.!?](\s|$)/) || [plain])[0].trim();
    },
    async aiFillForm(kind, text) {
      needAi();
      const out = {};
      const date = text.match(/\b(20\d\d-\d\d-\d\d)\b/);
      if (kind === "hackathon" && date) out.date = date[1];
      const level = text.match(/\b(beginner|intermediate|advanced)\b/i);
      if (kind === "skill" && level) out.level = level[1].toLowerCase();
      const stack = [...new Set((text.match(/\b(Rust|Python|JavaScript|Tauri|Docker|React|Flask|C\+\+)\b/g) || []))];
      if ((kind === "hackathon" || kind === "project") && stack.length) out.stack = stack;
      return out;
    },
    async aiSuggest(id) {
      needAi();
      const it = items.get(id);
      const words = new Set(`${it.title} ${it.body}`.toLowerCase().split(/[^\p{L}\p{N}+#-]+/u));
      const all = [...new Set([...items.values()].flatMap(tagsOf))];
      const tags = all.filter(t => words.has(t) && !tagsOf(it).includes(t)).slice(0, 3);
      const lobe = lobes.find(l => l.name.toLowerCase().split(/[^a-z]+/).some(w => w.length > 2 && words.has(w)))?.id || null;
      return { tags, lobe: lobe === it.lobe ? null : lobe };
    },
    async aiApply(id, patch) {
      history.push(clone(items.get(id)));
      return api.updateItem(id, patch);
    },
    // Mirrors ask.rs: any-word search, 1-hop neighbours, fake cited answer when AI is "on".
    async ask(question) {
      const stop = new Set("a an and are as at be by can did do does for from have how i if in is it me my of on or should that the this to was what when where which who why with you about any know tell".split(" "));
      const words = question.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(w => w.length > 1 && !stop.has(w));
      const scored = [];
      for (const w of words) for (const h of await api.search(w, 10)) {
        const cur = scored.find(x => x.id === h.id);
        cur ? (cur.score += h.score) : scored.push({ ...h });
      }
      const ranked = scored.sort((a, b) => b.score - a.score).slice(0, 6).map(h => h.id);
      const edges = links();
      const sources = [];
      const add = (id, why) => { if (sources.length < 10 && !sources.some(s => s.id === id)) sources.push({ id, title: items.get(id).title, why }); };
      ranked.forEach(id => add(id, "match"));
      for (const id of ranked.slice(0, 3))
        for (const l of edges) if (l.source === id) add(l.target, "neighbour"); else if (l.target === id) add(l.source, "neighbour");
      if (!settings.ai.provider) return { answer: null, sources, cited: [], retrieval: "full-text" };
      const top = sources.slice(0, 2).map(s => items.get(s.id));
      const answer = top.length
        ? top.map(it => `${(it.body || it.summary || it.title).replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, a) => a || t).split(/(?<=[.!?])\s/)[0]} [[${it.title}]]`).join(" ")
        : "Your notes don't cover that.";
      return { answer: `(Browser preview answer) ${answer}`, sources, cited: top.map(t => t.id), retrieval: "full-text" };
    },
    async githubSync() {
      throw new Error("GitHub sync needs the desktop app (browser preview makes no network calls)");
    },
    async githubStatus() {
      return { configured: !!settings.github.token, last_sync: null };
    },
    async githubTest() {
      return { ok: false, message: "Browser preview: no network calls. Test this in the desktop app." };
    },
    on(event, fn) {
      if (event === "vault-changed") return api.onChange(fn);
      if (!eventListeners.has(event)) eventListeners.set(event, new Set());
      eventListeners.get(event).add(fn);
      return () => eventListeners.get(event).delete(fn);
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  const ready = seed ? api.importSample() : Promise.resolve();
  // every call waits for the seed, so nothing sees a half-filled vault
  const guarded = { onChange: api.onChange, on: api.on };
  for (const [k, fn] of Object.entries(api))
    if (k !== "onChange" && k !== "on" && k !== "importSample") guarded[k] = async (...a) => { await ready; return fn(...a); };
  guarded.importSample = api.importSample;
  return guarded;
}
