// User-level actions shared by buttons, the empty state and the command palette.

import { api, isDesktop } from "./api.js";
import { app } from "./state.js";
import { TYPE } from "./lib/types.js";
import { toast } from "./shell/toast.js";

// "Untitled", "Untitled 2", … so new titles never collide (wikilinks resolve by title).
export function uniqueTitle(base) {
  const taken = new Set([...app.items.values()].map(n => n.title.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

export async function newItem(type = "note", fields = {}) {
  try {
    const item = await api.createItem({ type, title: uniqueTitle(`Untitled ${TYPE[type]?.one.toLowerCase() || "note"}`.replace("Untitled note", "Untitled")), ...fields });
    await app.reload();
    app.open(item.id, { mode: "edit", focusTitle: true });
    return item;
  } catch (e) {
    toast(`Couldn't create: ${e}`, "error");
  }
}

export async function importSample() {
  try {
    const n = await api.importSample();
    await app.reload();
    toast(`Imported ${n} items`);
  } catch (e) {
    toast(`Import failed: ${e}`, "error");
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
    toast(`Couldn't open vault: ${e}`, "error");
  }
}

export async function rebuildIndex() {
  try {
    const r = await api.rebuildIndex();
    await app.reload();
    toast(`Index rebuilt: ${r.updated} files`);
  } catch (e) {
    toast(`Rebuild failed: ${e}`, "error");
  }
}

export async function deleteItem(id) {
  const n = app.items.get(id);
  if (!n) return;
  try {
    await api.deleteItem(id);
    await app.reload();
    toast(`Moved "${n.title}" to .trash`);
  } catch (e) {
    toast(`Delete failed: ${e}`, "error");
  }
}

export async function syncGithub() {
  toast("Syncing GitHub…");
  try {
    const r = await api.githubSync();
    await app.reload();
    app.emit("github", r);
    toast(`GitHub: ${r.total} repos, ${r.created} new, ${r.updated} updated`);
    return r;
  } catch (e) {
    toast(String(e), "error");
    return null;
  }
}
