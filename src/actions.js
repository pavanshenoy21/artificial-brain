// File operations shared by the file explorer, menus, the command palette and
// shortcuts. Everything that moves a file tells app.moved() so open tabs, the
// selection and the graph follow the new path.

import { api, isDesktop } from "./api.js";
import { app } from "./state.js";
import { toast } from "./shell/toast.js";
import { confirmDialog } from "./shell/dialog.js";
import { today, addDays } from "./lib/tasks.js";

const fail = (what, e) => { toast(`${what}: ${e?.message || e}`, "error"); return null; };
const nameOf = p => p.split("/").pop();

// New note "Untitled" (then "Untitled 1", …) in `folder` (default: vault root).
export async function newNote(folder = "", { open = true } = {}) {
  try {
    const item = await api.createItem({ folder });
    await app.reload();
    app.emit("created", item.id);
    if (open) app.open(item.id, { mode: "edit", focusTitle: true });
    return item;
  } catch (e) {
    return fail("Couldn't create the note", e);
  }
}

export async function newCanvas(folder = "") {
  try {
    const item = await api.createCanvas("Untitled", folder);
    await app.reload();
    app.emit("created", item.id);
    app.open(item.id, { focusTitle: true });
    return item;
  } catch (e) {
    return fail("Couldn't create the canvas", e);
  }
}

// New folder "Untitled" (then "Untitled 1", …); the explorer starts renaming it.
export async function newFolder(parent = "") {
  const at = n => (parent ? `${parent}/` : "") + n;
  let name = "Untitled";
  for (let i = 1; app.folders.includes(at(name)); i++) name = `Untitled ${i}`;
  try {
    const path = await api.createFolder(at(name));
    await app.reload();
    app.emit("rename-folder", path);
    return path;
  } catch (e) {
    return fail("Couldn't create the folder", e);
  }
}

// Rename a note or canvas (its file name). Returns the new path.
export async function renameItem(id, title) {
  const n = app.items.get(id);
  title = String(title || "").replace(/\s+/g, " ").trim();
  if (!n || !title || title === n.title) return id;
  try {
    const item = await api.updateItem(id, { title });
    if (item.id !== id) app.moved([[id, item.id]]);
    await app.reload();
    return item.id;
  } catch (e) {
    fail("Rename failed", e);
    return id;
  }
}

export async function moveItem(id, folder) {
  try {
    const moved = await api.moveItem(id, folder);
    app.moved(moved);
    await app.reload();
    return moved;
  } catch (e) {
    return fail("Move failed", e);
  }
}

// Rename or move a folder (`to` is the new full path).
export async function renameFolder(from, to) {
  to = to.split("/").map(s => s.trim()).filter(Boolean).join("/");
  if (!to || to === from) return from;
  try {
    const moved = await api.renameFolder(from, to);
    app.moved(moved);
    app.emit("folder-moved", { from, to });
    await app.reload();
    return to;
  } catch (e) {
    fail("Rename failed", e);
    return from;
  }
}

export async function deleteItem(id) {
  const n = app.items.get(id);
  if (!n) return;
  const ok = await confirmDialog({ title: `Delete "${n.title}"?`, body: "It's moved to the vault's .trash folder." });
  if (!ok) return;
  try {
    await api.deleteItem(id);
    await app.reload();
  } catch (e) {
    fail("Delete failed", e);
  }
}

export async function deleteFolder(path) {
  const count = [...app.items.keys()].filter(p => p.startsWith(`${path}/`)).length;
  const ok = await confirmDialog({
    title: `Delete the folder "${nameOf(path)}"?`,
    body: `${count ? `It and the ${count} file${count === 1 ? "" : "s"} in it are` : "It's"} moved to the vault's .trash folder.`,
  });
  if (!ok) return;
  try {
    await api.deleteFolder(path);
    await app.reload();
  } catch (e) {
    fail("Delete failed", e);
  }
}

export async function setFolderColor(path, color) {
  try {
    await api.setFolderColor(path, color);
    await app.reload();
  } catch (e) {
    fail("Couldn't set the colour", e);
  }
}

// Daily notes, like Obsidian's core plugin: YYYY-MM-DD.md in the vault root
// (an existing note with that name anywhere is used instead).
export async function openDaily(offset = 0) {
  const day = addDays(today(), offset);
  const existing = [...app.items.values()].find(n => n.type === "note" && n.title === day);
  if (existing) { app.open(existing.id); return existing; }
  try {
    const item = await api.createItem({ title: day });
    await app.reload();
    app.open(item.id, { mode: "edit" });
    return item;
  } catch (e) {
    return fail("Couldn't create the daily note", e);
  }
}

export async function importSample() {
  try {
    const n = await api.importSample();
    await app.reload();
    toast(`Imported ${n} files`);
  } catch (e) {
    fail("Import failed", e);
  }
}

export async function openVaultFolder() {
  if (!isDesktop) { toast("Opening folders works in the desktop app"); return; }
  const path = await api.pickFolder();
  if (!path) return;
  try {
    const info = await api.openVault(path);
    app.emit("vault", info);
    await app.reload();
  } catch (e) {
    fail("Couldn't open the vault", e);
  }
}

export async function rebuildIndex() {
  try {
    const r = await api.rebuildIndex();
    await app.reload();
    toast(`Index rebuilt: ${r.updated} files`);
  } catch (e) {
    fail("Rebuild failed", e);
  }
}

// [[link]] text for an item, the way Obsidian writes it.
export const wikilinkTo = n => (n.type === "canvas" ? `[[${nameOf(n.path)}]]` : `[[${n.title}]]`);
