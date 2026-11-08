// Settings tab: vault, appearance, and colours for lobes (top-level folders)
// and their folders. Changes apply right away (like Obsidian).

import { app } from "../state.js";
import { api, isDesktop } from "../api.js";
import { esc } from "../util.js";
import { toast } from "../shell/toast.js";
import { openVaultFolder, rebuildIndex, setFolderColor } from "../actions.js";
import { folderOf } from "../lib/folders.js";

export function settingsTab(pane) {
  let vault = null;

  const row = (label, desc, control) => `
    <div class="set-row"><div class="set-text"><div class="set-label">${label}</div>${desc ? `<div class="set-desc">${desc}</div>` : ""}</div>
    <div class="set-control">${control}</div></div>`;

  function colorRows() {
    const tops = app.folders.filter(f => !f.includes("/"));
    const count = f => [...app.items.keys()].filter(p => p.startsWith(`${f}/`)).length;
    return tops.map(top => {
      const subs = app.folders.filter(f => folderOf(f) === top);
      const line = (f, lobe) => `<div class="color-row${lobe ? " lobe" : ""}" data-folder="${esc(f)}">
        <input type="color" value="${esc(app.scheme.folder(f))}" aria-label="Colour of ${esc(f)}" />
        <span class="color-name">${esc(lobe ? f : f.split("/").pop())}</span>
        <span class="faint">${lobe ? "lobe" : ""}</span>
        <span class="count">${count(f)}</span>
        ${app.scheme.picked(f) ? `<button type="button" class="btn-link" data-act="reset" title="Back to the automatic colour">Automatic</button>` : `<span class="faint auto">automatic</span>`}
      </div>`;
      return `<div class="color-group">${line(top, true)}${subs.map(f => line(f, false)).join("")}</div>`;
    }).join("") || `<p class="set-desc">No folders yet. Top-level folders become lobes.</p>`;
  }

  function render() {
    const theme = app.settings?.theme || "dark";
    pane.innerHTML = `<div class="doc"><div class="doc-inner settings">
      <h1 class="doc-title">Settings</h1>

      <h2>Vault</h2>
      ${row("Folder", "Markdown files live here. Obsidian can open the same folder.",
        `<code class="set-path" title="${esc(vault?.path || "")}">${esc(vault?.path || "")}</code>
         ${isDesktop ? `<button type="button" class="btn" data-act="vault">Change</button>` : ""}`)}
      ${row("Index", "The search index is a cache; rebuilding re-reads every file.", `<button type="button" class="btn" data-act="rebuild">Rebuild index</button>`)}

      <h2>Appearance</h2>
      ${row("Theme", "", `<select class="input" data-act="theme"><option value="dark"${theme === "dark" ? " selected" : ""}>Dark</option><option value="light"${theme === "light" ? " selected" : ""}>Light</option></select>`)}

      <h2>Lobes and folder colours</h2>
      <p class="set-desc">Each top-level folder is a lobe: in the graph it's only its name, in this colour. Its folders get their own colours, and every note inside takes its folder's colour. Colours are saved in the vault (<code>.brain/colors.json</code>). You can also right-click a folder in the file explorer.</p>
      <div class="color-list">${colorRows()}</div>
    </div></div>`;
  }

  pane.addEventListener("click", async e => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "vault") { await openVaultFolder(); vault = await api.vaultInfo(); render(); }
    if (act === "rebuild") rebuildIndex();
    if (act === "reset") setFolderColor(e.target.closest("[data-folder]").dataset.folder, null);
  });
  pane.addEventListener("change", e => {
    if (e.target.matches('[data-act="theme"]')) { app.emit("theme", e.target.value); saveTheme(e.target.value); }
    if (e.target.type === "color") setFolderColor(e.target.closest("[data-folder]").dataset.folder, e.target.value);
  });
  async function saveTheme(t) {
    try {
      app.settings = await api.saveSettings({ ...(app.settings || {}), theme: t });
    } catch (err) {
      toast(`Couldn't save: ${err}`, "error");
    }
  }

  return {
    async show() {
      vault = await api.vaultInfo().catch(() => null);
      render();
    },
    update() {
      // don't redraw under the colour picker the user is using
      if (pane.contains(document.activeElement) && document.activeElement.type === "color") return;
      render();
    },
  };
}
