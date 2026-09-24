// Thin wrapper over the Rust storage commands (src-tauri/src/lib.rs).
// Only works inside the desktop app; `hasStore` is false in a plain browser.

export const hasStore = !!window.__TAURI_INTERNALS__;

async function call(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

// { nodes, links } with explicit links from [[wikilinks]]. Syncs with the vault first.
export const loadGraph   = ()          => call("load_graph");
export const syncVault   = ()          => call("sync_vault");
export const getNode     = id          => call("get_node", { id });
// input: { type, title, lobe?, tags?, body?, ...fields }
export const createNode  = input       => call("create_node", { input });
// patch: any subset of the above; null removes a field
export const updateNode  = (id, patch) => call("update_node", { id, patch });
export const deleteNode  = id          => call("delete_node", { id });
export const listTags    = ()          => call("list_tags");
export const vaultPath   = ()          => call("vault_path");

// Copies a { nodes, links } graph (e.g. the sample) into the vault as markdown.
export function importGraph({ nodes, links }) {
  const clean = nodes.map(({ x, y, z, vx, vy, vz, fx, fy, fz, degree, index, __threeObj, ...rest }) => rest);
  const plainLinks = links.map(l => ({
    source: typeof l.source === "object" ? l.source.id : l.source,
    target: typeof l.target === "object" ? l.target.id : l.target,
    kind: l.kind,
  }));
  return call("import_graph", { nodes: clean, links: plainLinks });
}
