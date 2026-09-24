// An item opened in a workspace tab. Milestone 1: reading view only
// (markdown rendered with wikilinks). The editor arrives in milestone 3.

import { app } from "../state.js";
import { md } from "./markdown.js";
import { typeIcon } from "../icons.js";
import { TYPE } from "../lib/types.js";
import { esc, openExternal } from "../util.js";

md.resolveWikilink = target => app.resolve(target);

export function itemTab(pane, tab) {
  pane.innerHTML = `<div class="doc"><div class="doc-inner"></div></div>`;
  const inner = pane.querySelector(".doc-inner");

  function render() {
    const n = app.items.get(tab.id);
    if (!n) return;
    const lobe = app.lobeOf(n);
    inner.innerHTML = `
      <div class="doc-meta">${typeIcon(n.type, lobe.color, 12)}<span>${esc(TYPE[n.type]?.one || n.type)}</span>
        <span class="sep">·</span><span class="dot" style="background:${lobe.color}"></span><span>${esc(lobe.name)}</span>
        ${n.path ? `<span class="sep">·</span><span class="path">${esc(n.path)}</span>` : ""}</div>
      <h1 class="doc-title">${esc(n.title)}</h1>
      ${n.tags?.length ? `<div class="tag-row">${n.tags.map(t => `<span class="tag">#${esc(t)}</span>`).join("")}</div>` : ""}
      <div class="markdown">${n.body ? md.render(n.body) : `<p class="muted">Empty.</p>`}</div>`;
  }

  inner.addEventListener("click", e => {
    const w = e.target.closest("a.wikilink");
    if (w) {
      e.preventDefault();
      if (w.dataset.id) app.open(w.dataset.id);
      return;
    }
    const a = e.target.closest("a[data-ext]");
    if (a) { e.preventDefault(); openExternal(a.getAttribute("href")); }
  });

  render();
  return {
    update: render,
    show: () => app.select(tab.id, { source: "tab" }),
  };
}
