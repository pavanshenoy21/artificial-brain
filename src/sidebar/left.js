// Left sidebar: the file explorer (like Obsidian's) and Tags.

import { app } from "../state.js";
import { allTags } from "../lib/tags.js";
import { left } from "../shell/layout.js";
import { icon, itemIcon } from "../icons.js";
import { esc, setHtml } from "../util.js";
import { prefs } from "../lib/prefs.js";
import { openMenu } from "../shell/menu.js";
import { tabsApi } from "../shell/tabs.js";
import { folderOf } from "../lib/folders.js";
import { fileMenu, folderMenu } from "./menus.js";
import { newNote, newFolder, newCanvas, renameItem, renameFolder, moveItem, deleteItem, deleteFolder, wikilinkTo } from "../actions.js";

const nameOf = p => p.split("/").pop();
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
const SORTS = {
  "name-asc": { label: "File name (A to Z)", cmp: (a, b) => natural(a.title, b.title) },
  "name-desc": { label: "File name (Z to A)", cmp: (a, b) => natural(b.title, a.title) },
};

export function initLeftSidebar({ graph }) {
  // ---------------------------------------------------------------- file explorer
  const files = left.add({ id: "files", title: "Files", iconName: "files" });
  files.innerHTML = `<div class="nav-buttons">
      <button type="button" class="icon-btn" data-act="new-note" title="New note">${icon("new-note")}</button>
      <button type="button" class="icon-btn" data-act="new-folder" title="New folder">${icon("folder-plus")}</button>
      <button type="button" class="icon-btn" data-act="new-canvas" title="New canvas">${icon("canvas")}</button>
      <button type="button" class="icon-btn" data-act="sort" title="Change sort order">${icon("sort")}</button>
      <button type="button" class="icon-btn" data-act="collapse" title="Collapse all">${icon("collapse-all")}</button>
    </div><div class="tree explorer" role="tree" tabindex="-1"></div>`;
  const tree = files.querySelector(".tree");
  const open = new Set(prefs.get("files.openFolders", []));
  let sort = prefs.get("files.sort", "name-asc");
  let renaming = null; // { kind: "file" | "folder", path }
  const saveOpen = () => prefs.set("files.openFolders", [...open]);
  const activeId = () => (tabsApi.active?.kind === "item" ? tabsApi.active.id : null);

  function build() {
    const root = { path: "", dirs: new Map(), files: [] };
    const dir = path => {
      let node = root;
      let cur = "";
      for (const part of path ? path.split("/") : []) {
        cur = cur ? `${cur}/${part}` : part;
        if (!node.dirs.has(part)) node.dirs.set(part, { path: cur, dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      return node;
    };
    for (const f of app.folders) dir(f);
    for (const n of app.items.values()) dir(folderOf(n.path)).files.push(n);
    return root;
  }

  const count = d => d.files.length + [...d.dirs.values()].reduce((s, x) => s + count(x), 0);

  function fileRow(n, depth) {
    const editing = renaming?.kind === "file" && renaming.path === n.id;
    const title = editing
      ? `<input class="rename-input" value="${esc(n.title)}" spellcheck="false" aria-label="New name" />`
      : `<span class="row-title">${esc(n.title)}</span>${n.type === "canvas" ? `<span class="ext">canvas</span>` : ""}`;
    return `<div class="row item-row file-row${n.id === activeId() ? " active" : ""}${n.id === app.selected ? " on" : ""}" data-id="${esc(n.id)}"
      role="treeitem" tabindex="-1" draggable="${!editing}" title="${esc(n.path)}" style="--depth:${depth}">
      ${itemIcon(n, app.colorOf(n))}${title}</div>`;
  }

  function folderRow(d, depth) {
    const editing = renaming?.kind === "folder" && renaming.path === d.path;
    const isOpen = open.has(d.path);
    const name = nameOf(d.path);
    return `<div class="group">
      <div class="row folder-row" data-folder="${esc(d.path)}" role="treeitem" aria-expanded="${isOpen}" tabindex="-1" draggable="${!editing}" style="--depth:${depth}" title="${esc(d.path)}">
        ${icon(isOpen ? "chevron-down" : "chevron-right", { size: 14, cls: "chev" })}
        <span class="dot folder-dot" style="background:${app.scheme.folder(d.path)}"></span>
        ${editing ? `<input class="rename-input" value="${esc(name)}" spellcheck="false" aria-label="New folder name" />` : `<span class="row-title">${esc(name)}</span>`}
        <span class="count">${count(d) || ""}</span>
      </div>
      ${isOpen ? render(d, depth + 1) : ""}
    </div>`;
  }

  function render(d, depth) {
    const dirs = [...d.dirs.values()].sort((a, b) => natural(nameOf(a.path), nameOf(b.path)) * (sort === "name-desc" ? -1 : 1));
    return dirs.map(x => folderRow(x, depth)).join("") + [...d.files].sort(SORTS[sort].cmp).map(n => fileRow(n, depth)).join("");
  }

  function renderFiles(force = false) {
    // don't redraw under an open rename box
    if (renaming && tree.querySelector(".rename-input") && !force) return;
    const html = render(build(), 0) || `<div class="empty-note">No files yet.</div>`;
    setHtml(tree, html, force);
    const input = tree.querySelector(".rename-input");
    if (input && document.activeElement !== input) {
      input.focus();
      input.select();
    }
  }

  // ---- inline rename
  function startRename(kind, path) {
    for (let f = folderOf(path); f; f = folderOf(f)) open.add(f);
    saveOpen();
    left.show("files");
    renaming = { kind, path };
    renderFiles(true);
  }
  async function finishRename(keep) {
    const r = renaming;
    const input = tree.querySelector(".rename-input");
    if (!r || !input) return;
    const value = input.value.trim();
    renaming = null;
    if (keep && value) {
      if (r.kind === "file") {
        const n = app.items.get(r.path);
        if (n && value !== n.title) await renameItem(r.path, value);
      } else if (value !== nameOf(r.path)) {
        const parent = folderOf(r.path);
        await renameFolder(r.path, parent ? `${parent}/${value}` : value);
      }
    }
    renderFiles(true);
    tree.querySelector(".row.on, .row.active")?.focus();
  }
  tree.addEventListener("keydown", e => {
    if (!e.target.classList.contains("rename-input")) return;
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finishRename(true); }
    if (e.key === "Escape") { e.preventDefault(); finishRename(false); }
  });
  tree.addEventListener("focusout", e => { if (e.target.classList?.contains("rename-input")) finishRename(true); });

  // ---- clicks
  function toggle(path, to = !open.has(path)) {
    to ? open.add(path) : open.delete(path);
    saveOpen();
    renderFiles();
    tree.querySelector(`[data-folder="${CSS.escape(path)}"]`)?.focus();
  }
  tree.addEventListener("click", e => {
    if (e.target.closest(".rename-input")) return;
    const f = e.target.closest("[data-folder]");
    if (f) { toggle(f.dataset.folder); return; }
    const r = e.target.closest(".file-row");
    if (r) {
      // like Obsidian: a click opens the file
      app.select(r.dataset.id, { source: "list" });
      app.open(r.dataset.id);
    }
  });
  tree.addEventListener("auxclick", e => {
    const r = e.target.closest(".file-row");
    if (e.button === 1 && r) app.open(r.dataset.id);
  });
  tree.addEventListener("contextmenu", e => {
    const at = { x: e.clientX, y: e.clientY };
    const f = e.target.closest("[data-folder]");
    const r = e.target.closest(".file-row");
    e.preventDefault();
    if (f) folderMenu(f.dataset.folder, at);
    else if (r) fileMenu(r.dataset.id, at);
    else openMenu(at, [
      { label: "New note", iconName: "new-note", run: () => newNote("") },
      { label: "New folder", iconName: "folder-plus", run: () => newFolder("") },
      { label: "New canvas", iconName: "canvas", run: () => newCanvas("") },
    ]);
  });

  // ---- keyboard: arrows, Enter, F2, Delete
  tree.addEventListener("keydown", e => {
    if (e.target.classList.contains("rename-input")) return;
    const rows = [...tree.querySelectorAll(".row")];
    const cur = document.activeElement?.closest?.(".row");
    const i = rows.indexOf(cur);
    const folder = cur?.dataset.folder;
    const id = cur?.dataset.id;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
    } else if (e.key === "ArrowRight" && folder) { e.preventDefault(); if (!open.has(folder)) toggle(folder, true); }
    else if (e.key === "ArrowLeft" && cur) {
      e.preventDefault();
      if (folder && open.has(folder)) toggle(folder, false);
      else {
        const parent = folderOf(folder || id || "");
        if (parent) tree.querySelector(`[data-folder="${CSS.escape(parent)}"]`)?.focus();
      }
    } else if (e.key === "Enter" && cur) { e.preventDefault(); folder ? toggle(folder) : app.open(id); }
    else if (e.key === "F2" && cur) { e.preventDefault(); startRename(folder ? "folder" : "file", folder || id); }
    else if (e.key === "Delete" && cur) { e.preventDefault(); folder ? deleteFolder(folder) : deleteItem(id); }
  });

  // ---- drag and drop: files and folders into folders (or the root)
  let dragging = null; // { kind, path }
  files.addEventListener("dragstart", e => {
    const r = e.target.closest?.(".file-row, .folder-row");
    if (!r) return;
    if (r.dataset.folder) {
      dragging = { kind: "folder", path: r.dataset.folder };
      e.dataTransfer.setData("text/plain", r.dataset.folder);
    } else {
      const n = app.items.get(r.dataset.id);
      dragging = { kind: "file", path: n.id };
      // also droppable onto a canvas, or into a note as a [[link]]
      e.dataTransfer.setData("application/x-brain-item", n.id);
      e.dataTransfer.setData("text/plain", wikilinkTo(n));
    }
    e.dataTransfer.effectAllowed = "copyMove";
  });
  files.addEventListener("dragend", () => { dragging = null; clearDrop(); });
  const clearDrop = () => tree.querySelectorAll(".drop-target").forEach(x => x.classList.remove("drop-target"));
  // where a drop would land: the folder under the pointer, a file's folder, or the root
  function dropFolder(e) {
    const f = e.target.closest?.("[data-folder]");
    if (f) return f.dataset.folder;
    const r = e.target.closest?.(".file-row");
    return r ? folderOf(r.dataset.id) : "";
  }
  const canDrop = target => dragging && !(dragging.kind === "folder" && (target === dragging.path || target.startsWith(`${dragging.path}/`)));
  tree.addEventListener("dragover", e => {
    if (!dragging) return;
    const target = dropFolder(e);
    if (!canDrop(target)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDrop();
    (target ? tree.querySelector(`[data-folder="${CSS.escape(target)}"]`) : tree)?.classList.add("drop-target");
  });
  tree.addEventListener("dragleave", e => { if (!tree.contains(e.relatedTarget)) clearDrop(); });
  tree.addEventListener("drop", async e => {
    if (!dragging) return;
    const target = dropFolder(e);
    const ok = canDrop(target);
    const d = dragging;
    dragging = null;
    clearDrop();
    if (!ok) return;
    e.preventDefault();
    if (d.kind === "file") {
      if (folderOf(d.path) !== target) await moveItem(d.path, target);
    } else if (folderOf(d.path) !== target) {
      await renameFolder(d.path, target ? `${target}/${nameOf(d.path)}` : nameOf(d.path));
    }
    if (target) { open.add(target); saveOpen(); renderFiles(); }
  });

  // ---- header buttons
  // new things go into the last folder used here (or that file's folder), else the root
  let lastRow = null;
  tree.addEventListener("focusin", e => {
    const r = e.target.closest?.(".row");
    if (r) lastRow = r.dataset.folder !== undefined ? { folder: r.dataset.folder } : { folder: folderOf(r.dataset.id || "") };
  });
  files.querySelector(".nav-buttons").addEventListener("click", e => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    const here = lastRow && (!lastRow.folder || app.folders.includes(lastRow.folder)) ? lastRow.folder : "";
    if (act === "new-note") newNote(here);
    else if (act === "new-folder") newFolder(here);
    else if (act === "new-canvas") newCanvas(here);
    else if (act === "collapse") { open.clear(); saveOpen(); renderFiles(); }
    else if (act === "sort") {
      const r = e.target.closest("[data-act]").getBoundingClientRect();
      openMenu({ x: r.left, y: r.bottom + 4 }, Object.entries(SORTS).map(([k, s]) => ({
        label: s.label, iconName: k === sort ? "check" : undefined,
        run: () => { sort = k; prefs.set("files.sort", k); renderFiles(); },
      })));
    }
  });

  // ---- events from elsewhere
  app.on("rename-folder", path => startRename("folder", path));
  app.on("rename-file", id => startRename("file", id));
  app.on("folder-moved", ({ from, to }) => {
    for (const p of [...open]) if (p === from || p.startsWith(`${from}/`)) { open.delete(p); open.add(to + p.slice(from.length)); }
    saveOpen();
  });
  app.on("reveal", id => {
    for (let f = folderOf(id); f; f = folderOf(f)) open.add(f);
    saveOpen();
    left.show("files");
    renderFiles(true);
    const row = tree.querySelector(`.file-row[data-id="${CSS.escape(id)}"]`);
    row?.scrollIntoView({ block: "nearest" });
    row?.focus();
  });
  app.on("tab", () => renderFiles());
  // a new file shows up in the explorer, inside its (now open) folder
  app.on("created", id => {
    for (let f = folderOf(id); f; f = folderOf(f)) open.add(f);
    saveOpen();
    renderFiles();
  });

  // ---------------------------------------------------------------- tags
  const tagsPane = left.add({ id: "tags", title: "Tags", iconName: "tags" });
  const openTags = new Set();
  function renderTags() {
    const byTag = new Map();
    for (const n of app.items.values()) for (const t of allTags(n)) {
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t).push(n);
    }
    const tags = [...byTag.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    setHtml(tagsPane, `<div class="side-label">Tags<span class="count">${tags.length}</span></div>
      <div class="tree">${tags.map(([t, items]) => {
        const isOpen = openTags.has(t);
        return `<div class="group">
          <div class="row folder-row" data-tag="${esc(t)}" aria-expanded="${isOpen}" tabindex="-1">
            ${icon(isOpen ? "chevron-down" : "chevron-right", { size: 14, cls: "chev" })}<span class="row-title">#${esc(t)}</span><span class="count">${items.length}</span>
          </div>
          ${isOpen ? items.sort((a, b) => natural(a.title, b.title)).map(n => fileRow(n, 1)).join("") : ""}
        </div>`;
      }).join("") || `<div class="empty-note">No tags yet. Write #tag in a note.</div>`}</div>`);
  }
  tagsPane.addEventListener("click", e => {
    const g = e.target.closest("[data-tag]");
    if (g) {
      const t = g.dataset.tag;
      openTags.has(t) ? openTags.delete(t) : openTags.add(t);
      renderTags();
      return;
    }
    const r = e.target.closest(".file-row");
    if (r) { app.select(r.dataset.id, { source: "list" }); app.open(r.dataset.id); }
  });
  tagsPane.addEventListener("contextmenu", e => {
    const r = e.target.closest(".file-row");
    if (!r) return;
    e.preventDefault();
    fileMenu(r.dataset.id, { x: e.clientX, y: e.clientY });
  });

  function renderAll() { renderFiles(); renderTags(); }
  app.on("data", renderAll);
  app.on("select", () => {
    for (const r of document.querySelectorAll("#left .file-row")) r.classList.toggle("on", r.dataset.id === app.selected);
  });
  app.on("focus-folder", path => graph.focusFolder(path));

  return { reveal: id => app.emit("reveal", id) };
}
