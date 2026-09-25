// Right sidebar "Item" view: the selected item's properties (editable),
// outgoing links, backlinks (with the line that links here) and suggested items.

import { app } from "../state.js";
import { allTags } from "../lib/tags.js";
import { api } from "../api.js";
import { right } from "../shell/layout.js";
import { icon, typeIcon } from "../icons.js";
import { FORMS, TYPE, TYPES } from "../lib/types.js";
import { fieldControl, readValue, bindLinkInputs } from "../forms/fields.js";
import { UNSORTED } from "../lib/lobes.js";
import { itemMenu, aiOn, AI_OFF } from "../ai/actions.js";
import { esc, openExternal, setHtml } from "../util.js";
import { eachWikilink, linkTarget } from "../lib/wikilinks.js";
import { deleteItem } from "../actions.js";
import { toast } from "../shell/toast.js";

const KNOWN = new Set(["id", "type", "lobe", "title", "tags", "inline_tags", "body", "path", "created", "updated", "degree"]);
const LAYOUT = /^(x|y|z|vx|vy|vz|fx|fy|fz|index|__.*)$/;
const unwiki = s => s.replace(/!?\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_, t, a) => a || t.split("#")[0]);

// The first line of `src`'s body that links to `targetId`.
function contextLine(src, targetId) {
  let hit = null;
  eachWikilink(src.body || "", (inner, s) => {
    if (hit !== null || app.resolve(linkTarget(inner)) !== targetId) return;
    const body = src.body;
    const from = body.lastIndexOf("\n", s) + 1;
    const to = body.indexOf("\n", s);
    hit = body.slice(from, to < 0 ? undefined : to).trim();
  });
  if (!hit) return "";
  hit = unwiki(hit).replace(/^[-*>#\s]+/, "");
  return hit.length > 140 ? hit.slice(0, 139) + "…" : hit;
}

export function initRightSidebar() {
  const pane = right.add({ id: "item", title: "Item", iconName: "info" });
  let confirmDelete = false;
  let deferred = false;
  // AI tag/lobe suggestions per item: { key (updated stamp), loading, tags, lobe, error }
  const sugg = new Map();

  async function suggest(id, { force = false } = {}) {
    const n = app.items.get(id);
    if (!n || !aiOn()) return;
    const key = n.updated || "";
    const cur = sugg.get(id);
    if (!force && cur && cur.key === key) return;
    sugg.set(id, { key, loading: true });
    render();
    try {
      const r = await api.aiSuggest(id);
      sugg.set(id, { key, tags: r.tags || [], lobe: r.lobe || null });
    } catch (e) {
      sugg.set(id, { key, error: String(e) });
    }
    if (app.selected === id) render();
  }

  function suggestionsHtml(n) {
    if (!aiOn()) return "";
    const s = sugg.get(n.id);
    const wanted = !allTags(n).length || n.lobe === UNSORTED.id;
    if (!s && !wanted) return "";
    let body;
    if (!s) body = `<button type="button" class="btn" data-act="suggest">Suggest tags and lobe</button>`;
    else if (s.loading) body = `<div class="empty-note">Thinking…</div>`;
    else if (s.error) body = `<div class="empty-note error-text">${esc(s.error)}</div>`;
    else if (!s.tags.length && !s.lobe) body = `<div class="empty-note">No good match among existing tags.</div>`;
    else body = `<div class="sugg-chips">
        ${s.tags.map(t => `<button type="button" class="tag sugg" data-accept-tag="${esc(t)}" title="Add #${esc(t)}">+ #${esc(t)}</button>`).join("")}
        ${s.lobe ? `<button type="button" class="tag sugg" data-accept-lobe="${esc(s.lobe)}" title="Move to this lobe"><span class="dot" style="background:${app.lobe.get(s.lobe)?.color}"></span>${esc(app.lobe.get(s.lobe)?.name || s.lobe)}</button>` : ""}
      </div>
      <div class="item-actions"><button type="button" class="btn" data-act="accept-all">Accept all <kbd>Ctrl Enter</kbd></button>
        <button type="button" class="btn quiet" data-act="dismiss-sugg">Dismiss</button></div>`;
    return `<section class="side-section" data-sec="sugg"><div class="side-label">${icon("tags", { size: 13 })}<span>Suggestions</span></div><div class="sugg-body">${body}</div></section>`;
  }

  async function acceptSuggestions(id, { tags, lobe }) {
    const n = app.items.get(id);
    const s = sugg.get(id);
    const p = {};
    if (tags?.length) p.tags = [...new Set([...(n.tags || []), ...tags])];
    if (lobe) p.lobe = lobe;
    if (s && !s.loading) {
      s.tags = (s.tags || []).filter(t => !tags?.includes(t));
      if (lobe) s.lobe = null;
    }
    if (Object.keys(p).length) await patch(p);
    const left = sugg.get(id);
    if (left && !left.tags?.length && !left.lobe) sugg.delete(id);
    render();
  }

  function linkRows(edges, withContext = false) {
    const self = app.selected;
    const rows = edges
      .map(e => app.items.get(e.id))
      .filter(Boolean)
      .sort((a, b) => a.title.localeCompare(b.title))
      .map(n => {
        const ctx = withContext ? contextLine(n, self) : "";
        return `<button type="button" class="row item-row ${ctx ? "has-ctx" : ""}" data-id="${esc(n.id)}" title="${esc(n.title)}">
          ${typeIcon(n.type, app.lobeOf(n).color, 11)}<span class="row-main"><span class="row-title">${esc(n.title)}</span>
          ${ctx ? `<span class="row-ctx">${esc(ctx)}</span>` : ""}</span></button>`;
      });
    return rows.length ? rows.join("") : `<div class="empty-note">None</div>`;
  }

  const section = (key, title, iconName, count, content) => `
    <section class="side-section" data-sec="${key}">
      <div class="side-label">${icon(iconName, { size: 13 })}<span>${title}</span>${count !== null ? `<span class="count">${count}</span>` : ""}</div>
      ${content}</section>`;

  function propsHtml(n) {
    const lobes = [...app.lobes, app.lobe.get(UNSORTED.id)];
    const form = FORMS[n.type] || [];
    const known = new Set(form.map(f => f.key));
    // frontmatter keys the form doesn't know (hand-written, or from another type) stay editable as text
    const extra = Object.keys(n).filter(k => !KNOWN.has(k) && !LAYOUT.test(k) && !known.has(k) && k !== "error");
    const knownTags = [...new Set([...app.items.values()].flatMap(allTags))].sort();
    const inline = (n.inline_tags || []).filter(t => !(n.tags || []).includes(t));
    const synced = n.type === "project" && !!n.pushed_at;
    return `<div class="props-form">
      <label class="prop"><span>type</span><select data-prop="type">${TYPES.map(t => `<option value="${t.id}" ${t.id === n.type ? "selected" : ""}>${t.one}</option>`).join("")}</select></label>
      <label class="prop"><span>lobe</span><select data-prop="lobe">${lobes.map(l => `<option value="${esc(l.id)}" ${l.id === n.lobe ? "selected" : ""}>${esc(l.name)}</option>`).join("")}</select></label>
      <div class="prop"><span>tags</span><div class="tag-edit">
        ${(n.tags || []).map(t => `<span class="tag">#${esc(t)}<button type="button" data-untag="${esc(t)}" aria-label="Remove tag ${esc(t)}">${icon("x", { size: 11 })}</button></span>`).join("")}
        ${inline.map(t => `<span class="tag tag-inline" title="Written as #${esc(t)} in the note">#${esc(t)}</span>`).join("")}
        <input data-tag-input list="all-tags" placeholder="${allTags(n).length ? "" : "add tag"}" spellcheck="false" />
        <datalist id="all-tags">${knownTags.map(t => `<option value="${esc(t)}"></option>`).join("")}</datalist>
      </div></div>
      ${form.map(f => fieldControl(f, n[f.key], { github: synced })).join("")}
      ${extra.map(k => fieldControl({ key: k, kind: Array.isArray(n[k]) ? "list" : typeof n[k] === "number" ? "number" : "text" }, n[k])).join("")}
      ${synced ? `<div class="prop-note">Grey fields come from GitHub and are updated on sync.</div>` : ""}
    </div>`;
  }

  function render(force = false) {
    // don't yank an input away while the user is typing in it
    if (pane.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      deferred = true;
      return;
    }
    deferred = false;
    const n = app.items.get(app.selected);
    if (!n) {
      setHtml(pane, `<div class="empty-note pad">Select an item in the graph or the file list.</div>`);
      return;
    }
    const lobe = app.lobeOf(n);
    const out = app.outgoing(n.id), back = app.backlinks(n.id), sim = app.similar(n.id);
    setHtml(pane, `
      <div class="item-head">
        <div class="item-kind">${typeIcon(n.type, lobe.color, 12)}<span>${esc(TYPE[n.type]?.one || n.type)}</span>
          <span class="sep">·</span><span class="dot" style="background:${lobe.color}"></span><span>${esc(lobe.name)}</span></div>
        <div class="item-title">${esc(n.title)}</div>
        ${n.type === "link" && n.status && n.status !== "ok" ? `<div class="item-status ${n.status}">${n.status === "pending" ? "Fetching the page…" : `Fetch failed${n.error ? `: ${esc(n.error)}` : ""}`}</div>` : ""}
        <div class="item-actions">
          <button type="button" class="btn" data-act="open">${icon("file", { size: 14 })}Open</button>
          ${n.url ? `<button type="button" class="btn" data-act="url" title="Open in browser">${icon("external", { size: 14 })}Visit</button>` : ""}
          ${n.type === "link" && n.url ? `<button type="button" class="btn quiet" data-act="refetch" title="Fetch the page again">${icon("refresh", { size: 14 })}</button>` : ""}
          <span class="fill"></span>
          <button type="button" class="btn ${confirmDelete ? "danger" : "quiet"}" data-act="delete" title="Move to .trash">${icon("trash", { size: 14 })}${confirmDelete ? "Confirm" : ""}</button>
        </div>
      </div>
      ${suggestionsHtml(n)}
      ${section("props", "Properties", "filters", null, propsHtml(n))}
      ${section("out", "Outgoing links", "outgoing", out.length, linkRows(out))}
      ${section("back", "Backlinks", "backlinks", back.length, linkRows(back, true))}
      ${section("sim", "Suggested", "suggested", sim.length, linkRows(sim))}
      <div class="item-foot">${n.path ? esc(n.path) : ""}${n.updated ? ` · updated ${esc(String(n.updated).slice(0, 10))}` : ""}</div>`, force);
  }

  async function patch(p) {
    const id = app.selected;
    if (!id) return;
    if (pane.contains(document.activeElement)) document.activeElement.blur();
    try {
      await api.updateItem(id, p);
      await app.reload();
    } catch (e) {
      toast(`Couldn't save: ${e}`, "error");
      render(true);
    }
  }

  pane.addEventListener("click", e => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    const n = app.items.get(app.selected);
    if (!n) return;
    if (act === "open") app.open(n.id);
    else if (act === "url") openExternal(n.url);
    const ou = e.target.closest("[data-open-url]");
    if (ou) { e.preventDefault(); openExternal(ou.dataset.openUrl); return; }
    else if (act === "refetch") api.refetchLink(n.id).then(() => app.reload()).catch(e => toast(`Couldn't refetch: ${e}`, "error"));
    else if (act === "suggest") suggest(n.id, { force: true });
    else if (act === "accept-all") { const s = sugg.get(n.id); if (s && !s.loading) acceptSuggestions(n.id, { tags: s.tags, lobe: s.lobe }); }
    else if (act === "dismiss-sugg") { sugg.set(n.id, { key: n.updated || "", tags: [], lobe: null, dismissed: true }); render(); }
    else if (act === "delete") {
      if (!confirmDelete) {
        confirmDelete = true;
        render();
        setTimeout(() => { confirmDelete = false; render(); }, 3000);
      } else {
        confirmDelete = false;
        deleteItem(n.id);
      }
    }
    const at = e.target.closest("[data-accept-tag]");
    if (at) { acceptSuggestions(n.id, { tags: [at.dataset.acceptTag] }); return; }
    const al = e.target.closest("[data-accept-lobe]");
    if (al) { acceptSuggestions(n.id, { lobe: al.dataset.acceptLobe }); return; }
    const untag = e.target.closest("[data-untag]");
    if (untag) patch({ tags: n.tags.filter(t => t !== untag.dataset.untag) });
    const r = e.target.closest(".item-row");
    if (r) app.select(r.dataset.id, { source: "sidebar" });
  });
  pane.addEventListener("contextmenu", e => {
    const r = e.target.closest(".item-row");
    if (!r) return;
    e.preventDefault();
    itemMenu(r.dataset.id, { x: e.clientX, y: e.clientY });
  });
  pane.addEventListener("dblclick", e => {
    const r = e.target.closest(".item-row");
    if (r) app.open(r.dataset.id);
  });
  pane.addEventListener("change", e => {
    const n = app.items.get(app.selected);
    if (!n) return;
    const el = e.target;
    if (el.dataset.prop === "type") patch({ type: el.value });
    else if (el.dataset.prop === "lobe") patch({ lobe: el.value === UNSORTED.id ? null : el.value });
    else if (el.dataset.field && !el.readOnly) {
      const v = readValue(el);
      if (JSON.stringify(v) !== JSON.stringify(n[el.dataset.field] ?? null)) patch({ [el.dataset.field]: v });
    }
  });
  pane.addEventListener("keydown", e => {
    const el = e.target;
    if ("tagInput" in el.dataset) {
      const n = app.items.get(app.selected);
      if ((e.key === "Enter" || e.key === ",") && el.value.trim()) {
        e.preventDefault();
        const add = el.value.split(",").map(s => s.trim().replace(/^#+/, "")).filter(Boolean);
        el.value = "";
        el.blur();
        patch({ tags: [...new Set([...(n.tags || []), ...add])] });
      } else if (e.key === "Backspace" && !el.value && n.tags?.length) {
        e.preventDefault();
        patch({ tags: n.tags.slice(0, -1) });
      }
    } else if (el.tagName === "INPUT" && e.key === "Enter" && !el.dataset.linkInput) el.blur();
    if (e.key === "Escape" && /INPUT|TEXTAREA/.test(el.tagName)) { el.blur(); render(true); }
  });
  bindLinkInputs(pane, (key, list) => patch({ [key]: list.length ? list.map(t => `[[${t}]]`) : null }));
  pane.addEventListener("focusout", () => setTimeout(() => { if (deferred) render(); }, 0));

  app.on("data", render);
  app.on("select", ({ id }) => {
    confirmDelete = false;
    render();
    // Inbox items (no tags) get suggestions automatically; others on request
    const n = app.items.get(id);
    if (n && aiOn() && !allTags(n).length) suggest(id);
  });
  app.on("suggest", id => suggest(id, { force: true }));
  app.on("accept-suggestions", () => {
    const id = app.selected;
    const s = sugg.get(id);
    if (id && s && !s.loading && (s.tags?.length || s.lobe)) acceptSuggestions(id, { tags: s.tags, lobe: s.lobe });
  });
  render();
  return { rect: () => pane.getBoundingClientRect() };
}
