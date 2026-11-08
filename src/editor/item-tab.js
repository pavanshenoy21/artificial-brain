// A note open in a workspace tab, laid out like Obsidian: the file name as an
// inline title (editing it renames the file), Properties (frontmatter) and
// the CodeMirror editor or the reading view (Ctrl E). Autosave after 500ms.

import { app } from "../state.js";
import { api } from "../api.js";
import { md } from "./markdown.js";
import { createEditor } from "./editor.js";
import { icon } from "../icons.js";
import { esc, openExternal } from "../util.js";
import { prefs } from "../lib/prefs.js";
import { toast } from "../shell/toast.js";
import { status } from "../shell/statusbar.js";
import { tabsApi } from "../shell/tabs.js";
import { canvasTab } from "../canvas/view.js";
import { toggleTask } from "../lib/tasks.js";
import { renameItem } from "../actions.js";
import { folderOf } from "../lib/folders.js";

md.resolveWikilink = target => app.resolve(target);

const words = s => (s.match(/[\p{L}\p{N}'’-]+/gu) || []).length;
// frontmatter properties other than tags (the backend sends them as `props`)
export const propertiesOf = n => Object.keys(n.props || {});

// Follow a [[link]]: open it, or create the note if it doesn't exist yet (like
// Obsidian: "Folder/Name" creates it in that folder, a bare name in the root).
export async function followLink(target) {
  const id = app.resolve(target);
  if (id) { app.open(id); return; }
  const clean = target.replace(/\.md$/, "");
  try {
    const item = await api.createItem({ title: clean.split("/").pop(), folder: folderOf(clean) });
    await app.reload();
    app.open(item.id, { mode: "edit" });
  } catch (e) {
    toast(`Couldn't create "${target}": ${e}`, "error");
  }
}

export function linkOptions() {
  return [...app.items.values()]
    .sort((a, b) => (b.degree || 0) - (a.degree || 0) || a.title.localeCompare(b.title))
    .map(n => ({ label: n.title, detail: folderOf(n.path), apply: n.type === "canvas" ? n.path.split("/").pop() : n.title }));
}

// a property value as text in the editor, and back
const showValue = v => (Array.isArray(v) ? v.join(", ") : v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
function readValue(text, old) {
  const t = text.trim();
  if (Array.isArray(old)) return t ? t.split(",").map(x => x.trim()).filter(Boolean) : [];
  if (typeof old === "number" && t !== "" && !Number.isNaN(+t)) return +t;
  if (typeof old === "boolean") return t === "true";
  return t;
}

export function itemTab(pane, tab) {
  if (app.items.get(tab.id)?.type === "canvas") return canvasTab(pane, tab);
  let mode = tab.mode || prefs.get("editor.mode", "edit");
  pane.innerHTML = `
    <div class="doc">
      <div class="doc-inner">
        <div class="doc-meta"></div>
        <textarea class="doc-title-input" rows="1" spellcheck="false" aria-label="File name"></textarea>
        <div class="props"></div>
        <div class="doc-editor"></div>
        <div class="markdown doc-reading" hidden></div>
      </div>
    </div>`;
  const $ = s => pane.querySelector(s);
  const titleInput = $(".doc-title-input");
  const reading = $(".doc-reading");
  const editorBox = $(".doc-editor");
  const propsBox = $(".props");

  const item = () => app.items.get(tab.id);
  let saved = item()?.body ?? "";   // body as last written to / read from disk
  let dirty = false;
  let timer = null;
  let saving = Promise.resolve();

  const editor = createEditor({
    parent: editorBox,
    doc: saved,
    onChange: () => {
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(save, 500);
      showStatus("editing");
    },
    onFollow: followLink,
    resolve: target => app.resolve(target),
    linkOptions,
  });

  function save() {
    clearTimeout(timer);
    saving = saving.then(async () => {
      const body = editor.value;
      if (body === saved) { dirty = false; showStatus(); return; }
      try {
        await api.updateItem(tab.id, { body });
        saved = body;
        dirty = editor.value !== body;
        showStatus("saved");
      } catch (e) {
        toast(`Save failed: ${e}`, "error");
        showStatus("not saved");
      }
    });
    return saving;
  }

  async function commitTitle() {
    const n = item();
    const title = titleInput.value.replace(/\s+/g, " ").trim();
    if (!n || title === n.title) { titleInput.value = n?.title ?? ""; return; }
    if (!title) { titleInput.value = n.title; return; }
    // flush all tabs first: the rename rewrites links in other files, and a
    // later autosave of stale text would undo that
    await tabsApi.saveAll();
    const id = await renameItem(tab.id, title);
    if (id === n.id) titleInput.value = item()?.title ?? n.title;
  }

  // ---- properties (frontmatter), editable in place like Obsidian's
  let propsOpen = prefs.get("editor.props", true);
  let adding = false;
  function renderProps(force = false) {
    const n = item();
    if (!n) return;
    const keys = propertiesOf(n);
    const tags = n.tags || [];
    if (!keys.length && !tags.length && !adding) { propsBox.innerHTML = ""; propsBox.hidden = true; return; }
    // don't yank a field away mid-edit (a click on a button here redraws on purpose)
    if (!force && propsBox.contains(document.activeElement) && /INPUT/.test(document.activeElement.tagName)) return;
    propsBox.hidden = false;
    propsBox.innerHTML = `
      <button type="button" class="props-head" data-act="toggle-props">${icon(propsOpen ? "chevron-down" : "chevron-right", { size: 13 })}Properties</button>
      ${propsOpen ? `<div class="props-list">
        ${tags.length || adding ? `<div class="prop-row"><span class="prop-key">tags</span><div class="prop-tags">
          ${tags.map(t => `<span class="tag">#${esc(t)}<button type="button" data-untag="${esc(t)}" aria-label="Remove ${esc(t)}">${icon("x", { size: 11 })}</button></span>`).join("")}
          <input class="prop-tag-input" placeholder="add tag" spellcheck="false" /></div></div>` : ""}
        ${keys.map(k => `<div class="prop-row"><span class="prop-key" title="${esc(k)}">${esc(k)}</span>
          <input class="prop-value" data-key="${esc(k)}" value="${esc(showValue(n.props[k]))}" spellcheck="false" />
          <button type="button" class="icon-btn prop-del" data-del="${esc(k)}" title="Remove property">${icon("x", { size: 13 })}</button></div>`).join("")}
        ${adding ? `<div class="prop-row new"><input class="prop-new-key" placeholder="name" spellcheck="false" /><input class="prop-new-value" placeholder="value" spellcheck="false" /></div>` : ""}
        <button type="button" class="btn-link prop-add" data-act="add-prop">${icon("plus", { size: 13 })}Add property</button>
      </div>` : ""}`;
    if (adding) propsBox.querySelector(".prop-new-key")?.focus();
  }
  async function patch(p, { keepTagInput = false } = {}) {
    try {
      await api.updateItem(tab.id, p);
      await app.reload();
      renderProps(true);
      if (keepTagInput) propsBox.querySelector(".prop-tag-input")?.focus();
    } catch (e) {
      toast(`Couldn't save: ${e}`, "error");
    }
  }
  propsBox.addEventListener("click", e => {
    const n = item();
    if (e.target.closest('[data-act="toggle-props"]')) { propsOpen = !propsOpen; prefs.set("editor.props", propsOpen); renderProps(true); return; }
    if (e.target.closest('[data-act="add-prop"]')) { propsOpen = true; adding = true; renderProps(true); return; }
    const un = e.target.closest("[data-untag]");
    if (un) { patch({ tags: n.tags.filter(t => t !== un.dataset.untag) }); return; }
    const del = e.target.closest("[data-del]");
    if (del) patch({ props: { [del.dataset.del]: null } });
  });
  propsBox.addEventListener("change", e => {
    const el = e.target;
    const n = item();
    if (el.classList.contains("prop-value")) {
      const k = el.dataset.key;
      const v = readValue(el.value, n.props[k]);
      if (JSON.stringify(v) !== JSON.stringify(n.props[k])) patch({ props: { [k]: v } });
    }
  });
  propsBox.addEventListener("keydown", e => {
    const el = e.target;
    const n = item();
    if (el.classList.contains("prop-tag-input") && (e.key === "Enter" || e.key === ",") && el.value.trim()) {
      e.preventDefault();
      const add = el.value.split(",").map(s => s.trim().replace(/^#+/, "")).filter(Boolean);
      el.value = "";
      adding = false;
      patch({ tags: [...new Set([...(n.tags || []), ...add])] }, { keepTagInput: true });
    } else if ((el.classList.contains("prop-new-key") || el.classList.contains("prop-new-value")) && e.key === "Enter") {
      e.preventDefault();
      const key = propsBox.querySelector(".prop-new-key").value.trim();
      const value = propsBox.querySelector(".prop-new-value").value.trim();
      if (el.classList.contains("prop-new-key") && key && !value) { propsBox.querySelector(".prop-new-value").focus(); return; }
      adding = false;
      el.blur();
      if (!key) { renderProps(true); return; }
      if (key === "tags") patch({ tags: [...new Set([...(n.tags || []), ...value.split(",").map(s => s.trim().replace(/^#+/, "")).filter(Boolean)])] });
      else patch({ props: { [key]: value } });
    } else if (e.key === "Escape") {
      adding = false;
      el.blur();
      renderProps(true);
    } else if (el.classList.contains("prop-value") && e.key === "Enter") el.blur();
  });
  propsBox.addEventListener("focusout", () => setTimeout(() => {
    if (!propsBox.contains(document.activeElement) && adding) { adding = false; renderProps(true); }
  }, 0));

  function renderMeta() {
    const n = item();
    if (!n) return;
    const folder = folderOf(n.path);
    $(".doc-meta").innerHTML = `${folder ? `<span class="dot" style="background:${app.colorOf(n)}"></span><span class="path">${esc(folder)}</span>` : `<span class="path">vault root</span>`}
      <span class="doc-mode"><button type="button" class="btn-link" data-act="mode" title="Toggle reading view (Ctrl E)">${mode === "edit" ? "Reading view" : "Edit"}</button></span>`;
    if (document.activeElement !== titleInput) titleInput.value = n.title;
    autosize();
    renderProps();
  }

  function renderReading() {
    reading.innerHTML = editor.value.trim() ? md.render(editor.value) : `<p class="faint">Empty.</p>`;
  }

  function applyMode() {
    editorBox.hidden = mode !== "edit";
    reading.hidden = mode === "edit";
    if (mode !== "edit") renderReading();
    renderMeta();
  }

  function setMode(m) {
    mode = m;
    prefs.set("editor.mode", m);
    applyMode();
    if (m === "edit") editor.focus();
  }

  function showStatus(state) {
    if (tabsApi.active !== tab) return;
    const n = item();
    if (!n) return;
    const parts = [`${words(editor.value)} words`, `${app.backlinks(n.id).length} backlinks`];
    if (state) parts.push(state);
    status.set("tab", parts.join(" · "));
  }

  function autosize() {
    if (!pane.offsetParent) return;
    titleInput.style.height = "auto";
    titleInput.style.height = `${titleInput.scrollHeight}px`;
  }

  titleInput.addEventListener("input", autosize);
  titleInput.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); titleInput.blur(); setMode("edit"); }
    if (e.key === "Escape") { titleInput.value = item()?.title ?? ""; titleInput.blur(); }
  });
  titleInput.addEventListener("blur", commitTitle);

  pane.addEventListener("click", e => {
    if (e.target.closest('[data-act="mode"]')) { setMode(mode === "edit" ? "read" : "edit"); return; }
    const box = e.target.closest("input.task-box");
    if (box && reading.contains(box)) {
      // tick a task from the reading view: flip that line in the note
      const line = +box.dataset.line;
      const next = toggleTask(editor.value, line);
      if (line >= 0 && next !== editor.value) {
        editor.setValue(next);
        dirty = true;
        renderReading();
        save();
      }
      return;
    }
    const w = e.target.closest("a.wikilink");
    if (w) { e.preventDefault(); followLink(w.dataset.target); return; }
    const a = e.target.closest("a[data-ext]");
    if (a) { e.preventDefault(); openExternal(a.getAttribute("href")); }
  });

  // Outline: jump to a heading
  const offGoto = app.on("goto-line", ({ id, line }) => {
    if (id !== tab.id) return;
    if (mode !== "edit") setMode("edit");
    const doc = editor.view.state.doc;
    const pos = doc.line(Math.min(doc.lines, line + 1)).from;
    editor.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    editor.focus();
  });

  applyMode();

  return {
    // Data reloaded: take the file's body unless the user has unsaved typing.
    update() {
      const n = item();
      if (!n) return;
      if (!dirty && n.body !== editor.value) {
        editor.setValue(n.body);
        saved = n.body;
        if (mode !== "edit") renderReading();
      }
      renderMeta();
      showStatus();
    },
    show() {
      autosize(); // sized 0 while the pane was hidden
      app.select(tab.id, { source: "tab" });
      showStatus();
      if (tab.focusTitle) { tab.focusTitle = false; titleInput.focus(); titleInput.select(); }
    },
    hide() { save(); status.set("tab", ""); },
    setMode,
    toggleMode: () => setMode(mode === "edit" ? "read" : "edit"),
    focus: () => (mode === "edit" ? editor.focus() : null),
    save,
    destroy() { offGoto(); save().then(() => editor.destroy()); },
  };
}
