// Workspace tabs. The graph tab is always there (pinned, first). Item tabs
// are rendered by a registered renderer; open tabs are remembered.

import { app } from "../state.js";
import { icon, typeIcon } from "../icons.js";
import { esc } from "../util.js";
import { prefs } from "../lib/prefs.js";
import { right } from "./layout.js";

const bar = document.getElementById("tabbar");
const panes = document.getElementById("panes");

const tabs = [];          // { key, kind: "graph" | "item" | "view", id?, pane, view? }
let active = null;
const renderers = {};     // kind -> (pane, tab) => { update?(), destroy?(), focus?() }

function save() {
  prefs.set("tabs.open", tabs.filter(t => t.kind === "item").map(t => t.id));
  prefs.set("tabs.active", active?.key);
}

function titleOf(t) {
  if (t.kind === "graph") return { html: icon("graph", { size: 14 }), text: "Graph" };
  if (t.kind !== "item") return { html: icon(t.iconName || "file", { size: 14 }), text: t.title || t.kind };
  const n = app.items.get(t.id);
  if (!n) return { html: icon("file", { size: 14 }), text: "Missing" };
  return { html: typeIcon(n.type, app.lobeOf(n).color, 12), text: n.title };
}

function renderBar() {
  bar.innerHTML = tabs.map(t => {
    const { html, text } = titleOf(t);
    return `<div class="tab ${t === active ? "on" : ""} ${t.kind === "graph" ? "pinned" : ""}" data-key="${esc(t.key)}" title="${esc(text)}">
      ${html}<span class="tab-title">${esc(text)}</span>
      ${t.kind === "graph" ? "" : `<button type="button" class="tab-close" aria-label="Close tab">${icon("x", { size: 14 })}</button>`}
    </div>`;
  }).join("") + `<div class="tabbar-fill"></div>
    <button type="button" class="icon-btn" data-act="toggle-right" title="Toggle right sidebar">${icon("panel-right")}</button>`;
}

bar.addEventListener("click", e => {
  if (e.target.closest('[data-act="toggle-right"]')) { right.toggle(); return; }
  const tabEl = e.target.closest(".tab");
  if (!tabEl) return;
  const t = tabs.find(x => x.key === tabEl.dataset.key);
  if (e.target.closest(".tab-close")) close(t);
  else activate(t);
});
bar.addEventListener("auxclick", e => {
  const tabEl = e.target.closest(".tab");
  if (e.button === 1 && tabEl) close(tabs.find(x => x.key === tabEl.dataset.key));
});

function makeTab(kind, extra) {
  const pane = document.createElement("div");
  pane.className = `pane pane-${kind}`;
  pane.hidden = true;
  panes.appendChild(pane);
  const t = { kind, pane, ...extra };
  t.view = renderers[kind]?.(pane, t) || {};
  tabs.push(t);
  return t;
}

export const tabsApi = {
  register(kind, renderer) { renderers[kind] = renderer; },

  addGraph() {
    return makeTab("graph", { key: "graph" });
  },

  // Open an item in a tab (reuses its tab if already open).
  openItem(id, { background = false, mode, focusTitle = false } = {}) {
    let t = tabs.find(x => x.kind === "item" && x.id === id);
    if (!t) t = makeTab("item", { key: `item:${id}`, id, mode, focusTitle });
    else if (mode) t.view.setMode?.(mode);
    if (!background) activate(t);
    else renderBar();
    save();
    return t;
  },

  // Open a non-item view (e.g. settings) as a tab.
  openView(kind, { key = kind, title, iconName } = {}) {
    let t = tabs.find(x => x.key === key);
    if (!t) t = makeTab(kind, { key, title, iconName });
    activate(t);
    return t;
  },

  activate: key => activate(typeof key === "string" ? tabs.find(t => t.key === key) : key),
  close: key => close(typeof key === "string" ? tabs.find(t => t.key === key) : key),
  closeActive: () => active && active.kind !== "graph" && close(active),
  next(dir = 1) {
    if (!tabs.length) return;
    const i = tabs.indexOf(active);
    activate(tabs[(i + dir + tabs.length) % tabs.length]);
  },
  get active() { return active; },
  get all() { return tabs; },
  pane: key => tabs.find(t => t.key === key)?.pane,
  // After data changes: refresh titles, drop tabs whose item is gone.
  refresh() {
    for (const t of [...tabs]) {
      if (t.kind === "item" && !app.items.has(t.id)) close(t);
      else t.view.update?.();
    }
    renderBar();
  },
  restore() {
    for (const id of prefs.get("tabs.open", [])) if (app.items.has(id)) tabsApi.openItem(id, { background: true });
    const key = prefs.get("tabs.active", "graph");
    activate(tabs.find(t => t.key === key) || tabs[0]);
  },
  rect: () => panes.getBoundingClientRect(),
};

function activate(t) {
  if (!t) return;
  if (active && active !== t) { active.pane.hidden = true; active.view.hide?.(); }
  active = t;
  t.pane.hidden = false;
  t.view.show?.();
  renderBar();
  save();
  app.emit("tab", t);
}

function close(t) {
  if (!t || t.kind === "graph") return;
  const i = tabs.indexOf(t);
  tabs.splice(i, 1);
  t.view.destroy?.();
  t.pane.remove();
  if (active === t) {
    active = null;
    activate(tabs[Math.min(i, tabs.length - 1)] || tabs[0]);
  } else renderBar();
  save();
}
