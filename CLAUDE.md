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

## Current state (MVP = graph view only)
- Runs on sample data in src/data/sample.js (placeholder repos/dates/statuses).
- Rust command `load_graph` reads app-data-dir/graph.json if it exists (Linux: ~/.local/share/dev.pavvy.brain/).
- Working: lobes + halos, per-type shapes, focus mode, semantic zoom labels, legend filters, fly to lobe,
  idle orbit, search palette + travel animation, detail panel. The Polish/Edit buttons are disabled placeholders.
- Code map: src/main.js (graph, forces, focus, zoom, wiring), search.js, travel.js, panel.js,
  shapes.js, src-tauri/src/lib.rs.
- Run: `npm install && npm run tauri dev` (UI only in a browser: `npm run dev`, port 1420).

## Next steps (agreed order)
1. Storage: markdown + SQLite, Rust CRUD commands, replace sample data.
2. Quick-capture window + global shortcut (tauri-plugin-global-shortcut).
3. Embeddings (llama.cpp) → real similarity links + search blending.
4. Forms for skills / hackathons / projects; GitHub sync.
5. Right-click AI actions.
6. Resident agent chat over the graph (RAG).
