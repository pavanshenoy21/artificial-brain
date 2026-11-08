// Ctrl K / "/" search (like Obsidian's quick switcher, plus full text).
// Results come from the backend's full-text index (FTS5 bm25 in Rust, a rough
// stand-in in the mock).

import { app } from "../state.js";
import { allTags } from "../lib/tags.js";
import { api } from "../api.js";
import { openPalette } from "./palette.js";
import { itemIcon } from "../icons.js";
import { esc } from "../util.js";
import { folderOf } from "../lib/folders.js";

const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function source(q) {
  if (!q.trim()) {
    // no query: recently updated first, then most connected
    return [...app.items.values()]
      .sort((a, b) => String(b.updated || "").localeCompare(String(a.updated || "")) || (b.degree || 0) - (a.degree || 0))
      .slice(0, 8)
      .map(n => ({ n, snippet: "" }));
  }
  const hits = await api.search(q, 30).catch(() => []);
  return hits
    .map(h => ({ n: app.items.get(h.id), snippet: h.snippet }))
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
    placeholder: "Find or search notes",
    empty: "No matches",
    foot: `<span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Ctrl Enter</kbd> open in tab</span><span><kbd>Esc</kbd> close</span>`,
    source,
    render: ({ n, snippet }, q) => {
      const meta = snippet?.includes("\u0001")
        ? snippetHtml(snippet)
        : esc(allTags(n).slice(0, 4).map(t => "#" + t).join(" "));
      const folder = folderOf(n.path);
      return `${itemIcon(n, app.colorOf(n))}
        <div class="r-main"><div class="r-title">${highlight(n.title, q)}</div><div class="r-meta">${meta}</div></div>
        <span class="r-side">${esc(folder)}</span>`;
    },
    onPick: (r, opts) => onPick(r.n, opts),
  });
}
