// The only place the frontend talks to the backend. Inside Tauri this calls
// the Rust commands (src-tauri/src/commands.rs); in a plain browser it uses the
// in-memory mock backend (seeded with sample data), so `npm run dev` and
// Playwright work without a display.

import { createMockBackend } from "./mock/backend.js";
import { buildSampleGraph } from "./data/sample.js";

export const isDesktop = !!window.__TAURI_INTERNALS__;

async function call(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

function tauriBackend() {
  return {
    loadGraph: () => call("get_graph"),                       // { nodes, links, lobes }
    getItem: id => call("get_item", { id }),
    createItem: input => call("create_item", { input }),      // { type, title, lobe?, tags?, body?, ...fields }
    updateItem: (id, patch) => call("update_item", { id, patch }), // null removes a field
    deleteItem: id => call("delete_item", { id }),            // moves the file to .trash
    listTags: () => call("list_tags"),                        // [[tag, count]]
    search: (query, limit = 20) => call("search", { query, limit }), // [{ id, score, snippet }]
    importSample: () => call("import_sample", buildSampleGraph()),
    rebuildIndex: () => call("rebuild_index"),
    listLobes: () => call("list_lobes"),
    saveLobes: lobes => call("save_lobes", { lobes }),
    vaultInfo: () => call("vault_info"),                      // { path, items, error }
    openVault: path => call("open_vault", { path }),
    async pickFolder() {
      const { open } = await import("@tauri-apps/plugin-dialog");
      return open({ directory: true, title: "Choose a vault folder" });
    },
    capture: text => call("capture", { text }),              // { item, existing }
    refetchLink: id => call("refetch_link", { id }),
    openCapture: () => call("open_capture"),
    hideCapture: () => call("hide_capture"),
    getSettings: () => call("get_settings"),
    saveSettings: settings => call("save_settings", { settings }),
    onChange(fn) {
      let un;
      let dead = false;
      import("@tauri-apps/api/event")
        .then(({ listen }) => listen("vault-changed", e => fn(e.payload)))
        .then(u => (dead ? u() : (un = u)));
      return () => { dead = true; un?.(); };
    },
  };
}

// URL flag ?empty starts the mock with an empty vault (to preview the first-run state).
const emptyMock = !isDesktop && new URLSearchParams(location.search).has("empty");

export const api = isDesktop ? tauriBackend() : createMockBackend({ seed: !emptyMock });
