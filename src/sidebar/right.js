// Right sidebar "Item" view: the selected item's properties (editable),
// outgoing links, backlinks (with the line that links here) and suggested items.

import { app } from "../state.js";
import { api } from "../api.js";
import { right } from "../shell/layout.js";
import { icon, typeIcon } from "../icons.js";
import { FIELDS, TYPE, TYPES } from "../lib/types.js";
import { UNSORTED } from "../lib/lobes.js";
import { esc, openExternal } from "../util.js";
import { eachWikilink, linkTarget } from "../lib/wikilinks.js";
import { deleteItem } from "../actions.js";
import { toast } from "../shell/toast.js";

const KNOWN = new Set(["id", "type", "lobe", "title", "tags", "body", "path", "created", "updated", "degree"]);
const LAYOUT = /^(x|y|z|vx|vy|vz|fx|fy|fz|index|__.*)$/;
const LIST_FIELDS = new Set(["stack", "languages", "topics", "used_in"]);

const asText = v => (Array.isArray(v) ? v.join(", ") : v && typeof v === "object" ? JSON.stringify(v) : v ?? "");
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
    const fields = [...new Set([...(FIELDS[n.type] || []), ...Object.keys(n).filter(k => !KNOWN.has(k) && !LAYOUT.test(k))])];
    const allTags = [...new Set([...app.items.values()].flatMap(x => x.tags || []))].sort();
    return `<div class="props-form">
      <label class="prop"><span>type</span><select data-prop="type">${TYPES.map(t => `<option value="${t.id}" ${t.id === n.type ? "selected" : ""}>${t.one}</option>`).join("")}</select></label>
      <label class="prop"><span>lobe</span><select data-prop="lobe">${lobes.map(l => `<option value="${esc(l.id)}" ${l.id === n.lobe ? "selected" : ""}>${esc(l.name)}</option>`).join("")}</select></label>
      <div class="prop"><span>tags</span><div class="tag-edit">
        ${(n.tags || []).map(t => `<span class="tag">#${esc(t)}<button type="button" data-untag="${esc(t)}" aria-label="Remove tag ${esc(t)}">${icon("x", { size: 11 })}</button></span>`).join("")}
        <input data-tag-input list="all-tags" placeholder="${n.tags?.length ? "" : "add tag"}" spellcheck="false" />
        <datalist id="all-tags">${allTags.map(t => `<option value="${esc(t)}"></option>`).join("")}</datalist>
      </div></div>
      ${fields.map(k => {
        const v = n[k];
        const long = typeof v === "string" && v.length > 60 || k === "summary" || k === "description" || k === "built";
        return `<label class="prop"><span>${esc(k.replace(/_/g, " "))}</span>${long
          ? `<textarea data-field="${esc(k)}" rows="2" spellcheck="false">${esc(asText(v))}</textarea>`
          : `<input data-field="${esc(k)}" value="${esc(asText(v))}" spellcheck="false" />`}
          ${k === "url" && v ? `<button type="button" class="icon-btn" data-act="url" title="Open in browser">${icon("external", { size: 13 })}</button>` : ""}</label>`;
      }).join("")}
    </div>`;
  }

  function render() {
    // don't yank an input away while the user is typing in it
    if (pane.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      deferred = true;
      return;
    }
    deferred = false;
    const n = app.items.get(app.selected);
    if (!n) {
      pane.innerHTML = `<div class="empty-note pad">Select an item in the graph or the file list.</div>`;
      return;
    }
    const lobe = app.lobeOf(n);
    const out = app.outgoing(n.id), back = app.backlinks(n.id), sim = app.similar(n.id);
    pane.innerHTML = `
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
      ${section("props", "Properties", "filters", null, propsHtml(n))}
      ${section("out", "Outgoing links", "outgoing", out.length, linkRows(out))}
      ${section("back", "Backlinks", "backlinks", back.length, linkRows(back, true))}
      ${section("sim", "Suggested", "suggested", sim.length, linkRows(sim))}
      <div class="item-foot">${n.path ? esc(n.path) : ""}${n.updated ? ` · updated ${esc(String(n.updated).slice(0, 10))}` : ""}</div>`;
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
      render();
    }
  }

  function fieldValue(k, raw) {
    const text = raw.trim();
    if (!text) return null;
    const n = app.items.get(app.selected);
    if (LIST_FIELDS.has(k) || Array.isArray(n?.[k])) return text.split(",").map(s => s.trim()).filter(Boolean);
    if (typeof n?.[k] === "number" && !isNaN(+text)) return +text;
    return text;
  }

  pane.addEventListener("click", e => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    const n = app.items.get(app.selected);
    if (!n) return;
    if (act === "open") app.open(n.id);
    else if (act === "url") openExternal(n.url);
    else if (act === "refetch") api.refetchLink(n.id).then(() => app.reload()).catch(e => toast(`Couldn't refetch: ${e}`, "error"));
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
    const untag = e.target.closest("[data-untag]");
    if (untag) patch({ tags: n.tags.filter(t => t !== untag.dataset.untag) });
    const r = e.target.closest(".item-row");
    if (r) app.select(r.dataset.id, { source: "sidebar" });
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
    else if (el.dataset.field) {
      const v = fieldValue(el.dataset.field, el.value);
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
    } else if (el.tagName === "INPUT" && e.key === "Enter") el.blur();
    if (e.key === "Escape" && /INPUT|TEXTAREA/.test(el.tagName)) { el.blur(); render(); }
  });
  pane.addEventListener("focusout", () => setTimeout(() => { if (deferred) render(); }, 0));

  app.on("data", render);
  app.on("select", () => { confirmDelete = false; render(); });
  render();
  return { rect: () => pane.getBoundingClientRect() };
}
