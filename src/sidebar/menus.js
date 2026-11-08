// Right-click menus for files and folders (file explorer, graph, tabs), and
// the "Move to…" folder picker.

import { app } from "../state.js";
import { openMenu } from "../shell/menu.js";
import { openPalette } from "../palette/palette.js";
import { fuzzy } from "../lib/rank.js";
import { icon } from "../icons.js";
import { esc } from "../util.js";
import { toast } from "../shell/toast.js";
import { GROUP_PALETTE, LOBE_PALETTE, folderOf } from "../lib/folders.js";
import {
  newNote, newCanvas, newFolder, moveItem, renameFolder, deleteItem, deleteFolder, setFolderColor, wikilinkTo,
} from "../actions.js";

const nameOf = p => p.split("/").pop();

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast(`Copied ${text}`); } catch { toast("Clipboard not available", "error"); }
}

export function fileMenu(id, at) {
  const n = app.items.get(id);
  if (!n) return;
  openMenu(at, [
    { label: "Open", iconName: "file", run: () => app.open(id) },
    "-",
    { label: "Rename", iconName: "edit", keys: "F2", run: () => app.emit("rename-file", id) },
    { label: "Move file to…", iconName: "folder", run: () => pickFolder(`Move "${n.title}" to…`, f => moveItem(id, f), folderOf(id)) },
    { label: "Copy link", iconName: "copy", run: () => copy(wikilinkTo(n)) },
    { label: "Copy path", iconName: "copy", run: () => copy(n.path) },
    "-",
    { label: "Reveal in file explorer", iconName: "files", run: () => app.emit("reveal", id) },
    ...(n.type === "note" ? [{ label: "Show in graph", iconName: "graph", run: () => { app.emit("show-graph"); app.select(id, { source: "list" }); } }] : []),
    "-",
    { label: "Delete", iconName: "trash", danger: true, run: () => deleteItem(id) },
  ]);
}

export function folderMenu(path, at) {
  const top = !path.includes("/");
  openMenu(at, [
    { label: "New note", iconName: "edit", run: () => newNote(path) },
    { label: "New folder", iconName: "folder-plus", run: () => newFolder(path) },
    { label: "New canvas", iconName: "canvas", run: () => newCanvas(path) },
    "-",
    { label: "Rename", iconName: "edit", keys: "F2", run: () => app.emit("rename-folder", path) },
    { label: "Move folder to…", iconName: "folder", run: () => pickFolder(`Move "${nameOf(path)}" to…`, f => renameFolder(path, f ? `${f}/${nameOf(path)}` : nameOf(path)), folderOf(path), path) },
    { label: top ? "Lobe colour…" : "Colour…", iconName: "palette", run: () => colorMenu(path, at) },
    "-",
    { label: top ? "Focus lobe in graph" : "Focus in graph", iconName: "graph", run: () => { app.emit("show-graph"); app.emit("focus-folder", path); } },
    { label: "Delete", iconName: "trash", danger: true, run: () => deleteFolder(path) },
  ]);
}

// Colour choices for a folder: the palette its kind uses, plus "Automatic".
export function colorMenu(path, at) {
  const top = !path.includes("/");
  const current = app.scheme.picked(path);
  const palette = top ? LOBE_PALETTE : GROUP_PALETTE;
  openMenu(at, [
    { label: "Automatic", iconName: current ? undefined : "check", run: () => setFolderColor(path, null) },
    "-",
    ...palette.map(c => ({ label: c, swatch: c, iconName: current === c ? "check" : undefined, run: () => setFolderColor(path, c) })),
  ]);
}

// Palette listing folders ("/" = vault root). `except`: a folder can't go into itself.
export function pickFolder(placeholder, onPick, current = "", except = null) {
  const all = ["", ...app.folders].filter(f => f !== current && !(except && (f === except || f.startsWith(`${except}/`))));
  openPalette({
    id: "folders",
    iconName: "folder",
    placeholder,
    empty: "No folders match",
    source: async q => {
      if (!q.trim()) return all.map(f => ({ f }));
      return all.map(f => ({ f, m: fuzzy(f || "/", q) })).filter(x => x.m).sort((a, b) => b.m.score - a.m.score);
    },
    render: ({ f }) => `${icon("folder", { size: 14 })}<div class="r-main"><div class="r-title">${esc(f || "/ (vault root)")}</div></div>
      ${f ? `<span class="r-side"><span class="dot" style="background:${app.scheme.folder(f)}"></span></span>` : ""}`,
    onPick: ({ f }) => onPick(f),
  });
}
