# Artificial Brain — context for Claude Code

Handoff from the Cowork ideation session (Sept 2026). Owner: Pavvy (Fedora, first-year RVCE student).
Style: casual, concise back-and-forth. Ask before building big new pieces.

## Vision
Obsidian-like personal knowledge base, but smarter and more visual: a 3D graph ("artificial brain")
with an AI agent living in it. Cross-platform DESKTOP app (not a website). Currently on Fedora.

Node types:
- note: own notes
- link: saved links. A global shortcut opens a tiny window: paste a URL, close it, and it becomes a node.
  On save, fetch + summarise + embed the page so it doesn't become a bookmark graveyard.
- skill: skills learnt, entered by hand as a form, so for a new project he knows what options he has.
- hackathon: attended + what was built, a form (date, role, built, stack).
- project: synced from GitHub via a fine-grained read-only personal access token.

## Decisions made
- Stack: Tauri v2 (Rust) + Vite + vanilla JS + three.js via 3d-force-graph (+ three-spritetext).
- Store notes as plain markdown files + SQLite metadata, so there's no lock-in and Obsidian can still open them.
- Tagging: the AI *suggests* 2–3 tags chosen only from existing tags; the user accepts with one key.
  Untagged items go to an Inbox. No auto-folders (tags + graph make them redundant).
- Links: explicit [[wikilinks]] are solid lines. Embedding-similarity links are faint "suggested" ones.
- Graph readability: lobes/clusters (colour = lobe, shape = type), focus mode (node + 1–2 hops, rest fades),
  semantic zoom (lobe names far away, node labels up close), type filters. Later: UMAP of embeddings
  for starting positions.
- Search = command palette (Ctrl K or /). The selected result flies from its spot in the graph into the side
  panel (travel animation). Keep it short and skippable.
- Right-click AI actions (on demand, show a diff, keep the original, never add facts): Polish, Summarize,
  Fill form from messy text. Provider is configurable: local llama.cpp server or Groq (both OpenAI-compatible APIs).
- This is SEPARATE from "Jarvis" (his local life-assistant project).

## Current state
- Graph view: lobes + halos, per-type shapes, focus mode, semantic zoom labels, legend filters, fly to lobe,
  idle orbit, search palette + travel animation, detail panel. The Polish/Edit buttons are disabled placeholders.
- Storage (step 1, done): markdown vault is the source of truth, SQLite (`brain.db`) is a rebuildable index.
  - Vault: `$BRAIN_VAULT` or app-data-dir/vault (Linux: ~/.local/share/dev.pavvy.brain/vault), index in
    app-data-dir/brain.db. Layout: notes/, links/, skills/, hackathons/, projects/ as `<Title>.md`; deletes go to .trash/.
  - File = YAML frontmatter (id, type, lobe, title only if the filename had to change, tags, type fields, created,
    updated) + markdown body. [[Wikilinks]] (by filename, path or title) = explicit links. Hand-made/Obsidian files
    work too (id falls back to path, type to folder). `load_graph` syncs by mtime+size before returning.
  - Rust commands: load_graph, sync_vault, get_node, create_node, update_node (null removes a field; title change
    renames the file and rewrites [[backlinks]]), delete_node, list_tags, import_graph, vault_path.
    JS wrapper: src/store.js (also on `window.brain.store` for devtools).
  - Empty vault -> sample data (src/data/sample.js) with an "import into vault" chip.
  - "Similar" links are still shared-tag stand-ins (src/data/similar.js) until embeddings.
- Code map: src/main.js (graph, forces, focus, zoom, wiring), search.js, travel.js, panel.js, shapes.js, store.js,
  src-tauri/src/{lib.rs (commands), store.rs (vault + index), markdown.rs (frontmatter, wikilinks)}.
- Run: `npm install && npm run tauri dev` (UI only in a browser: `npm run dev`, port 1420). Tests: `cd src-tauri && cargo test`.

## Next steps (agreed order)
1. ~~Storage: markdown + SQLite, Rust CRUD commands, replace sample data.~~ Done (no create/edit UI yet).
2. Quick-capture window + global shortcut (tauri-plugin-global-shortcut).
3. Embeddings (llama.cpp) → real similarity links + search blending.
4. Forms for skills / hackathons / projects; GitHub sync.
5. Right-click AI actions.
6. Resident agent chat over the graph (RAG).
