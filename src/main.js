// Bootstrap: shell, graph tab, sidebars, palettes, keyboard.

import { app } from "./state.js";
import { api, isDesktop } from "./api.js";
import { left, right, ribbonButton } from "./shell/layout.js";
import { tabsApi as tabs } from "./shell/tabs.js";
import { status } from "./shell/statusbar.js";
import { createGraphView } from "./graph/view.js";
import { initLeftSidebar } from "./sidebar/left.js";
import { initRightSidebar } from "./sidebar/right.js";
import { fileMenu } from "./sidebar/menus.js";
import { itemTab } from "./editor/item-tab.js";
import { openSearch } from "./palette/search.js";
import { paletteOpen, close as closePalette } from "./palette/palette.js";
import { travel } from "./travel.js";
import { itemIcon } from "./icons.js";
import { esc, reduceMotion } from "./util.js";
import { prefs } from "./lib/prefs.js";
import { initEmptyState } from "./shell/empty.js";
import { newNote, newCanvas, openDaily } from "./actions.js";
import { openCommands } from "./palette/commands.js";
import { registerCoreCommands } from "./core-commands.js";
import { settingsTab } from "./settings/view.js";

// ------------------------------------------------------------------ tabs + graph
let graph;
let vaultInfo = null;
let emptyState;
tabs.register("graph", pane => {
  graph = createGraphView(pane);
  emptyState = initEmptyState(pane, () => vaultInfo);
  return {};
});
tabs.register("item", itemTab);
tabs.register("settings", settingsTab);
const openSettings = () => tabs.openView("settings", { title: "Settings", iconName: "settings" });
tabs.addGraph();

const rightSide = initRightSidebar();
initLeftSidebar({ graph });

// ------------------------------------------------------------------ selection / opening
const graphActive = () => tabs.active?.kind === "graph";

app.on("select", ({ id, source }) => {
  const n = app.items.get(id);
  if (!n) return;
  if (source !== "graph-search") graph.focusNode(n, { fly: source !== "graph" && source !== "tab" });
});
app.on("open", ({ id, mode, focusTitle }) => tabs.openItem(id, { mode, focusTitle }));
app.on("show-graph", () => tabs.activate("graph"));
app.on("graph-focus-cleared", () => { app.selected = null; app.emit("select", { id: null }); });
app.on("file-menu", ({ id, at }) => fileMenu(id, at));
app.on("data", () => {
  graph.setData();
  tabs.refresh();
});

// Search pick: in the graph tab, fly to the note and send a card to the
// sidebar; elsewhere (or with Ctrl Enter, or for a canvas) open it in a tab.
let travelling = false;
async function openFromSearch(n, { alt } = {}) {
  if (alt || !graphActive() || n.type !== "note") { app.open(n.id); return; }
  if (travelling) return;
  travelling = true;
  try {
    right.show("backlinks");
    graph.focusNode(n);
    const flyMs = reduceMotion() ? 0 : 700;
    await new Promise(r => setTimeout(r, flyMs + 30));
    await travel({
      from: graph.screenPos(n),
      to: rightSide.rect(),
      html: `${itemIcon(n, app.colorOf(n))}<span>${esc(n.title)}</span>`,
      layer: document.getElementById("fx-layer"),
    });
    app.select(n.id, { source: "graph-search" });
  } finally {
    travelling = false;
  }
}
const search = () => openSearch({ onPick: openFromSearch });

// ------------------------------------------------------------------ ribbon
ribbonButton({ iconName: "panel-left", title: "Toggle left sidebar", onClick: () => left.toggle() });
ribbonButton({ iconName: "search", title: "Search (Ctrl K)", onClick: search });
ribbonButton({ iconName: "graph", title: "Graph view (Ctrl G)", onClick: () => tabs.activate("graph") });
ribbonButton({ iconName: "canvas", title: "Create new canvas", onClick: () => newCanvas() });
ribbonButton({ iconName: "calendar", title: "Open today's daily note (Ctrl Shift D)", onClick: () => openDaily(0) });
ribbonButton({ iconName: "command", title: "Command palette (Ctrl P)", onClick: openCommands });
ribbonButton({
  iconName: "sun", title: "Toggle theme", bottom: true,
  onClick: () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"),
});
ribbonButton({ iconName: "settings", title: "Settings", bottom: true, onClick: openSettings });

// Theme: settings.json is the truth; prefs keep a copy so the first paint is right.
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  prefs.set("theme", t);
  graph.applyTheme();
}
function setTheme(t) {
  applyTheme(t);
  if (app.settings && app.settings.theme !== t) {
    api.saveSettings({ ...app.settings, theme: t }).then(s => { app.settings = s; app.emit("settings", s); }).catch(() => {});
  }
}
app.on("theme", applyTheme);

registerCoreCommands({ graph, tabs, left, right, search, setTheme, openSettings });

// ------------------------------------------------------------------ keyboard
const typing = () => {
  const a = document.activeElement;
  return a && (/INPUT|TEXTAREA|SELECT/.test(a.tagName) || a.isContentEditable || a.closest?.(".cm-editor"));
};
const currentFile = () => (tabs.active?.kind === "item" ? tabs.active.id : app.selected);

window.addEventListener("keydown", e => {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && (k === "k" || k === "o")) { e.preventDefault(); paletteOpen() ? closePalette() : search(); return; }
  if (mod && k === "p") { e.preventDefault(); paletteOpen() ? closePalette() : openCommands(); return; }
  if (paletteOpen()) return;
  if (!mod && e.key === "/" && !typing()) { e.preventDefault(); search(); return; }
  if (mod && k === "g") { e.preventDefault(); tabs.activate("graph"); return; }
  if (mod && k === "w") { e.preventDefault(); tabs.closeActive(); return; }
  if (mod && e.key === "Tab") { e.preventDefault(); tabs.next(e.shiftKey ? -1 : 1); return; }
  if (mod && k === "n" && !e.shiftKey) { e.preventDefault(); newNote(); return; }
  if (mod && e.shiftKey && k === "d") { e.preventDefault(); openDaily(0); return; }
  if (mod && k === "e") { e.preventDefault(); tabs.active?.view.toggleMode?.(); return; }
  if (e.key === "F2" && currentFile() && !document.activeElement?.closest?.(".rename-input")) {
    e.preventDefault();
    // an open file: edit its inline title, like Obsidian; else rename in the explorer
    const title = tabs.active?.kind === "item" && tabs.active.pane.querySelector(".doc-title-input, .cv-title");
    if (title) { title.focus(); title.select(); } else app.emit("rename-file", currentFile());
    return;
  }
  if (typing() || mod || e.altKey) return;
  if (graphActive()) {
    if (k === "v") graph.toggleView();
    else if (e.key === "Enter" && app.selected) app.open(app.selected);
    else if (e.key === "Escape") graph.clearFocus();
  }
});

// ------------------------------------------------------------------ start
function showVault(info) {
  vaultInfo = info;
  emptyState.render();
  status.set("vault", info.mock ? "browser preview" : info.path.split(/[\\/]/).filter(Boolean).pop() || info.path, info.path);
}
app.on("vault", showVault);
showVault(await api.vaultInfo());
app.settings = await api.getSettings().catch(() => null);
if (app.settings?.theme && app.settings.theme !== document.documentElement.dataset.theme) applyTheme(app.settings.theme);

try {
  await app.reload();
} catch (e) {
  console.error(e);
  app.loaded = true;
  app.emit("vault", { ...vaultInfo, error: vaultInfo.error || String(e) });
}
tabs.restore();

// Don't lose the last half-second of typing: flush autosaves when the window
// is hidden or closed.
addEventListener("pagehide", () => tabs.saveAll());
document.addEventListener("visibilitychange", () => { if (document.hidden) tabs.saveAll(); });
if (isDesktop) {
  import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
    getCurrentWindow().onCloseRequested(async () => {
      await Promise.race([tabs.saveAll(), new Promise(r => setTimeout(r, 2000))]);
    }),
  ).catch(e => console.warn("close hook unavailable", e));
}

// handy for poking around in devtools
window.brain = { app, api, graph, tabs, setTheme };
