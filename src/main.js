// Bootstrap: shell, graph tab, sidebars, palettes, keyboard.

import { app } from "./state.js";
import { api } from "./api.js";
import { left, right, ribbonButton } from "./shell/layout.js";
import { tabsApi as tabs } from "./shell/tabs.js";
import { status } from "./shell/statusbar.js";
import { createGraphView } from "./graph/view.js";
import { initLeftSidebar } from "./sidebar/left.js";
import { initRightSidebar } from "./sidebar/right.js";
import { itemTab } from "./editor/item-tab.js";
import { openSearch } from "./palette/search.js";
import { paletteOpen, close as closePalette } from "./palette/palette.js";
import { travel } from "./travel.js";
import { typeIcon } from "./icons.js";
import { esc, reduceMotion } from "./util.js";
import { prefs } from "./lib/prefs.js";
import { initEmptyState } from "./shell/empty.js";
import { newItem } from "./actions.js";
import { openCommands } from "./palette/commands.js";
import { registerCoreCommands } from "./core-commands.js";
import { settingsTab, PROVIDERS } from "./settings/view.js";
import { setSemanticSearch } from "./palette/search.js";
import { registerCommand } from "./palette/commands.js";

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
app.on("data", () => {
  graph.setData();
  tabs.refresh();
});

// Search pick: in the graph tab, fly to the node and send a card to the sidebar;
// elsewhere (or with Ctrl Enter) open it in a tab.
let travelling = false;
async function openFromSearch(n, { alt } = {}) {
  if (alt || !graphActive()) { app.open(n.id); return; }
  if (travelling) return;
  travelling = true;
  try {
    right.show("item");
    graph.focusNode(n);
    const flyMs = reduceMotion() ? 0 : 700;
    await new Promise(r => setTimeout(r, flyMs + 30));
    const lobe = app.lobeOf(n);
    await travel({
      from: graph.screenPos(n),
      to: rightSide.rect(),
      html: `${typeIcon(n.type, lobe.color, 13)}<span>${esc(n.title)}</span>`,
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
ribbonButton({ iconName: "graph", title: "Graph (Ctrl G)", onClick: () => tabs.activate("graph") });
ribbonButton({ iconName: "command", title: "Commands (Ctrl P)", onClick: openCommands });
ribbonButton({ iconName: "plus", title: "New note (Ctrl N)", onClick: () => newItem("note") });
ribbonButton({ iconName: "capture", title: "Quick capture (Ctrl Shift Space)", onClick: () => api.openCapture() });

ribbonButton({
  iconName: "sun", title: "Toggle theme", bottom: true,
  onClick: () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"),
});
ribbonButton({ iconName: "settings", title: "Settings", bottom: true, onClick: () => openSettings() });
registerCommand({ id: "settings", title: "Open settings", iconName: "settings", run: () => openSettings() });

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

// ------------------------------------------------------------------ AI status
function showAi(s) {
  const p = s?.ai?.provider;
  if (!p || !s.ai.base_url) status.set("ai", "AI off", "No AI provider configured (Settings)");
  else status.set("ai", `AI: ${PROVIDERS[p]?.name.replace(/ \(local\)$/, "") || p}`, [s.ai.model, s.ai.base_url].filter(Boolean).join(" · "));
  setSemanticSearch(s?.embed?.base_url ? q => api.semanticSearch(q, 20) : null);
}
app.on("settings", showAi);
api.on("settings-changed", s => { app.settings = s; showAi(s); });
api.on("embed-status", st => {
  if (st.state === "working") status.set("embed", `Embedding ${st.done}/${st.total}`, "");
  else if (st.state === "error") status.set("embed", "Embeddings unavailable", st.message);
  else status.set("embed", "");
});

registerCoreCommands({ graph, tabs, left, right, search, setTheme });

// ------------------------------------------------------------------ keyboard
const typing = () => {
  const a = document.activeElement;
  return a && (/INPUT|TEXTAREA|SELECT/.test(a.tagName) || a.isContentEditable || a.closest?.(".cm-editor"));
};

window.addEventListener("keydown", e => {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === "k") { e.preventDefault(); paletteOpen() ? closePalette() : search(); return; }
  if (mod && k === "p") { e.preventDefault(); paletteOpen() ? closePalette() : openCommands(); return; }
  if (paletteOpen()) return;
  if (!mod && e.key === "/" && !typing()) { e.preventDefault(); search(); return; }
  if (mod && k === "g") { e.preventDefault(); tabs.activate("graph"); return; }
  if (mod && k === "w") { e.preventDefault(); tabs.closeActive(); return; }
  if (mod && e.key === "Tab") { e.preventDefault(); tabs.next(e.shiftKey ? -1 : 1); return; }
  if (mod && k === "n" && !e.shiftKey) { e.preventDefault(); newItem("note"); return; }
  if (mod && k === "e") { e.preventDefault(); tabs.active?.view.toggleMode?.(); return; }
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
showAi(app.settings);
try {
  await app.reload();
} catch (e) {
  console.error(e);
  app.loaded = true;
  app.emit("vault", { ...vaultInfo, error: vaultInfo.error || String(e) });
}
tabs.restore();

// handy for poking around in devtools
window.brain = { app, api, graph, tabs, setTheme };
