// Sidebars: collapsible, resizable, state remembered. Each sidebar has icon tabs
// ("views") registered by the modules that fill them.

import { icon } from "../icons.js";
import { prefs } from "../lib/prefs.js";

const MIN = 180, MAX = 560;

function sidebar(side, defaults) {
  const root = document.getElementById(side);
  const tabs = document.getElementById(`${side}-tabs`);
  const body = document.getElementById(`${side}-body`);
  const resizer = document.querySelector(`.resizer[data-side="${side}"]`);
  const st = { ...defaults, ...prefs.get(`layout.${side}`, {}) };
  const views = [];

  const save = () => prefs.set(`layout.${side}`, { open: st.open, width: st.width, view: st.view });
  function apply() {
    root.style.width = `${st.width}px`;
    root.hidden = !st.open;
    resizer.hidden = !st.open;
    for (const v of views) {
      const on = v.id === st.view;
      v.pane.hidden = !on;
      v.tab.classList.toggle("on", on);
      v.tab.setAttribute("aria-selected", on);
    }
  }

  function add({ id, title, iconName, render }) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "side-tab";
    tab.title = title;
    tab.setAttribute("role", "tab");
    tab.innerHTML = icon(iconName);
    tab.addEventListener("click", () => show(id));
    tabs.appendChild(tab);
    const pane = document.createElement("div");
    pane.className = "side-pane";
    pane.dataset.view = id;
    body.appendChild(pane);
    views.push({ id, tab, pane, render });
    if (!views.some(v => v.id === st.view)) st.view = views[0].id;
    apply();
    return pane;
  }

  function show(id) {
    st.view = id;
    st.open = true;
    save();
    apply();
    window.dispatchEvent(new Event("resize"));
  }
  function toggle(open = !st.open) {
    st.open = open;
    save();
    apply();
    window.dispatchEvent(new Event("resize"));
  }

  // drag to resize
  resizer.addEventListener("pointerdown", e => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add("dragging");
    const startX = e.clientX, startW = st.width;
    const move = ev => {
      const dx = ev.clientX - startX;
      st.width = Math.round(Math.min(MAX, Math.max(MIN, startW + (side === "left" ? dx : -dx))));
      root.style.width = `${st.width}px`;
    };
    const up = () => {
      resizer.classList.remove("dragging");
      resizer.removeEventListener("pointermove", move);
      save();
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up, { once: true });
  });
  resizer.addEventListener("dblclick", () => { st.width = defaults.width; save(); apply(); });

  apply();
  // Small count on a view's icon (e.g. Inbox).
  function badge(id, n) {
    const v = views.find(x => x.id === id);
    if (!v) return;
    v.tab.dataset.badge = n > 0 ? (n > 99 ? "99+" : n) : "";
  }

  return { add, show, toggle, badge, get open() { return st.open; }, get view() { return st.view; } };
}

export const left = sidebar("left", { open: true, width: 250, view: "files" });
export const right = sidebar("right", { open: true, width: 300, view: "item" });

// Ribbon: a column of icon buttons on the far left.
const ribbon = document.getElementById("ribbon");
const top = document.createElement("div");
const bottom = document.createElement("div");
top.className = "ribbon-group";
bottom.className = "ribbon-group";
ribbon.append(top, bottom);

export function ribbonButton({ iconName, title, onClick, bottom: atBottom = false, id }) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ribbon-btn";
  b.title = title;
  if (id) b.id = id;
  b.innerHTML = icon(iconName, { size: 18 });
  b.addEventListener("click", onClick);
  (atBottom ? bottom : top).appendChild(b);
  return b;
}
