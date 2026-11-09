// The only place the frontend talks to the backend. Inside Tauri this calls
// the Rust commands (src-tauri/src/commands.rs); in a plain browser it uses the
// in-memory mock backend (seeded with the sample vault), so `npm run dev` and
// Playwright work without a display.

import { createMockBackend } from "./mock/backend.js";
import { sampleFiles } from "./data/sample.js";

export const isDesktop = !!window.__TAURI_INTERNALS__;

async function call(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

// Vault folder + convertFileSrc, so canvases can show images from the vault.
let fileBase = null;
let convertFileSrc = null;
async function rememberVault(info) {
  if (!convertFileSrc) ({ convertFileSrc } = await import("@tauri-apps/api/core"));
  fileBase = info?.path ? info.path.replace(/[\\/]+$/, "") : null;
  return info;
}

function tauriBackend() {
  return {
    loadGraph: () => call("get_graph"),                       // { nodes, folders, links, colors }
    getItem: id => call("get_item", { id }),
    createItem: input => call("create_item", { input }),      // { title?, body?, folder?, tags?, ...properties }
    updateItem: (id, patch) => call("update_item", { id, patch }), // returns the item (new id if renamed)
    deleteItem: id => call("delete_item", { id }),            // moves the file to .trash
    listTags: () => call("list_tags"),                        // [[tag, count]]
    search: (query, limit = 20) => call("search", { query, limit }), // [{ id, score, snippet }]
    importSample: () => call("import_sample", { files: sampleFiles() }),
    rebuildIndex: () => call("rebuild_index"),
    vaultInfo: () => call("vault_info").then(rememberVault),  // { path, items, error }
    openVault: path => call("open_vault", { path }).then(rememberVault),
    async pickFolder() {
      const { open } = await import("@tauri-apps/plugin-dialog");
      return open({ directory: true, title: "Choose a vault folder" });
    },
    getSettings: () => call("get_settings"),
    saveSettings: settings => call("save_settings", { settings }),
    fileUrl: rel => (fileBase && convertFileSrc ? convertFileSrc(`${fileBase}/${rel}`) : null),
    createCanvas: (title, folder) => call("create_canvas", { title, folder }),
    getCanvas: id => call("get_canvas", { id }),               // JSON Canvas: { nodes, edges }
    saveCanvas: (id, data) => call("save_canvas", { id, data }),
    createFolder: path => call("create_folder", { path }),
    renameFolder: (from, to) => call("rename_folder", { from, to }), // [[old, new]] of moved files
    deleteFolder: path => call("delete_folder", { path }),
    moveItem: (id, folder) => call("move_item", { id, folder }),     // [[old, new]]
    setFolderColor: (folder, color) => call("set_folder_color", { folder, color }),
    gitStatus: () => call("git_status"),                      // { enabled, repo: { is_repo, branch, remote, upstream }, last }
    gitBackupNow: () => call("git_backup_now"),               // { at, ok, committed, pushed, files, message }
    on(event, fn) {
      let un;
      let dead = false;
      import("@tauri-apps/api/event")
        .then(({ listen }) => listen(event, e => fn(e.payload)))
        .then(u => (dead ? u() : (un = u)));
      return () => { dead = true; un?.(); };
    },
    onChange(fn) {
      return this.on("vault-changed", fn);
    },
  };
}

// URL flag ?empty starts the mock with an empty vault (to preview the first-run state).
const emptyMock = !isDesktop && new URLSearchParams(location.search).has("empty");

export const api = isDesktop ? tauriBackend() : createMockBackend({ seed: !emptyMock });
