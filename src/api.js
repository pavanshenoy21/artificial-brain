// The only place the frontend talks to the backend. Inside Tauri this calls
// the Rust commands; in a plain browser it uses the in-memory mock backend
// (seeded with sample data), so `npm run dev` + Playwright work without a display.

import { createMockBackend } from "./mock/backend.js";
import { LOBES, buildSampleGraph } from "./data/sample.js";

export const isDesktop = !!window.__TAURI_INTERNALS__;

async function call(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

function tauriBackend() {
  return {
    async loadGraph() {
      const g = await call("load_graph");
      return { ...g, lobes: LOBES.map(l => ({ ...l })) };
    },
    getItem: id => call("get_node", { id }),
    createItem: input => call("create_node", { input }),
    updateItem: (id, patch) => call("update_node", { id, patch }),
    deleteItem: id => call("delete_node", { id }),
    listTags: () => call("list_tags"),
    importSample: () => call("import_graph", buildSampleGraph()),
    async vaultInfo() {
      return { path: await call("vault_path"), mock: false };
    },
    onChange(fn) {
      let un;
      import("@tauri-apps/api/event").then(({ listen }) => listen("vault-changed", e => fn(e.payload)).then(u => (un = u)));
      return () => un?.();
    },
  };
}

// URL flag ?empty starts the mock with an empty vault (to preview the first-run state).
const emptyMock = !isDesktop && new URLSearchParams(location.search).has("empty");

export const api = isDesktop ? tauriBackend() : createMockBackend({ seed: !emptyMock });
