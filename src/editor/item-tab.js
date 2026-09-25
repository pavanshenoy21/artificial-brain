// An item opened in a workspace tab: editable title, CodeMirror editor
// (autosave after 500ms) or reading view (Ctrl E toggles).

import { app } from "../state.js";
import { allTags } from "../lib/tags.js";
import { api } from "../api.js";
import { md } from "./markdown.js";
import { createEditor } from "./editor.js";
import { typeIcon } from "../icons.js";
import { TYPE } from "../lib/types.js";
import { esc, openExternal } from "../util.js";
import { prefs } from "../lib/prefs.js";
import { toast } from "../shell/toast.js";
import { status } from "../shell/statusbar.js";
import { tabsApi } from "../shell/tabs.js";
import { editorMenu, itemMenu } from "../ai/actions.js";

md.resolveWikilink = target => app.resolve(target);

const stemOf = n => (n.path || "").split("/").pop().replace(/\.md$/, "") || n.title;
const words = s => (s.match(/[\p{L}\p{N}'’-]+/gu) || []).length;

// Follow a [[link]]: open it, or create the note if it doesn't exist yet (like Obsidian).
export async function followLink(target) {
  const id = app.resolve(target);
  if (id) { app.open(id); return; }
  try {
    const item = await api.createItem({ type: "note", title: target });
    await app.reload();
    app.open(item.id, { mode: "edit" });
  } catch (e) {
    toast(`Couldn't create "${target}": ${e}`, "error");
  }
}

export function linkOptions() {
  return [...app.items.values()]
    .sort((a, b) => (b.degree || 0) - (a.degree || 0) || a.title.localeCompare(b.title))
    .map(n => {
      const stem = stemOf(n);
      return { label: n.title, detail: TYPE[n.type]?.one, apply: stem === n.title ? n.title : `${stem}|${n.title}` };
    });
}

export function itemTab(pane, tab) {
  let mode = tab.mode || prefs.get("editor.mode", "edit");
  pane.innerHTML = `
    <div class="doc">
      <div class="doc-inner">
        <div class="doc-meta"></div>
        <textarea class="doc-title-input" rows="1" spellcheck="false" aria-label="Title"></textarea>
        <div class="tag-row doc-tags"></div>
        <div class="doc-editor"></div>
        <div class="markdown doc-reading" hidden></div>
      </div>
    </div>`;
  const $ = s => pane.querySelector(s);
  const titleInput = $(".doc-title-input");
  const reading = $(".doc-reading");
  const editorBox = $(".doc-editor");

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
    await save();
    try {
      await api.updateItem(tab.id, { title });
      await app.reload();
    } catch (e) {
      toast(`Rename failed: ${e}`, "error");
      titleInput.value = n.title;
    }
  }

  function renderMeta() {
    const n = item();
    if (!n) return;
    const lobe = app.lobeOf(n);
    $(".doc-meta").innerHTML = `${typeIcon(n.type, lobe.color, 12)}<span>${esc(TYPE[n.type]?.one || n.type)}</span>
      <span class="sep">·</span><span class="dot" style="background:${lobe.color}"></span><span>${esc(lobe.name)}</span>
      ${n.path ? `<span class="sep">·</span><span class="path">${esc(n.path)}</span>` : ""}
      <span class="doc-mode"><button type="button" class="btn-link" data-act="mode" title="Toggle reading view (Ctrl E)">${mode === "edit" ? "Reading view" : "Edit"}</button></span>`;
    $(".doc-tags").innerHTML = allTags(n).length ? allTags(n).map(t => `<span class="tag">#${esc(t)}</span>`).join("") : "";
    if (document.activeElement !== titleInput) titleInput.value = n.title;
    autosize();
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
    if (e.key === "Enter") { e.preventDefault(); commitTitle(); setMode("edit"); }
    if (e.key === "Escape") { titleInput.value = item()?.title ?? ""; titleInput.blur(); }
  });
  titleInput.addEventListener("blur", commitTitle);

  pane.addEventListener("click", e => {
    if (e.target.closest('[data-act="mode"]')) { setMode(mode === "edit" ? "read" : "edit"); return; }
    const w = e.target.closest("a.wikilink");
    if (w) { e.preventDefault(); followLink(w.dataset.target); return; }
    const a = e.target.closest("a[data-ext]");
    if (a) { e.preventDefault(); openExternal(a.getAttribute("href")); }
  });

  editorBox.addEventListener("contextmenu", e => { e.preventDefault(); editorMenu(tab, { x: e.clientX, y: e.clientY }); });
  reading.addEventListener("contextmenu", e => { e.preventDefault(); itemMenu(tab.id, { x: e.clientX, y: e.clientY }); });

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
    selection() {
      if (mode !== "edit") return null;
      const { from, to } = editor.view.state.selection.main;
      return { from, to, text: editor.view.state.sliceDoc(from, to) };
    },
    destroy() { save().then(() => editor.destroy()); },
  };
}
