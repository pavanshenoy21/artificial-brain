// Built-in commands for the Ctrl P palette. Later milestones register their
// own (settings, capture, GitHub, AI) next to their code.

import { registerCommand as reg } from "./palette/commands.js";
import { app } from "./state.js";
import { api, isDesktop } from "./api.js";
import { newItem, importSample, openVaultFolder, rebuildIndex, deleteItem, syncGithub } from "./actions.js";
import { TYPES } from "./lib/types.js";
import { toast } from "./shell/toast.js";
import { openNewDialog } from "./forms/new-dialog.js";

export function registerCoreCommands({ graph, tabs, left, right, search, setTheme }) {
  const itemTab = () => (tabs.active?.kind === "item" ? tabs.active : null);
  const current = () => app.items.get(itemTab()?.id || app.selected);

  // notes open straight in the editor; typed items get a form first
  for (const t of TYPES)
    reg({ id: `new-${t.id}`, title: `New ${t.one.toLowerCase()}`, iconName: "plus", keys: t.id === "note" ? "Ctrl N" : undefined,
      run: () => (t.id === "note" ? newItem("note") : openNewDialog(t.id)) });

  reg({ id: "capture", title: "Quick capture", iconName: "capture", keys: "Ctrl Shift Space", run: () => api.openCapture() });
  reg({ id: "search", title: "Search", iconName: "search", keys: "Ctrl K", run: search });
  reg({ id: "graph", title: "Show graph", iconName: "graph", keys: "Ctrl G", run: () => tabs.activate("graph") });
  reg({ id: "toggle-view", title: "Toggle 2D / 3D graph", iconName: "graph", keys: "V", run: () => { tabs.activate("graph"); graph.toggleView(); } });
  reg({ id: "clear-focus", title: "Clear graph focus", iconName: "graph", keys: "Esc", run: () => graph.clearFocus() });
  reg({ id: "toggle-theme", title: "Toggle light / dark theme", iconName: "sun",
    run: () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light") });
  reg({ id: "toggle-left", title: "Toggle left sidebar", iconName: "panel-left", run: () => left.toggle() });
  reg({ id: "toggle-right", title: "Toggle right sidebar", iconName: "panel-right", run: () => right.toggle() });
  reg({ id: "show-files", title: "Show files", iconName: "files", run: () => left.show("files") });
  reg({ id: "show-tags", title: "Show tags", iconName: "tags", run: () => left.show("tags") });
  reg({ id: "show-inbox", title: "Show inbox", iconName: "inbox", run: () => left.show("inbox") });

  reg({ id: "toggle-reading", title: "Toggle reading view", iconName: "read", keys: "Ctrl E", when: () => !!itemTab(), run: () => itemTab().view.toggleMode() });
  reg({ id: "close-tab", title: "Close tab", iconName: "x", keys: "Ctrl W", when: () => !!itemTab(), run: () => tabs.closeActive() });
  reg({ id: "rename", title: "Rename current item", iconName: "edit", when: () => !!itemTab(),
    run: () => { const el = itemTab().pane.querySelector(".doc-title-input"); el.focus(); el.select(); } });
  reg({ id: "open-selected", title: "Open selected item in a tab", iconName: "file", when: () => !!app.selected && !itemTab(), run: () => app.open(app.selected) });
  reg({ id: "copy-link", title: "Copy wikilink to current item", iconName: "copy", when: () => !!current(), run: async () => {
    const n = current();
    const stem = (n.path || "").split("/").pop().replace(/\.md$/, "") || n.title;
    const link = stem === n.title ? `[[${n.title}]]` : `[[${stem}|${n.title}]]`;
    try { await navigator.clipboard.writeText(link); toast(`Copied ${link}`); } catch { toast("Clipboard not available", "error"); }
  } });
  reg({ id: "delete", title: "Delete current item (move to .trash)", iconName: "trash", when: () => !!current(), run: () => deleteItem(current().id) });

  reg({ id: "sync-github", title: "Sync GitHub projects", iconName: "github",
    disabled: () => (app.settings?.github?.token ? false : "Add a GitHub token in Settings"), run: syncGithub });
  reg({ id: "rebuild-index", title: "Rebuild index", iconName: "refresh", run: rebuildIndex });
  reg({ id: "reload", title: "Reload vault", iconName: "refresh", run: () => app.reload() });
  reg({ id: "import-sample", title: "Import sample data", iconName: "download", run: importSample });
  reg({ id: "open-vault", title: "Open another vault folder", iconName: "folder",
    disabled: () => (isDesktop ? false : "Works in the desktop app"), run: openVaultFolder });
}
