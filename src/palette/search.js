// Ctrl K / "/" search over items. Milestone 1: keyword scoring in the browser.
// (Milestone 4 moves this to FTS in the backend.)

import { app } from "../state.js";
import { openPalette } from "./palette.js";
import { typeIcon } from "../icons.js";
import { TYPE } from "../lib/types.js";
import { esc } from "../util.js";

const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function haystacks(n) {
  return {
    title: n.title.toLowerCase(),
    tags: (n.tags || []).join(" ").toLowerCase(),
    text: [n.body, n.summary, n.built, n.url, ...(Array.isArray(n.stack) ? n.stack : [])].filter(Boolean).join(" ").toLowerCase(),
  };
}

// Every token must match somewhere; title matches weigh most.
function score(h, tokens) {
  let s = 0;
  for (const t of tokens) {
    if (h.title.startsWith(t)) s += 10;
    else if (h.title.includes(" " + t)) s += 7;
    else if (h.title.includes(t)) s += 5;
    else if (h.tags.includes(t)) s += 3;
    else if (h.text.includes(t)) s += 1;
    else return 0;
  }
  return s;
}

export function localSearch(query, limit = 12) {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const nodes = [...app.items.values()];
  if (!tokens.length) return nodes.sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, 8);
  return nodes
    .map(n => ({ n, s: score(haystacks(n), tokens) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.n.title.localeCompare(b.n.title))
    .slice(0, limit)
    .map(x => x.n);
}

function highlight(title, query) {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const out = esc(title);
  if (!tokens.length) return out;
  const re = new RegExp(`(${tokens.map(t => reEsc(esc(t))).join("|")})`, "gi");
  return out.replace(re, "<mark>$1</mark>");
}

export function openSearch({ onPick }) {
  openPalette({
    id: "search",
    placeholder: "Search notes, links, skills, projects",
    empty: "No matches",
    foot: `<span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Ctrl Enter</kbd> open in tab</span><span><kbd>Esc</kbd> close</span>`,
    source: async q => localSearch(q),
    render: (n, q) => {
      const lobe = app.lobeOf(n);
      const meta = [TYPE[n.type]?.one, ...(n.tags || []).slice(0, 3).map(t => "#" + t)].filter(Boolean).join(" · ");
      return `${typeIcon(n.type, lobe.color, 13)}
        <div class="r-main"><div class="r-title">${highlight(n.title, q)}</div><div class="r-meta">${esc(meta)}</div></div>
        <span class="r-side"><span class="dot" style="background:${lobe.color}"></span>${esc(lobe.name)}</span>`;
    },
    onPick,
  });
}
