// Ctrl K / "/" search. Results come from the backend's full-text index
// (FTS5 bm25 in Rust, a rough stand-in in the mock). Once embeddings exist
// (milestone 6) a semantic score is blended in via setSemanticSearch().

import { app } from "../state.js";
import { api } from "../api.js";
import { openPalette } from "./palette.js";
import { typeIcon } from "../icons.js";
import { TYPE } from "../lib/types.js";
import { esc } from "../util.js";
import { blend } from "../lib/rank.js";

const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Optional semantic ranker: (query) => Promise<[{ id, score (0..1) }]>
let semantic = null;
export function setSemanticSearch(fn) { semantic = fn; }

async function source(q) {
  if (!q.trim()) {
    // no query: recently updated first, then most connected
    return [...app.items.values()]
      .sort((a, b) => String(b.updated || "").localeCompare(String(a.updated || "")) || (b.degree || 0) - (a.degree || 0))
      .slice(0, 8)
      .map(n => ({ n, snippet: "" }));
  }
  let hits = await api.search(q, 30).catch(() => []);
  if (semantic) {
    const sem = await semantic(q).catch(() => []);
    hits = blend(hits, sem);
  }
  return hits
    .map(h => ({ n: app.items.get(h.id), snippet: h.snippet, semantic: h.semantic }))
    .filter(r => r.n)
    .slice(0, 14);
}

function highlight(title, query) {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const out = esc(title);
  if (!tokens.length) return out;
  const re = new RegExp(`(${tokens.map(t => reEsc(esc(t))).join("|")})`, "gi");
  return out.replace(re, "<mark>$1</mark>");
}

const snippetHtml = s => esc(s.replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_, t, a) => a || t))
  .replace(/\u0001/g, "<mark>").replace(/\u0002/g, "</mark>");

export function openSearch({ onPick }) {
  openPalette({
    id: "search",
    placeholder: "Search notes, links, skills, projects",
    empty: "No matches",
    foot: `<span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Ctrl Enter</kbd> open in tab</span><span><kbd>Esc</kbd> close</span>`,
    source,
    render: ({ n, snippet }, q) => {
      const lobe = app.lobeOf(n);
      const meta = snippet?.includes("\u0001")
        ? snippetHtml(snippet)
        : esc([TYPE[n.type]?.one, ...(n.tags || []).slice(0, 3).map(t => "#" + t)].filter(Boolean).join(" · "));
      return `${typeIcon(n.type, lobe.color, 13)}
        <div class="r-main"><div class="r-title">${highlight(n.title, q)}</div><div class="r-meta">${meta}</div></div>
        <span class="r-side"><span class="dot" style="background:${lobe.color}"></span>${esc(lobe.name)}</span>`;
    },
    onPick: (r, opts) => onPick(r.n, opts),
  });
}
