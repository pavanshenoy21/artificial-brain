// Built-in commands for the Ctrl P palette.

import { registerCommand as reg } from "./palette/commands.js";
import { app } from "./state.js";
import { isDesktop } from "./api.js";
import {
  newNote, newCanvas, newFolder, openDaily, importSample, openVaultFolder, rebuildIndex, deleteItem, moveItem, wikilinkTo,
} from "./actions.js";
import { toast } from "./shell/toast.js";
import { pickFolder } from "./sidebar/menus.js";
import { folderOf } from "./lib/folders.js";

export function registerCoreCommands({ graph, tabs, left, right, search, setTheme, openSettings }) {
  const itemTab = () => (tabs.active?.kind === "item" ? tabs.active : null);
  const current = () => app.items.get(itemTab()?.id || app.selected);
  // new files go next to the open one, like Obsidian's "same folder as current file"
  const here = () => folderOf(current()?.path || "");

  reg({ id: "new-note", title: "Create new note", iconName: "new-note", keys: "Ctrl N", run: () => newNote() });
  reg({ id: "new-note-here", title: "Create new note in the current folder", iconName: "new-note", when: () => !!here(), run: () => newNote(here()) });
  reg({ id: "new-folder", title: "Create new folder", iconName: "folder-plus", run: () => newFolder(here()) });
  reg({ id: "new-canvas", title: "Create new canvas", iconName: "canvas", run: () => newCanvas(here()) });
  reg({ id: "daily", title: "Open today's daily note", iconName: "calendar", keys: "Ctrl Shift D", run: () => openDaily(0) });
  reg({ id: "daily-prev", title: "Open yesterday's daily note", iconName: "calendar", run: () => openDaily(-1) });
  reg({ id: "daily-next", title: "Open tomorrow's daily note", iconName: "calendar", run: () => openDaily(1) });

  reg({ id: "search", title: "Search", iconName: "search", keys: "Ctrl K", run: search });
  reg({ id: "graph", title: "Open graph view", iconName: "graph", keys: "Ctrl G", run: () => tabs.activate("graph") });
  reg({ id: "toggle-view", title: "Toggle 2D / 3D graph", iconName: "graph", keys: "V", run: () => { tabs.activate("graph"); graph.toggleView(); } });
  reg({ id: "fit-graph", title: "Fit graph in view", iconName: "graph", run: () => { tabs.activate("graph"); graph.fitAll(); } });
  reg({ id: "clear-focus", title: "Clear graph focus", iconName: "graph", keys: "Esc", run: () => graph.clearFocus() });
  reg({ id: "focus-folder", title: "Focus the current folder in the graph", iconName: "graph", when: () => !!here(),
    run: () => { tabs.activate("graph"); graph.focusFolder(here()); } });
  reg({ id: "toggle-theme", title: "Toggle light / dark theme", iconName: "sun",
    run: () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light") });
  reg({ id: "toggle-left", title: "Toggle left sidebar", iconName: "panel-left", run: () => left.toggle() });
  reg({ id: "toggle-right", title: "Toggle right sidebar", iconName: "panel-right", run: () => right.toggle() });
  reg({ id: "show-files", title: "Show file explorer", iconName: "files", run: () => left.show("files") });
  reg({ id: "show-tags", title: "Show tags", iconName: "tags", run: () => left.show("tags") });
  reg({ id: "show-backlinks", title: "Show backlinks", iconName: "backlinks", run: () => right.show("backlinks") });
  reg({ id: "show-outgoing", title: "Show outgoing links", iconName: "outgoing", run: () => right.show("outgoing") });
  reg({ id: "show-outline", title: "Show outline", iconName: "outline", run: () => right.show("outline") });

  reg({ id: "toggle-reading", title: "Toggle reading view", iconName: "read", keys: "Ctrl E", when: () => !!itemTab(), run: () => itemTab().view.toggleMode?.() });
  reg({ id: "close-tab", title: "Close tab", iconName: "x", keys: "Ctrl W", when: () => !!itemTab(), run: () => tabs.closeActive() });
  reg({ id: "rename", title: "Rename file", iconName: "edit", keys: "F2", when: () => !!current(), run: () => app.emit("rename-file", current().id) });
  reg({ id: "move", title: "Move file to another folder", iconName: "folder", when: () => !!current(),
    run: () => pickFolder(`Move "${current().title}" to…`, f => moveItem(current().id, f), here()) });
  reg({ id: "reveal", title: "Reveal file in explorer", iconName: "files", when: () => !!current(), run: () => app.emit("reveal", current().id) });
  reg({ id: "copy-link", title: "Copy link to current file", iconName: "copy", when: () => !!current(), run: async () => {
    const link = wikilinkTo(current());
    try { await navigator.clipboard.writeText(link); toast(`Copied ${link}`); } catch { toast("Clipboard not available", "error"); }
  } });
  reg({ id: "delete", title: "Delete current file", iconName: "trash", when: () => !!current(), run: () => deleteItem(current().id) });

  reg({ id: "settings", title: "Open settings", iconName: "settings", run: openSettings });
  reg({ id: "rebuild-index", title: "Rebuild index", iconName: "refresh", run: rebuildIndex });
  reg({ id: "reload", title: "Reload vault", iconName: "refresh", run: () => app.reload() });
  reg({ id: "import-sample", title: "Import sample vault", iconName: "download", run: importSample });
  reg({ id: "open-vault", title: "Open another vault folder", iconName: "folder",
    disabled: () => (isDesktop ? false : "Works in the desktop app"), run: openVaultFolder });
}
