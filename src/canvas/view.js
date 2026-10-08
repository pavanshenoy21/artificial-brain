// A .canvas file in a workspace tab, like Obsidian's canvas: cards (text,
// note, link, group) on an infinite board, joined by arrows.
//
// Mouse: drag empty space to pan (Shift drag selects a box), wheel pans,
// Ctrl wheel / pinch zooms. Double-click empty space for a new card, a card to
// edit or open it. Drag a dot on a card's side to connect it. Keys: Delete,
// Ctrl Z / Ctrl Shift Z, Ctrl A, Ctrl D duplicate, Enter edit, Esc deselect,
// arrows nudge. Changes save 500ms after the last edit, like notes.

import { app } from "../state.js";
import { api } from "../api.js";
import { md } from "../editor/markdown.js";
import { icon, typeIcon } from "../icons.js";
import { esc, openExternal } from "../util.js";
import { prefs } from "../lib/prefs.js";
import { toast } from "../shell/toast.js";
import { status } from "../shell/statusbar.js";
import { tabsApi } from "../shell/tabs.js";
import { openSearch } from "../palette/search.js";
import { followLink } from "../editor/item-tab.js";
import {
  PRESETS, PRESET_NAMES, colorOf, newId, normalize, edgePath, curve, anchor, arrowHead, nearestSide,
  bounds, inside, intersects, drawOrder, fitView, isImage, SIDES,
} from "./model.js";

const SIZES = { text: [250, 60], file: [400, 400], link: [400, 160], group: [400, 300] };
const ZMIN = 0.1, ZMAX = 2.5;

export function canvasTab(pane, tab) {
  pane.innerHTML = `
    <div class="cv">
      <div class="cv-bar">
        <input class="cv-title" spellcheck="false" aria-label="Canvas name" />
        <div class="cv-tools">
          <button type="button" class="btn-ghost" data-act="add-text" title="New card (double-click the board)">${icon("note", { size: 14 })}Card</button>
          <button type="button" class="btn-ghost" data-act="add-file" title="Add a note from the vault">${icon("file", { size: 14 })}Note</button>
          <button type="button" class="btn-ghost" data-act="add-link" title="Add a web link">${icon("link", { size: 14 })}Link</button>
          <button type="button" class="btn-ghost" data-act="add-group" title="Group the selection (or add an empty group)">${icon("group", { size: 14 })}Group</button>
          <span class="cv-sel" hidden>
            <span class="cv-sep"></span>
            <span class="cv-swatches">
              <button type="button" class="swatch none" data-color="" title="No colour"></button>
              ${Object.entries(PRESETS).map(([k, c]) => `<button type="button" class="swatch" data-color="${k}" style="background:${c}" title="${PRESET_NAMES[k]}"></button>`).join("")}
            </span>
            <button type="button" class="icon-btn" data-act="arrow" title="Arrow on/off">${icon("outgoing", { size: 14 })}</button>
            <button type="button" class="icon-btn" data-act="delete" title="Delete (Del)">${icon("trash", { size: 14 })}</button>
          </span>
          <span class="cv-fill"></span>
          <button type="button" class="icon-btn" data-act="undo" title="Undo (Ctrl Z)">${icon("undo", { size: 14 })}</button>
          <button type="button" class="icon-btn" data-act="redo" title="Redo (Ctrl Shift Z)">${icon("redo", { size: 14 })}</button>
          <span class="cv-sep"></span>
          <button type="button" class="icon-btn" data-act="zoom-out" title="Zoom out">${icon("zoom-out", { size: 14 })}</button>
          <button type="button" class="btn-ghost cv-zoom" data-act="zoom-reset" title="Reset zoom">100%</button>
          <button type="button" class="icon-btn" data-act="zoom-in" title="Zoom in">${icon("zoom-in", { size: 14 })}</button>
          <button type="button" class="btn-ghost" data-act="fit" title="Fit everything in view">Fit</button>
        </div>
      </div>
      <div class="cv-view" tabindex="0">
        <div class="cv-world">
          <svg class="cv-edges" width="1" height="1"></svg>
          <div class="cv-nodes"></div>
          <div class="cv-labels"></div>
        </div>
        <div class="cv-box" hidden></div>
        <div class="cv-msg" hidden></div>
        <div class="cv-hint">double-click to add a card · drag a side dot to connect · ctrl+scroll to zoom</div>
      </div>
    </div>`;
  const $ = s => pane.querySelector(s);
  const viewEl = $(".cv-view"), world = $(".cv-world"), nodesEl = $(".cv-nodes");
  const svg = $(".cv-edges"), labelsEl = $(".cv-labels"), boxEl = $(".cv-box"), msgEl = $(".cv-msg");
  const titleInput = $(".cv-title");
  const off = new AbortController();
  const on = (el, ev, fn, opts = {}) => el.addEventListener(ev, fn, { signal: off.signal, ...opts });

  let data = normalize({});
  let byId = new Map();
  let cam = null;                 // { x, y, z }: screen = world * z + (x, y)
  let sel = new Set();            // selected node ids
  let selEdge = null;             // selected edge id
  let editing = null;             // node id being edited
  let loaded = false;
  let lastSaved = "";
  let dirty = false, timer = null, saving = Promise.resolve();
  const undoStack = [], redoStack = [];
  const els = new Map();          // node id -> element
  let order = "";

  const item = () => app.items.get(tab.id);
  const viewKey = () => `canvas.view:${item()?.path || tab.id}`;

  // ---------------------------------------------------------------- load / save
  async function load() {
    try {
      data = normalize(await api.getCanvas(tab.id));
      lastSaved = JSON.stringify(data);
      loaded = true;
      msgEl.hidden = true;
    } catch (e) {
      loaded = false;
      msgEl.hidden = false;
      msgEl.textContent = String(e?.message || e);
    }
    render();
    if (!cam) {
      const saved = prefs.get(viewKey(), null);
      if (saved && Number.isFinite(saved.z)) setCam(saved);
      else fit(false);
    }
  }

  function changed() {
    dirty = true;
    render();
    clearTimeout(timer);
    timer = setTimeout(save, 500);
  }

  function save() {
    clearTimeout(timer);
    saving = saving.then(async () => {
      if (!loaded) return;
      const json = JSON.stringify(data);
      if (json === lastSaved) { dirty = false; return; }
      try {
        await api.saveCanvas(tab.id, structuredClone(data));
        lastSaved = json;
        dirty = JSON.stringify(data) !== json;
      } catch (e) {
        toast(`Canvas not saved: ${e}`, "error");
      }
    });
    return saving;
  }

  function snapshot() {
    undoStack.push(JSON.stringify(data));
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }
  function commit(fn) {
    if (!loaded) return;
    snapshot();
    fn();
    changed();
  }
  function undo(back = true) {
    const from = back ? undoStack : redoStack, to = back ? redoStack : undoStack;
    if (!from.length) return;
    to.push(JSON.stringify(data));
    data = normalize(JSON.parse(from.pop()));
    for (const id of [...sel]) if (!data.nodes.some(n => n.id === id)) sel.delete(id);
    if (selEdge && !data.edges.some(e => e.id === selEdge)) selEdge = null;
    changed();
  }

  // ---------------------------------------------------------------- camera
  function setCam(c) {
    cam = { x: c.x, y: c.y, z: Math.min(ZMAX, Math.max(ZMIN, c.z)) };
    world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
    const g = 20 * cam.z;
    viewEl.style.backgroundSize = `${g}px ${g}px`;
    viewEl.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
    viewEl.classList.toggle("far", cam.z < 0.45);
    $(".cv-zoom").textContent = `${Math.round(cam.z * 100)}%`;
    clearTimeout(setCam.t);
    setCam.t = setTimeout(() => prefs.set(viewKey(), cam), 300);
  }
  const rect = () => viewEl.getBoundingClientRect();
  function toWorld(cx, cy) {
    const r = rect();
    return { x: (cx - r.left - cam.x) / cam.z, y: (cy - r.top - cam.y) / cam.z };
  }
  function zoomAt(f, cx, cy) {
    const r = rect();
    const px = cx ?? r.left + r.width / 2, py = cy ?? r.top + r.height / 2;
    const z = Math.min(ZMAX, Math.max(ZMIN, cam.z * f));
    const wx = (px - r.left - cam.x) / cam.z, wy = (py - r.top - cam.y) / cam.z;
    setCam({ z, x: px - r.left - wx * z, y: py - r.top - wy * z });
  }
  function fit(onlySel = true) {
    const r = rect();
    const nodes = onlySel && sel.size ? data.nodes.filter(n => sel.has(n.id)) : data.nodes;
    if (!r.width) { cam = cam || { x: 0, y: 0, z: 1 }; return; }
    setCam(nodes.length ? fitView(bounds(nodes), r.width, r.height) : { x: r.width / 2, y: r.height / 2, z: 1 });
  }
  const viewCenter = () => { const r = rect(); return toWorld(r.left + r.width / 2, r.top + r.height / 2); };

  // ---------------------------------------------------------------- render
  function fileItem(path) {
    if (!path) return null;
    for (const n of app.items.values()) if (n.path === path) return n;
    const id = app.resolve(path);
    return id ? app.items.get(id) : null;
  }

  function nodeHtml(n) {
    if (n.type === "group") return `<div class="cv-group-label">${esc(n.label || "")}</div>`;
    if (n.type === "text") {
      if (editing === n.id) return "";
      return `<div class="cv-content markdown">${n.text?.trim() ? md.render(n.text) : `<p class="faint">Empty card</p>`}</div>`;
    }
    if (n.type === "link") {
      let host = n.url || "";
      try { host = new URL(n.url).hostname; } catch {}
      return `<div class="cv-head">${icon("link", { size: 13 })}<span>${esc(host)}</span></div>
        <div class="cv-content"><a href="${esc(n.url)}" data-ext class="cv-url">${esc(n.url)}</a></div>`;
    }
    if (n.type === "file") {
      const it = fileItem(n.file);
      const name = (n.file || "").split("/").pop();
      if (isImage(n.file)) {
        const src = api.fileUrl?.(n.file);
        return `<div class="cv-head">${icon("file", { size: 13 })}<span>${esc(name)}</span></div>
          ${src ? `<img class="cv-img" src="${esc(src)}" alt="${esc(name)}" draggable="false" />` : `<div class="cv-content faint">${esc(n.file)}</div>`}`;
      }
      if (!it) return `<div class="cv-head">${icon("file", { size: 13 })}<span>${esc(name || "file")}</span></div><div class="cv-content faint">Not in the vault: ${esc(n.file || "")}</div>`;
      const lobe = app.lobeOf(it);
      const head = `<div class="cv-head" title="${esc(it.path)}">${typeIcon(it.type, lobe.color, 12)}<span>${esc(it.title)}</span></div>`;
      if (it.type === "canvas") return `${head}<div class="cv-content faint">Canvas · ${it.cards ?? 0} cards. Double-click to open.</div>`;
      return `${head}<div class="cv-content markdown">${it.body?.trim() ? md.render(it.body) : `<p class="faint">Empty note</p>`}</div>`;
    }
    return `<div class="cv-content faint">${esc(n.type)} card</div>`;
  }

  const sig = n => {
    const it = n.type === "file" ? fileItem(n.file) : null;
    return JSON.stringify([n.type, n.text, n.file, n.url, n.label, editing === n.id, it && [it.title, it.body, it.type, it.lobe, it.cards]]);
  };

  function place(n) {
    const el = els.get(n.id);
    if (!el) return;
    el.style.transform = `translate(${n.x}px, ${n.y}px)`;
    el.style.width = `${n.width}px`;
    el.style.height = `${n.height}px`;
  }

  function render() {
    byId = new Map(data.nodes.map(n => [n.id, n]));
    const ordered = drawOrder(data.nodes);
    for (const [id, el] of els) if (!byId.has(id)) { el.remove(); els.delete(id); }
    for (const n of ordered) {
      let el = els.get(n.id);
      if (!el) {
        el = document.createElement("div");
        el.dataset.id = n.id;
        el.innerHTML = `<div class="cv-body"></div><div class="cv-resize"></div>${SIDES.map(s => `<div class="cv-port" data-side="${s}"></div>`).join("")}`;
        els.set(n.id, el);
        nodesEl.appendChild(el);
      }
      el.className = `cv-node cv-${n.type}${sel.has(n.id) ? " sel" : ""}${colorOf(n.color) ? " colored" : ""}${editing === n.id ? " editing" : ""}`;
      el.style.setProperty("--c", colorOf(n.color) || "");
      const s = sig(n);
      if (el.__sig !== s) {
        el.__sig = s;
        el.querySelector(".cv-body").innerHTML = nodeHtml(n);
      }
      place(n);
    }
    const nextOrder = ordered.map(n => n.id).join(",");
    if (nextOrder !== order) {
      order = nextOrder;
      for (const n of ordered) nodesEl.appendChild(els.get(n.id));
    }
    renderEdges();
    renderBar();
  }

  function edgeGeom(e) {
    const a = byId.get(e.fromNode), b = byId.get(e.toNode);
    return a && b ? edgePath(a, e.fromSide, b, e.toSide) : null;
  }

  function renderEdges(temp) {
    let paths = "";
    let labels = "";
    for (const e of data.edges) {
      const g = edgeGeom(e);
      if (!g) continue;
      const c = colorOf(e.color);
      const style = c ? ` style="--c:${c}"` : "";
      const on = e.id === selEdge ? " sel" : "";
      const toArrow = (e.toEnd ?? "arrow") === "arrow", fromArrow = e.fromEnd === "arrow";
      paths += `<g class="cv-edge${on}${c ? " colored" : ""}" data-edge="${esc(e.id)}"${style}>
        <path class="hit" d="${g.d}"/><path class="line" d="${g.d}"/>
        ${toArrow ? `<path class="head" d="${arrowHead(g.end, g.endDir)}"/>` : ""}
        ${fromArrow ? `<path class="head" d="${arrowHead(g.start, g.startDir)}"/>` : ""}</g>`;
      if (e.label) labels += `<div class="cv-edge-label${on}" data-edge="${esc(e.id)}" style="transform:translate(${g.mid.x}px, ${g.mid.y}px) translate(-50%, -50%)">${esc(e.label)}</div>`;
    }
    if (temp) paths += `<g class="cv-edge temp"><path class="line" d="${temp.d}"/><path class="head" d="${arrowHead(temp.end, temp.endDir)}"/></g>`;
    svg.innerHTML = paths;
    labelsEl.innerHTML = labels;
  }

  function renderBar() {
    const n = data.nodes.length, m = data.edges.length;
    const anySel = sel.size > 0 || !!selEdge;
    $(".cv-sel").hidden = !anySel;
    $('[data-act="arrow"]').hidden = !selEdge;
    $('[data-act="undo"]').disabled = !undoStack.length;
    $('[data-act="redo"]').disabled = !redoStack.length;
    for (const b of pane.querySelectorAll(".cv-tools button")) if (!["undo", "redo"].includes(b.dataset.act)) b.disabled = !loaded;
    $(".cv-hint").hidden = n > 0 || !loaded;
    if (tabsApi.active === tab) status.set("tab", `${n} card${n === 1 ? "" : "s"} · ${m} connection${m === 1 ? "" : "s"}${dirty ? " · editing" : ""}`);
    const it = item();
    if (it && document.activeElement !== titleInput) titleInput.value = it.title;
  }

  // ---------------------------------------------------------------- edits
  const taken = () => new Set([...data.nodes.map(n => n.id), ...data.edges.map(e => e.id)]);

  function addNode(type, at, extra = {}) {
    const [w, h] = SIZES[type];
    const n = { id: newId(taken()), type, ...extra, x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), width: w, height: h };
    data.nodes.push(n);
    sel = new Set([n.id]);
    selEdge = null;
    return n;
  }

  function addText(at, edit = true) {
    let n;
    commit(() => { n = addNode("text", at, { text: "" }); });
    if (edit && n) startEdit(n.id);
    return n;
  }

  function addFile(it, at = viewCenter()) {
    commit(() => addNode("file", at, { file: it.path }));
  }

  function addLink(url, at = viewCenter()) {
    commit(() => addNode("link", at, { url }));
  }

  function addGroup() {
    commit(() => {
      const chosen = data.nodes.filter(n => sel.has(n.id));
      if (chosen.length) {
        const b = bounds(chosen);
        const g = { id: newId(taken()), type: "group", label: "Group", x: b.x - 30, y: b.y - 30, width: b.width + 60, height: b.height + 60 };
        data.nodes.push(g);
        sel = new Set([g.id]);
      } else addNode("group", viewCenter(), { label: "Group" });
    });
  }

  function removeSelection() {
    if (!sel.size && !selEdge) return;
    commit(() => {
      data.nodes = data.nodes.filter(n => !sel.has(n.id));
      data.edges = data.edges.filter(e => e.id !== selEdge && !sel.has(e.fromNode) && !sel.has(e.toNode));
      sel.clear();
      selEdge = null;
    });
  }

  function duplicate() {
    if (!sel.size) return;
    commit(() => {
      const map = new Map();
      const ids = taken();
      for (const n of data.nodes.filter(x => sel.has(x.id))) {
        const c = { ...structuredClone(n), id: newId(ids), x: n.x + 30, y: n.y + 30 };
        ids.add(c.id);
        map.set(n.id, c.id);
        data.nodes.push(c);
      }
      for (const e of data.edges.filter(e => map.has(e.fromNode) && map.has(e.toNode))) {
        const c = { ...structuredClone(e), id: newId(ids), fromNode: map.get(e.fromNode), toNode: map.get(e.toNode) };
        ids.add(c.id);
        data.edges.push(c);
      }
      sel = new Set(map.values());
    });
  }

  function setColor(c) {
    commit(() => {
      for (const n of data.nodes) if (sel.has(n.id)) (c ? (n.color = c) : delete n.color);
      for (const e of data.edges) if (e.id === selEdge) (c ? (e.color = c) : delete e.color);
    });
  }

  function toggleArrow() {
    const e = data.edges.find(x => x.id === selEdge);
    if (!e) return;
    commit(() => { e.toEnd = (e.toEnd ?? "arrow") === "arrow" ? "none" : "arrow"; });
  }

  function nudge(dx, dy) {
    if (!sel.size) return;
    commit(() => {
      for (const n of movingSet()) { n.x += dx; n.y += dy; }
    });
  }

  // selected nodes + everything inside selected groups
  function movingSet() {
    const out = new Set(data.nodes.filter(n => sel.has(n.id)));
    for (const g of [...out].filter(n => n.type === "group")) for (const n of data.nodes) if (inside(n, g)) out.add(n);
    return [...out];
  }

  // ---------------------------------------------------------------- inline editing
  function startEdit(id) {
    const n = byId.get(id) || data.nodes.find(x => x.id === id);
    if (!n || !loaded) return;
    if (n.type === "group") return editInline(n, "label", pane.querySelector(`.cv-node[data-id="${CSS.escape(id)}"] .cv-group-label`));
    if (n.type === "link") return editInline(n, "url", pane.querySelector(`.cv-node[data-id="${CSS.escape(id)}"] .cv-content`));
    if (n.type === "file") {
      const it = fileItem(n.file);
      if (it) app.open(it.id);
      return;
    }
    if (n.type !== "text") return;
    editing = id;
    sel = new Set([id]);
    render();
    const body = els.get(id).querySelector(".cv-body");
    const ta = document.createElement("textarea");
    ta.className = "cv-edit";
    ta.spellcheck = false;
    ta.value = n.text || "";
    body.appendChild(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const before = n.text || "";
    let done = false;
    const finish = keep => {
      if (done) return;
      done = true;
      editing = null;
      const value = keep ? ta.value : before;
      if (value !== before) {
        snapshot();
        n.text = value;
        changed();
      } else render();
      viewEl.focus({ preventScroll: true });
    };
    ta.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); finish(true); }
    });
    ta.addEventListener("blur", () => finish(true));
    ta.addEventListener("pointerdown", e => e.stopPropagation());
    ta.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
  }

  // one-line edit for group labels, link URLs and edge labels
  function editInline(obj, key, anchorEl, at) {
    if (!loaded) return;
    const input = document.createElement("input");
    input.className = "cv-inline";
    input.value = obj[key] || "";
    input.spellcheck = false;
    if (anchorEl) {
      anchorEl.replaceChildren(input);
    } else {
      input.classList.add("floating");
      input.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -50%)`;
      labelsEl.appendChild(input);
    }
    input.focus();
    input.select();
    let done = false;
    const finish = keep => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (keep && v !== (obj[key] || "")) commit(() => (v ? (obj[key] = v) : delete obj[key]));
      else {
        for (const el of els.values()) el.__sig = null;
        render();
      }
      viewEl.focus({ preventScroll: true });
    };
    input.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("pointerdown", e => e.stopPropagation());
  }

  // ---------------------------------------------------------------- pointer
  let drag = null;

  on(viewEl, "pointerdown", e => {
    if (e.button === 2) return;
    if (!loaded) return;
    viewEl.focus({ preventScroll: true });
    const p = toWorld(e.clientX, e.clientY);
    const nodeEl = e.target.closest(".cv-node");
    const port = e.target.closest(".cv-port");
    const edgeEl = e.target.closest("[data-edge]");
    const middle = e.button === 1;

    if (middle || (!nodeEl && !edgeEl && !e.shiftKey)) {
      drag = { kind: "pan", sx: e.clientX, sy: e.clientY, cam: { ...cam }, moved: false };
      if (!middle) { sel.clear(); selEdge = null; render(); }
    } else if (port && nodeEl) {
      drag = { kind: "connect", from: nodeEl.dataset.id, side: port.dataset.side };
    } else if (e.target.closest(".cv-resize") && nodeEl) {
      const n = byId.get(nodeEl.dataset.id);
      drag = { kind: "resize", n, w: n.width, h: n.height, p, snap: false };
    } else if (nodeEl) {
      const id = nodeEl.dataset.id;
      if (editing === id) return;
      selEdge = null;
      if (e.shiftKey) sel.has(id) ? sel.delete(id) : sel.add(id);
      else if (!sel.has(id)) sel = new Set([id]);
      render();
      const moving = movingSet();
      drag = { kind: "move", p, start: moving.map(n => [n, n.x, n.y]), moved: false, target: e.target, id };
    } else if (edgeEl) {
      sel.clear();
      selEdge = edgeEl.dataset.edge;
      render();
      return;
    } else {
      drag = { kind: "box", p, base: e.shiftKey ? new Set(sel) : new Set() };
    }
    viewEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  on(viewEl, "pointermove", e => {
    if (!drag) {
      viewEl.classList.toggle("ctrl", e.ctrlKey);
      return;
    }
    const p = toWorld(e.clientX, e.clientY);
    if (drag.kind === "pan") {
      drag.moved ||= Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 3;
      setCam({ ...drag.cam, x: drag.cam.x + e.clientX - drag.sx, y: drag.cam.y + e.clientY - drag.sy });
    } else if (drag.kind === "move") {
      const dx = Math.round(p.x - drag.p.x), dy = Math.round(p.y - drag.p.y);
      if (!drag.moved && Math.hypot(dx, dy) * cam.z < 3) return;
      if (!drag.moved) { snapshot(); drag.moved = true; }
      for (const [n, x, y] of drag.start) { n.x = x + dx; n.y = y + dy; place(n); }
      renderEdges();
    } else if (drag.kind === "resize") {
      if (!drag.snap) { snapshot(); drag.snap = true; }
      drag.n.width = Math.max(60, Math.round(drag.w + p.x - drag.p.x));
      drag.n.height = Math.max(40, Math.round(drag.h + p.y - drag.p.y));
      place(drag.n);
      renderEdges();
    } else if (drag.kind === "connect") {
      const from = byId.get(drag.from);
      const overEl = document.elementFromPoint(e.clientX, e.clientY)?.closest(".cv-node");
      const over = overEl && overEl.dataset.id !== drag.from ? byId.get(overEl.dataset.id) : null;
      const end = over ? anchor(over, nearestSide(over, p)) : p;
      const g = curve(anchor(from, drag.side), drag.side, end, over ? nearestSide(over, p) : null);
      renderEdges(g);
      drag.over = over;
      drag.p = p;
    } else if (drag.kind === "box") {
      const r = { x: Math.min(p.x, drag.p.x), y: Math.min(p.y, drag.p.y), width: Math.abs(p.x - drag.p.x), height: Math.abs(p.y - drag.p.y) };
      Object.assign(boxEl.style, { left: `${r.x * cam.z + cam.x}px`, top: `${r.y * cam.z + cam.y}px`, width: `${r.width * cam.z}px`, height: `${r.height * cam.z}px` });
      boxEl.hidden = false;
      sel = new Set(drag.base);
      for (const n of data.nodes) if (intersects(n, r)) sel.add(n.id);
      for (const [id, el] of els) el.classList.toggle("sel", sel.has(id));
      renderBar();
    }
  });

  const endDrag = e => {
    if (!drag) return;
    const d = drag;
    drag = null;
    boxEl.hidden = true;
    if (d.kind === "move") {
      if (d.moved) changed();
      else {
        // a plain click: follow links inside the card
        const a = d.target.closest?.("a");
        if (a?.classList.contains("wikilink")) followLink(a.dataset.target);
        else if (a?.hasAttribute("data-ext")) openExternal(a.getAttribute("href"));
        else render();
      }
    } else if (d.kind === "resize") {
      if (d.snap) changed();
    } else if (d.kind === "connect") {
      if (d.over) {
        const side = nearestSide(d.over, d.p);
        commit(() => data.edges.push({ id: newId(taken()), fromNode: d.from, fromSide: d.side, toNode: d.over.id, toSide: side }));
      } else if (d.p) {
        // dropped on empty board: new card there, connected
        commit(() => {
          const n = addNode("text", d.p, { text: "" });
          const opposite = { top: "bottom", bottom: "top", left: "right", right: "left" }[d.side];
          data.edges.push({ id: newId(taken()), fromNode: d.from, fromSide: d.side, toNode: n.id, toSide: opposite });
        });
        startEdit([...sel][0]);
      } else renderEdges();
    } else if (d.kind === "box") {
      render();
    }
    if (e?.pointerId != null && viewEl.hasPointerCapture(e.pointerId)) viewEl.releasePointerCapture(e.pointerId);
  };
  on(viewEl, "pointerup", endDrag);
  on(viewEl, "pointercancel", endDrag);
  // links inside cards are handled on pointerup; never navigate
  on(viewEl, "click", e => { if (e.target.closest("a")) e.preventDefault(); });

  on(viewEl, "dblclick", e => {
    if (!loaded) return;
    const nodeEl = e.target.closest(".cv-node");
    const edgeEl = e.target.closest("[data-edge]");
    if (nodeEl) {
      const n = byId.get(nodeEl.dataset.id);
      if (n.type === "link" && !e.target.closest(".cv-content")) openExternal(n.url);
      else if (n.type === "group" && !e.target.closest(".cv-group-label")) return;
      else startEdit(n.id);
    } else if (edgeEl) {
      const edge = data.edges.find(x => x.id === edgeEl.dataset.edge);
      const g = edge && edgeGeom(edge);
      if (g) editInline(edge, "label", null, g.mid);
    } else addText(toWorld(e.clientX, e.clientY));
  });

  on(viewEl, "wheel", e => {
    if (!cam) return;
    // let a selected card's own content scroll
    const content = e.target.closest(".cv-node.sel .cv-content");
    if (content && !e.ctrlKey && content.scrollHeight > content.clientHeight + 1) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const dy = Math.max(-50, Math.min(50, e.deltaY));
      zoomAt(Math.exp(-dy * 0.006), e.clientX, e.clientY);
    } else {
      const k = e.deltaMode === 1 ? 20 : 1;
      const dx = (e.shiftKey ? e.deltaY : e.deltaX) * k, dy = (e.shiftKey ? 0 : e.deltaY) * k;
      setCam({ ...cam, x: cam.x - dx, y: cam.y - dy });
    }
  }, { passive: false });

  // drag a note from the file list, a URL or text onto the board
  on(viewEl, "dragover", e => { if (loaded) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  on(viewEl, "drop", e => {
    if (!loaded) return;
    e.preventDefault();
    const at = toWorld(e.clientX, e.clientY);
    const id = e.dataTransfer.getData("application/x-brain-item");
    const it = id && app.items.get(id);
    if (it) { addFile(it, at); return; }
    const text = (e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain") || "").trim();
    if (!text) return;
    if (/^https?:\/\/\S+$/.test(text)) addLink(text, at);
    else commit(() => addNode("text", at, { text }));
  });

  // ---------------------------------------------------------------- keys
  on(viewEl, "keydown", e => {
    if (e.target !== viewEl) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === "z") { e.preventDefault(); undo(!e.shiftKey); }
    else if (mod && k === "y") { e.preventDefault(); undo(false); }
    else if (mod && k === "a") { e.preventDefault(); sel = new Set(data.nodes.map(n => n.id)); selEdge = null; render(); }
    else if (mod && k === "d") { e.preventDefault(); duplicate(); }
    else if (mod && (k === "=" || k === "+")) { e.preventDefault(); zoomAt(1.2); }
    else if (mod && k === "-") { e.preventDefault(); zoomAt(1 / 1.2); }
    else if (mod && k === "0") { e.preventDefault(); fit(false); }
    else if (mod) return;
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeSelection(); }
    else if (e.key === "Escape") {
      if (sel.size || selEdge) { e.stopPropagation(); sel.clear(); selEdge = null; render(); }
    } else if (e.key === "Enter" && sel.size === 1) { e.preventDefault(); startEdit([...sel][0]); }
    else if (e.key.startsWith("Arrow") && sel.size) {
      e.preventDefault();
      const s = e.shiftKey ? 1 : 10;
      nudge({ ArrowLeft: -s, ArrowRight: s }[e.key] || 0, { ArrowUp: -s, ArrowDown: s }[e.key] || 0);
    }
  });

  // ---------------------------------------------------------------- toolbar
  on(pane.querySelector(".cv-bar"), "click", e => {
    const sw = e.target.closest(".swatch");
    if (sw) { setColor(sw.dataset.color); return; }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "add-text") addText(viewCenter());
    else if (act === "add-file") openSearch({ onPick: it => (it.id === tab.id ? toast("A canvas can't contain itself") : addFile(it)) });
    else if (act === "add-link") {
      const n = addText(viewCenter(), false);
      if (n) {
        // becomes a link card once a URL is typed
        n.type = "link"; delete n.text; n.url = "https://"; n.width = SIZES.link[0]; n.height = SIZES.link[1];
        render();
        startEdit(n.id);
      }
    }
    else if (act === "add-group") addGroup();
    else if (act === "delete") removeSelection();
    else if (act === "arrow") toggleArrow();
    else if (act === "undo") undo(true);
    else if (act === "redo") undo(false);
    else if (act === "zoom-in") zoomAt(1.2);
    else if (act === "zoom-out") zoomAt(1 / 1.2);
    else if (act === "zoom-reset") zoomAt(1 / cam.z);
    else if (act === "fit") fit(false);
    // the search palette (Note) and inline editors keep their own focus
    if (!["add-file", "add-text", "add-link"].includes(act)) viewEl.focus({ preventScroll: true });
  });

  async function rename() {
    const it = item();
    const title = titleInput.value.replace(/\s+/g, " ").trim();
    if (!it || !title || title === it.title) { titleInput.value = it?.title ?? ""; return; }
    await tabsApi.saveAll();
    try {
      const next = await api.updateItem(tab.id, { title });
      prefs.set(`canvas.view:${next.path}`, cam);
      await app.reload();
      app.open(next.id);
    } catch (e) {
      toast(`Rename failed: ${e}`, "error");
      titleInput.value = it.title;
    }
  }
  on(titleInput, "keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); titleInput.blur(); }
    if (e.key === "Escape") { titleInput.value = item()?.title ?? ""; titleInput.blur(); }
  });
  on(titleInput, "blur", rename);

  // keep the board in place when the pane is resized
  let size = null;
  const ro = new ResizeObserver(() => {
    const r = rect();
    if (!r.width) return;
    if (!cam) { fit(false); return; }
    if (size) setCam({ ...cam, x: cam.x + (r.width - size.w) / 2, y: cam.y + (r.height - size.h) / 2 });
    size = { w: r.width, h: r.height };
  });
  ro.observe(viewEl);

  load();

  return {
    // Vault reloaded: refresh note cards; take the file's version if we have no unsaved edits.
    async update() {
      render();
      if (dirty || drag || editing) return;
      try {
        const fresh = normalize(await api.getCanvas(tab.id));
        const json = JSON.stringify(fresh);
        if (!loaded || (json !== lastSaved && !dirty && !drag && !editing)) {
          data = fresh;
          lastSaved = json;
          loaded = true;
          msgEl.hidden = true;
          render();
        }
      } catch {}
    },
    show() {
      app.select(tab.id, { source: "tab" });
      renderBar();
      if (tab.focusTitle) { tab.focusTitle = false; titleInput.focus(); titleInput.select(); }
      else viewEl.focus({ preventScroll: true });
    },
    hide() { save(); status.set("tab", ""); },
    setMode() {},
    toggleMode() {},
    focus: () => viewEl.focus({ preventScroll: true }),
    save,
    selection: () => null,
    destroy() {
      save().then(() => { off.abort(); ro.disconnect(); });
    },
    // for tests and devtools
    get data() { return data; },
    get camera() { return cam; },
  };
}
