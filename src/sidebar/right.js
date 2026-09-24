// Right sidebar "Item" view: the selected item's summary, properties,
// outgoing links, backlinks and suggested (similar) items.

import { app } from "../state.js";
import { right } from "../shell/layout.js";
import { icon, typeIcon } from "../icons.js";
import { FIELDS, TYPE } from "../lib/types.js";
import { esc, openExternal } from "../util.js";

const fmt = v => (Array.isArray(v) ? v.join(", ") : typeof v === "object" && v ? JSON.stringify(v) : String(v));

export function initRightSidebar() {
  const pane = right.add({ id: "item", title: "Item", iconName: "info" });

  function linkList(edges) {
    const rows = edges
      .map(e => app.items.get(e.id))
      .filter(Boolean)
      .sort((a, b) => a.title.localeCompare(b.title))
      .map(n => `<button type="button" class="row item-row" data-id="${esc(n.id)}" title="${esc(n.title)}">
        ${typeIcon(n.type, app.lobeOf(n).color, 11)}<span class="row-title">${esc(n.title)}</span></button>`);
    return rows.length ? rows.join("") : `<div class="empty-note">None</div>`;
  }

  function section(key, title, iconName, count, content) {
    return `<section class="side-section" data-sec="${key}">
      <div class="side-label">${icon(iconName, { size: 13 })}<span>${title}</span>${count !== null ? `<span class="count">${count}</span>` : ""}</div>
      ${content}</section>`;
  }

  function render() {
    const n = app.items.get(app.selected);
    if (!n) {
      pane.innerHTML = `<div class="empty-note pad">Select an item in the graph or the file list.</div>`;
      return;
    }
    const lobe = app.lobeOf(n);
    const props = [...(FIELDS[n.type] || []), ...Object.keys(n).filter(k => !KNOWN.has(k) && !(FIELDS[n.type] || []).includes(k) && !k.startsWith("__") && !LAYOUT.has(k))]
      .filter(k => n[k] !== undefined && n[k] !== null && n[k] !== "" && !(Array.isArray(n[k]) && !n[k].length));
    const out = app.outgoing(n.id), back = app.backlinks(n.id), sim = app.similar(n.id);
    const excerpt = (n.body || "").replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, t, a) => a || t).slice(0, 280);

    pane.innerHTML = `
      <div class="item-head">
        <div class="item-kind">${typeIcon(n.type, lobe.color, 12)}<span>${esc(TYPE[n.type]?.one || n.type)}</span>
          <span class="sep">·</span><span class="dot" style="background:${lobe.color}"></span><span>${esc(lobe.name)}</span></div>
        <div class="item-title">${esc(n.title)}</div>
        ${n.tags?.length ? `<div class="tag-row">${n.tags.map(t => `<span class="tag">#${esc(t)}</span>`).join("")}</div>` : `<div class="tag-row"><span class="tag tag-inbox">Inbox</span></div>`}
        <div class="item-actions">
          <button type="button" class="btn" data-act="open">${icon("file", { size: 14 })}Open</button>
          ${n.url ? `<button type="button" class="btn" data-act="url">${icon("external", { size: 14 })}Visit</button>` : ""}
        </div>
      </div>
      ${excerpt ? `<div class="item-excerpt">${esc(excerpt)}${n.body.length > 280 ? "…" : ""}</div>` : ""}
      ${props.length ? section("props", "Properties", "filters", null, `<dl class="props">${props.map(k => `<dt>${esc(k.replace(/_/g, " "))}</dt><dd>${k === "url" ? `<a href="${esc(n[k])}" data-ext>${esc(n[k])}</a>` : esc(fmt(n[k]))}</dd>`).join("")}</dl>`) : ""}
      ${section("out", "Outgoing links", "outgoing", out.length, linkList(out))}
      ${section("back", "Backlinks", "backlinks", back.length, linkList(back))}
      ${section("sim", "Suggested", "suggested", sim.length, linkList(sim))}
      <div class="item-foot">${n.path ? esc(n.path) : ""}${n.updated ? ` · updated ${esc(String(n.updated).slice(0, 10))}` : ""}</div>`;
  }

  pane.addEventListener("click", e => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    const n = app.items.get(app.selected);
    if (act === "open" && n) app.open(n.id);
    if (act === "url" && n) openExternal(n.url);
    const a = e.target.closest("a[data-ext]");
    if (a) { e.preventDefault(); openExternal(a.getAttribute("href")); return; }
    const r = e.target.closest(".item-row");
    if (r) app.select(r.dataset.id, { source: "sidebar" });
  });
  pane.addEventListener("dblclick", e => {
    const r = e.target.closest(".item-row");
    if (r) app.open(r.dataset.id);
  });

  app.on("data", render);
  app.on("select", render);
  render();
  return { rect: () => pane.getBoundingClientRect() };
}

const KNOWN = new Set(["id", "type", "lobe", "title", "tags", "body", "path", "created", "updated", "degree"]);
const LAYOUT = new Set(["x", "y", "z", "vx", "vy", "vz", "fx", "fy", "fz", "index"]);
