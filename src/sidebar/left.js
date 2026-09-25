// Left sidebar: Files (grouped by type), Tags, Filters (types, lobes, similar).

import { app } from "../state.js";
import { allTags } from "../lib/tags.js";
import { left } from "../shell/layout.js";
import { icon, typeIcon } from "../icons.js";
import { TYPES } from "../lib/types.js";
import { UNSORTED } from "../lib/lobes.js";
import { itemMenu } from "../ai/actions.js";
import { esc, setHtml } from "../util.js";
import { prefs } from "../lib/prefs.js";

// Links being fetched / that failed show it in the list.
const linkState = n =>
  n.type !== "link" || !n.status || n.status === "ok" ? ""
    : n.status === "pending" ? `<span class="row-state">fetching</span>`
    : `<span class="row-state failed" title="${esc(n.error || "")}">failed</span>`;

export function initLeftSidebar({ graph }) {
  // ---------------------------------------------------------------- files
  // Two ways to browse: the vault's real folders (like Obsidian) or by item type.
  const files = left.add({ id: "files", title: "Files", iconName: "files" });
  files.innerHTML = `<div class="side-head files-head">
      <input class="side-filter" placeholder="Filter" spellcheck="false" />
      <div class="seg" role="group" aria-label="Group files by">
        <button type="button" data-mode="folders" title="Folders on disk">Folders</button><button type="button" data-mode="types" title="Group by item type">Types</button>
      </div>
    </div><div class="tree" role="tree"></div>`;
  const tree = files.querySelector(".tree");
  const filterInput = files.querySelector(".side-filter");
  const collapsed = new Set(prefs.get("files.collapsed", []));        // type groups
  const openFolders = new Set(prefs.get("files.openFolders", []));    // folder paths
  let mode = prefs.get("files.mode", "folders");

  function row(n, depth = 0) {
    return `<div class="row item-row ${n.id === app.selected ? "on" : ""}" data-id="${esc(n.id)}" role="treeitem" tabindex="-1" title="${esc(n.path || n.title)}" style="--depth:${depth}">
      <span class="dot" style="background:${app.lobeOf(n).color}"></span><span class="row-title">${esc(n.title)}</span>${linkState(n)}</div>`;
  }

  const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });

  function typesHtml(all, q) {
    return TYPES.map(t => {
      const items = all.filter(n => n.type === t.id).sort(byTitle);
      if (!items.length && q) return "";
      const open = q || !collapsed.has(t.id);
      return `<div class="group">
        <button type="button" class="row group-head" data-group="${t.id}" aria-expanded="${!!open}">
          ${icon(open ? "chevron-down" : "chevron-right", { size: 14 })}<span class="row-title">${t.name}</span><span class="count">${items.length}</span>
        </button>
        ${open ? items.map(n => row(n, 1)).join("") : ""}
      </div>`;
    }).join("");
  }

  // Nested folders from item paths; folders first, then files, by name.
  function foldersHtml(all, q) {
    const root = { dirs: new Map(), items: [] };
    for (const n of all) {
      const parts = (n.path || n.title).split("/");
      parts.pop();
      let node = root;
      let path = "";
      for (const p of parts) {
        path = path ? `${path}/${p}` : p;
        if (!node.dirs.has(p)) node.dirs.set(p, { path, dirs: new Map(), items: [] });
        node = node.dirs.get(p);
      }
      node.items.push(n);
    }
    const count = d => d.items.length + [...d.dirs.values()].reduce((s, x) => s + count(x), 0);
    const render = (d, depth) =>
      [...d.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: "base" })).map(([name, sub]) => {
        const open = q || openFolders.has(sub.path);
        return `<div class="group">
          <button type="button" class="row group-head folder" data-folder="${esc(sub.path)}" aria-expanded="${!!open}" style="--depth:${depth}" title="${esc(sub.path)}">
            ${icon(open ? "chevron-down" : "chevron-right", { size: 14 })}<span class="row-title">${esc(name)}</span><span class="count">${count(sub)}</span>
          </button>
          ${open ? render(sub, depth + 1) : ""}
        </div>`;
      }).join("") + d.items.sort(byTitle).map(n => row(n, depth)).join("");
    return render(root, 0);
  }

  function renderFiles() {
    const q = filterInput.value.trim().toLowerCase();
    const all = [...app.items.values()].filter(n => !q || n.title.toLowerCase().includes(q) || allTags(n).some(t => t.toLowerCase().includes(q)) || (n.path || "").toLowerCase().includes(q));
    for (const b of files.querySelectorAll("[data-mode]")) b.classList.toggle("on", b.dataset.mode === mode);
    setHtml(tree, (mode === "types" ? typesHtml(all, q) : foldersHtml(all, q)) || `<div class="empty-note">${q ? "No matches." : "No files yet."}</div>`);
  }

  files.querySelector(".seg").addEventListener("click", e => {
    const b = e.target.closest("[data-mode]");
    if (!b) return;
    mode = b.dataset.mode;
    prefs.set("files.mode", mode);
    renderFiles();
  });

  tree.addEventListener("click", e => {
    const f = e.target.closest("[data-folder]");
    if (f) {
      const p = f.dataset.folder;
      openFolders.has(p) ? openFolders.delete(p) : openFolders.add(p);
      prefs.set("files.openFolders", [...openFolders]);
      renderFiles();
      return;
    }
    const g = e.target.closest("[data-group]");
    if (g) {
      const id = g.dataset.group;
      collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
      prefs.set("files.collapsed", [...collapsed]);
      renderFiles();
      return;
    }
    const r = e.target.closest(".item-row");
    if (r) app.select(r.dataset.id, { source: "list" });
  });
  tree.addEventListener("dblclick", e => {
    const r = e.target.closest(".item-row");
    if (r) app.open(r.dataset.id);
  });
  tree.addEventListener("keydown", e => {
    const rows = [...tree.querySelectorAll(".item-row")];
    const i = rows.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      next?.focus();
      if (next) app.select(next.dataset.id, { source: "list" });
    } else if (e.key === "Enter" && i >= 0) app.open(rows[i].dataset.id);
  });
  filterInput.addEventListener("input", renderFiles);
  filterInput.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { e.preventDefault(); tree.querySelector(".item-row")?.focus(); }
    if (e.key === "Escape") { filterInput.value = ""; renderFiles(); }
  });

  // ---------------------------------------------------------------- tags
  const tagsPane = left.add({ id: "tags", title: "Tags", iconName: "tags" });
  const openTags = new Set();
  function renderTags() {
    const counts = new Map();
    for (const n of app.items.values()) for (const t of allTags(n)) counts.set(t, (counts.get(t) || 0) + 1);
    const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    setHtml(tagsPane, `<div class="tree">
      ${sorted.map(([t, c]) => tagGroup(t, `#${t}`, [...app.items.values()].filter(n => allTags(n).includes(t)), c)).join("")}
      ${!sorted.length ? `<div class="empty-note">No tags yet.</div>` : ""}
    </div>`);
  }
  function tagGroup(key, label, items, count = items.length) {
    const open = openTags.has(key);
    return `<div class="group">
      <button type="button" class="row group-head" data-tag="${esc(key)}" aria-expanded="${open}">
        ${icon(open ? "chevron-down" : "chevron-right", { size: 14 })}<span class="row-title">${esc(label)}</span><span class="count">${count}</span>
      </button>
      ${open ? items.sort((a, b) => a.title.localeCompare(b.title)).map(n => row(n, 1)).join("") : ""}
    </div>`;
  }
  tagsPane.addEventListener("click", e => {
    const g = e.target.closest("[data-tag]");
    if (g) {
      const k = g.dataset.tag;
      openTags.has(k) ? openTags.delete(k) : openTags.add(k);
      renderTags();
      return;
    }
    const r = e.target.closest(".item-row");
    if (r) app.select(r.dataset.id, { source: "list" });
  });
  tagsPane.addEventListener("dblclick", e => {
    const r = e.target.closest(".item-row");
    if (r) app.open(r.dataset.id);
  });

  // ---------------------------------------------------------------- inbox
  // Untagged items wait here until they get a tag.
  const inbox = left.add({ id: "inbox", title: "Inbox (untagged)", iconName: "inbox" });
  function renderInbox() {
    const items = [...app.items.values()].filter(n => !allTags(n).length).sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")) || a.title.localeCompare(b.title));
    setHtml(inbox, `<div class="side-label">Inbox<span class="count">${items.length}</span></div>
      <div class="tree">${items.map(n => row(n)).join("") || `<div class="empty-note">Nothing untagged.</div>`}</div>`);
    left.badge("inbox", items.length);
  }
  inbox.addEventListener("click", e => {
    const r = e.target.closest(".item-row");
    if (r) app.select(r.dataset.id, { source: "list" });
  });
  inbox.addEventListener("dblclick", e => {
    const r = e.target.closest(".item-row");
    if (r) app.open(r.dataset.id);
  });

  // ---------------------------------------------------------------- filters
  const filters = left.add({ id: "filters", title: "Graph filters", iconName: "filters" });
  function renderFilters() {
    const st = graph.state;
    const items = [...app.items.values()];
    const lobes = [...app.lobes, app.lobe.get(UNSORTED.id)].filter(Boolean);
    setHtml(filters, `
      <div class="side-section">
        <div class="side-label">Types</div>
        ${TYPES.map(t => `<label class="row check-row">
          <input type="checkbox" data-type="${t.id}" ${st.types.has(t.id) ? "checked" : ""} />
          ${typeIcon(t.id, "var(--muted)", 12)}<span class="row-title">${t.name}</span>
          <span class="count">${items.filter(n => n.type === t.id).length}</span></label>`).join("")}
      </div>
      <div class="side-section">
        <div class="side-label">Lobes</div>
        ${lobes.map(l => {
          const c = items.filter(n => n.lobe === l.id).length;
          if (!c && l.id === UNSORTED.id) return "";
          return `<button type="button" class="row" data-lobe="${esc(l.id)}" title="Fly to lobe">
            <span class="dot" style="background:${l.color}"></span><span class="row-title">${esc(l.name)}</span><span class="count">${c}</span></button>`;
        }).join("")}
      </div>
      <div class="side-section">
        <div class="side-label">Links</div>
        <label class="row check-row" title="Wikilinks are always shown"><input type="checkbox" checked disabled />
          <span class="line-key solid"></span><span class="row-title">Wikilinks</span></label>
        <label class="row check-row"><input type="checkbox" data-similar ${st.showSimilar ? "checked" : ""} />
          <span class="line-key dashed"></span><span class="row-title">Similar</span></label>
      </div>`);
  }
  filters.addEventListener("change", e => {
    if (e.target.dataset.type) {
      const types = [...filters.querySelectorAll("[data-type]")].filter(x => x.checked).map(x => x.dataset.type);
      graph.setTypes(types);
    } else if ("similar" in e.target.dataset) graph.setShowSimilar(e.target.checked);
  });
  filters.addEventListener("click", e => {
    const l = e.target.closest("[data-lobe]");
    if (l) {
      app.emit("show-graph");
      graph.focusLobe(app.lobe.get(l.dataset.lobe));
    }
  });

  // right-click on any item row in the left sidebar
  document.getElementById("left").addEventListener("contextmenu", e => {
    const r = e.target.closest(".item-row");
    if (!r) return;
    e.preventDefault();
    itemMenu(r.dataset.id, { x: e.clientX, y: e.clientY });
  });

  function renderAll() { renderFiles(); renderTags(); renderInbox(); renderFilters(); }
  app.on("data", renderAll);
  app.on("graph-filters", renderFilters);
  app.on("select", () => {
    for (const r of document.querySelectorAll("#left .item-row"))
      r.classList.toggle("on", r.dataset.id === app.selected);
    document.querySelector(`#left .side-pane:not([hidden]) .item-row.on`)?.scrollIntoView({ block: "nearest" });
  });

  return { focusFilter: () => { left.show("files"); filterInput.focus(); } };
}
