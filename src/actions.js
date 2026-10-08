// User-level actions shared by buttons, the empty state and the command palette.

import { api, isDesktop } from "./api.js";
import { app } from "./state.js";
import { TYPE } from "./lib/types.js";
import { toast } from "./shell/toast.js";
import { importSampleCanvas } from "./data/sample-canvas.js";
import { today, addDays } from "./lib/tasks.js";

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

// Daily notes: daily/YYYY-MM-DD.md (an existing note with that date as its
// name, anywhere in the vault, is used instead, e.g. from Obsidian).
export async function openDaily(offset = 0) {
  const day = addDays(today(), offset);
  const existing = [...app.items.values()].find(n => n.type !== "canvas" && (n.title === day || (n.path || "").split("/").pop() === `${day}.md`));
  if (existing) { app.open(existing.id); return existing; }
  try {
    const item = await api.createItem({ title: day, folder: "daily", tags: ["daily"], body: "## Plan\n- [ ] \n\n## Notes\n" });
    await app.reload();
    app.open(item.id, { mode: "edit" });
    return item;
  } catch (e) {
    toast(`Couldn't create the daily note: ${e}`, "error");
  }
}

export async function newCanvas() {
  try {
    const item = await api.createCanvas(uniqueTitle("Untitled canvas"));
    await app.reload();
    app.open(item.id, { focusTitle: true });
    return item;
  } catch (e) {
    toast(`Couldn't create canvas: ${e}`, "error");
  }
}

export async function importSample() {
  try {
    const n = await api.importSample();
    await importSampleCanvas(api).catch(e => console.warn("sample canvas", e));
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
