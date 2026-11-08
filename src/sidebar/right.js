// Right sidebar, like Obsidian's: Backlinks (linked + unlinked mentions),
// Outgoing links (and links to notes that don't exist yet) and Outline, all
// for the note that's open (or selected in the graph).

import { app } from "../state.js";
import { api } from "../api.js";
import { right } from "../shell/layout.js";
import { icon, itemIcon } from "../icons.js";
import { esc, setHtml } from "../util.js";
import { eachWikilink, linkTarget, wikilinks } from "../lib/wikilinks.js";
import { toast } from "../shell/toast.js";
import { tabsApi } from "../shell/tabs.js";
import { unlinkedMentions, linkMention } from "../lib/mentions.js";
import { folderOf } from "../lib/folders.js";
import { fileMenu } from "./menus.js";
import { followLink } from "../editor/item-tab.js";

const unwiki = s => s.replace(/!?\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_, t, a) => a || t.split("#")[0]);

// Every line of `src`'s body that links to `targetId`.
function contextLines(src, targetId) {
  const out = [];
  const body = src.body || "";
  eachWikilink(body, (inner, s) => {
    if (app.resolve(linkTarget(inner)) !== targetId) return;
    const from = body.lastIndexOf("\n", s) + 1;
    const to = body.indexOf("\n", s);
    let line = unwiki(body.slice(from, to < 0 ? undefined : to).trim()).replace(/^[-*>#\s]+/, "");
    if (line.length > 160) line = line.slice(0, 159) + "…";
    if (line && !out.includes(line)) out.push(line);
  });
  return out;
}

// Headings, skipping code blocks: [{ level, text, line }]
export function headings(body) {
  const out = [];
  let fence = false;
  (body || "").split("\n").forEach((l, i) => {
    const t = l.trimStart();
    if (t.startsWith("```") || t.startsWith("~~~")) { fence = !fence; return; }
    const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) out.push({ level: m[1].length, text: unwiki(m[2]), line: i });
  });
  return out;
}

export function initRightSidebar() {
  const backPane = right.add({ id: "backlinks", title: "Backlinks", iconName: "backlinks" });
  const outPane = right.add({ id: "outgoing", title: "Outgoing links", iconName: "outgoing" });
  const outlinePane = right.add({ id: "outline", title: "Outline", iconName: "outline" });
  const showUnlinked = () => localStorage.getItem("brain.unlinked") !== "0";

  const current = () => app.items.get(app.selected);
  const head = (n, label) => `<div class="pane-head"><span class="pane-title">${label}</span>${n ? `<span class="pane-file" title="${esc(n.path)}">${esc(n.title)}</span>` : ""}</div>`;
  const noFile = label => `${head(null, label)}<div class="empty-note pad">No file open.</div>`;

  function row(o, extra = "") {
    return `<div class="row item-row file-row has-ctx" data-id="${esc(o.id)}" title="${esc(o.path)}">
      ${itemIcon(o, app.colorOf(o))}<span class="row-main"><span class="row-title">${esc(o.title)}</span>
      <span class="row-path">${esc(folderOf(o.path))}</span>${extra}</span></div>`;
  }

  function renderBacklinks() {
    const n = current();
    if (!n) return setHtml(backPane, noFile("Backlinks"));
    const linked = app.backlinks(n.id).map(e => app.items.get(e.id)).filter(Boolean).sort((a, b) => a.title.localeCompare(b.title));
    const linkedHtml = linked.map(o => row(o, contextLines(o, n.id).map(l => `<span class="row-ctx">${esc(l)}</span>`).join(""))).join("");
    let unlinkedHtml = "";
    let unlinkedCount = 0;
    if (n.type === "note") {
      const found = unlinkedMentions(n, app.items.values(), id => app.outgoing(id).some(e => e.id === n.id));
      unlinkedCount = found.length;
      unlinkedHtml = showUnlinked() ? found.slice(0, 50).map(m => {
        const o = app.items.get(m.id);
        return `<div class="row item-row file-row mention-row has-ctx" data-id="${esc(o.id)}">
          ${itemIcon(o, app.colorOf(o))}<span class="row-main"><span class="row-title">${esc(o.title)}${m.count > 1 ? ` <span class="faint">×${m.count}</span>` : ""}</span>
          <span class="row-ctx">${esc(m.before)}<mark>${esc(m.text)}</mark>${esc(m.after)}</span></span>
          <button type="button" class="btn-link mention-link" data-link-mention="${esc(m.id)}" title="Turn the first mention into a link">Link</button></div>`;
      }).join("") || `<div class="empty-note">None</div>` : "";
    }
    setHtml(backPane, `${head(n, "Backlinks")}
      <section class="side-section" data-sec="back">
        <div class="side-label"><span>Linked mentions</span><span class="count">${linked.length}</span></div>
        ${linkedHtml || `<div class="empty-note">No backlinks found.</div>`}
      </section>
      ${n.type === "note" ? `<section class="side-section" data-sec="mentions">
        <button type="button" class="side-label toggle" data-act="toggle-unlinked">${icon(showUnlinked() ? "chevron-down" : "chevron-right", { size: 13 })}<span>Unlinked mentions</span><span class="count">${unlinkedCount}</span></button>
        ${unlinkedHtml}
      </section>` : ""}`);
  }

  function renderOutgoing() {
    const n = current();
    if (!n) return setHtml(outPane, noFile("Outgoing links"));
    const linked = app.outgoing(n.id).map(e => app.items.get(e.id)).filter(Boolean).sort((a, b) => a.title.localeCompare(b.title));
    const missing = [...new Set(wikilinks(n.body).filter(t => !app.resolve(t)))];
    setHtml(outPane, `${head(n, "Outgoing links")}
      <section class="side-section" data-sec="out">
        <div class="side-label"><span>Links</span><span class="count">${linked.length}</span></div>
        ${linked.map(o => row(o)).join("") || `<div class="empty-note">No links.</div>`}
      </section>
      ${missing.length ? `<section class="side-section" data-sec="unresolved">
        <div class="side-label"><span>Not created yet</span><span class="count">${missing.length}</span></div>
        ${missing.map(t => `<div class="row item-row unresolved-row" data-create="${esc(t)}" title="Click to create">
          <span class="dot hollow"></span><span class="row-title">${esc(t)}</span></div>`).join("")}
      </section>` : ""}`);
  }

  function renderOutline() {
    const n = current();
    if (!n) return setHtml(outlinePane, noFile("Outline"));
    const hs = n.type === "note" ? headings(n.body) : [];
    const min = Math.min(...hs.map(h => h.level), 6);
    setHtml(outlinePane, `${head(n, "Outline")}
      <div class="tree outline">${hs.map(h => `<div class="row outline-row" data-line="${h.line}" style="--depth:${h.level - min}">
        <span class="row-title">${esc(h.text)}</span></div>`).join("") || `<div class="empty-note pad">No headings.</div>`}</div>`);
  }

  function render() { renderBacklinks(); renderOutgoing(); renderOutline(); }

  async function linkFirstMention(targetId, sourceId) {
    const target = app.items.get(targetId);
    if (!target) return;
    try {
      await tabsApi.saveAll();
      const src = await api.getItem(sourceId);
      const [m] = unlinkedMentions(target, [src], () => false);
      if (!m) throw new Error("the mention is gone");
      await api.updateItem(sourceId, { body: linkMention(src.body, m.index, m.length, target.title) });
      await app.reload();
      toast(`Linked in "${src.title}"`);
    } catch (e) {
      toast(`Couldn't link: ${e.message || e}`, "error");
    }
  }

  for (const pane of [backPane, outPane, outlinePane]) {
    pane.addEventListener("click", e => {
      const lm = e.target.closest("[data-link-mention]");
      if (lm) { linkFirstMention(app.selected, lm.dataset.linkMention); return; }
      if (e.target.closest('[data-act="toggle-unlinked"]')) {
        localStorage.setItem("brain.unlinked", showUnlinked() ? "0" : "1");
        renderBacklinks();
        return;
      }
      const c = e.target.closest("[data-create]");
      if (c) { followLink(c.dataset.create); return; }
      const o = e.target.closest(".outline-row");
      if (o) { app.emit("goto-line", { id: app.selected, line: +o.dataset.line }); return; }
      const r = e.target.closest(".file-row");
      if (r) app.open(r.dataset.id);
    });
    pane.addEventListener("contextmenu", e => {
      const r = e.target.closest(".file-row");
      if (!r) return;
      e.preventDefault();
      fileMenu(r.dataset.id, { x: e.clientX, y: e.clientY });
    });
  }

  app.on("data", render);
  app.on("select", render);
  render();
  return { rect: () => document.getElementById("right").getBoundingClientRect() };
}
