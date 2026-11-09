// Settings tab: vault, appearance, and colours for lobes (top-level folders)
// and their folders. Changes apply right away (like Obsidian).

import { app } from "../state.js";
import { api, isDesktop } from "../api.js";
import { esc } from "../util.js";
import { toast } from "../shell/toast.js";
import { openVaultFolder, rebuildIndex, setFolderColor } from "../actions.js";
import { folderOf } from "../lib/folders.js";

const ago = secs => {
  const m = Math.round((Date.now() / 1000 - secs) / 60);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

export function settingsTab(pane) {
  let vault = null;
  let git = null;     // { enabled, repo, last }
  let backingUp = false;

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

  function gitRepoText() {
    if (!git) return "Checking…";
    const r = git.repo;
    if (!r?.is_repo) return "The vault folder isn't a git repository yet: <code>cd</code> into it, <code>git init</code>, <code>git remote add origin &lt;url&gt;</code>.";
    return `Branch <code>${esc(r.branch || "?")}</code> · ${r.remote ? `remote <code>${esc(r.remote)}</code>` : "no remote yet: <code>git remote add origin &lt;url&gt;</code>"}`;
  }

  async function refreshGit() {
    git = await api.gitStatus().catch(() => null);
    render();
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

      <h2>Backup (git)</h2>
      <p class="set-desc">When the app closes it runs <code>git add</code>, <code>git commit</code> and <code>git push</code> in the vault folder, so your notes are saved to your remote (e.g. GitHub) and you can pull them on another device. Set up the repository and its remote once in a terminal; git must be able to push without asking for a password (SSH key or credential helper).</p>
      ${row("Commit and push when closing", "", `<input type="checkbox" data-act="git-toggle" ${app.settings?.git_backup !== false ? "checked" : ""} />`)}
      ${row("Repository", gitRepoText(), `<button type="button" class="btn" data-act="git-now" ${git?.repo?.is_repo && !backingUp ? "" : "disabled"}>${backingUp ? "Backing up…" : "Back up now"}</button>`)}
      ${git?.last ? row("Last backup", "", `<span class="set-result ${git.last.ok ? "ok" : "error"}" data-git-last>${esc(ago(git.last.at))}: ${esc(git.last.message)}</span>`) : ""}

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
    if (act === "git-now") {
      backingUp = true;
      render();
      try {
        const r = await api.gitBackupNow();
        toast(r.ok ? `Backup: ${r.message}` : `Backup failed: ${r.message}`, r.ok ? undefined : "error");
        app.emit("backup", r);
      } catch (err) {
        toast(String(err?.message || err), "error");
      }
      backingUp = false;
      await refreshGit();
    }
  });
  pane.addEventListener("change", e => {
    if (e.target.matches('[data-act="theme"]')) { app.emit("theme", e.target.value); saveSettings({ theme: e.target.value }); }
    if (e.target.matches('[data-act="git-toggle"]')) saveSettings({ git_backup: e.target.checked });
    if (e.target.type === "color") setFolderColor(e.target.closest("[data-folder]").dataset.folder, e.target.value);
  });
  async function saveSettings(change) {
    try {
      app.settings = await api.saveSettings({ ...(app.settings || {}), ...change });
    } catch (err) {
      toast(`Couldn't save: ${err}`, "error");
    }
  }

  return {
    async show() {
      vault = await api.vaultInfo().catch(() => null);
      render();
      refreshGit();
    },
    update() {
      // don't redraw under the colour picker the user is using
      if (pane.contains(document.activeElement) && document.activeElement.type === "color") return;
      render();
    },
  };
}
