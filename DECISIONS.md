# Decisions

One line each: what was chosen and why. Newest at the bottom of each milestone.

## Storage (done before the build brief)
- Markdown files are the source of truth, SQLite is a rebuildable index; `rusqlite` with `bundled` so Fedora needs no system SQLite.
- Frontmatter via `serde_yaml` (deprecated upstream but stable and widely used); swapping it is contained in `markdown.rs`.
- `serde_json` with `preserve_order` so frontmatter keys stay in a readable order (id, type, lobe, …).
- Deletes move files to `<vault>/.trash/` instead of removing them: nothing is ever lost by a misclick.
- Index sync compares mtime + size; files the app writes itself are re-indexed explicitly (mtime can be too coarse).
- Two files with the same `id` (a copied file): the second falls back to its path as id instead of clobbering the first.

## Milestone 1: shell + restyle
- Frontend split into `shell/`, `graph/`, `sidebar/`, `palette/`, `editor/`, `lib/`, `mock/`; `state.js` holds shared state + a small event bus.
- `api.js` is the only backend entry point; outside Tauri it uses `mock/backend.js` (in-memory, seeded from `data/sample.js`, same wikilink rules as Rust via `lib/wikilinks.js`). `?empty` in the URL starts the mock with an empty vault.
- Icons: the `lucide` npm package, rendered to inline SVG strings at runtime (tree-shaken, no icon font). Type shapes use Lucide circle/diamond/triangle/hexagon/square.
- Lobe colours toned down from neon to calmer solid colours; the sample's hand-written lobe centres were dropped. Centres are computed: a ring in XY (so 2D keeps lobes apart) with alternating depth for 3D.
- Graph links are custom `THREE.Line` objects (solid `LineBasicMaterial` for wikilinks, `LineDashedMaterial` for similar) so focus can fade them without 3d-force-graph rebuilding every link object.
- Selected node gets a solid accent-coloured back-face outline (not a glow) so it reads as "selected" in both themes.
- Hackathon shape changed from icosahedron to a hexagonal prism to match the Lucide hexagon icon.
- Search travel: flat card, 260ms, straight ease-out line, any key/click skips it. It only runs when the graph tab is active; otherwise (or with Ctrl Enter) the result opens in a tab.
- Clicking a node selects it (focus + right sidebar); double-click or Enter opens it in a tab (3d-force-graph has no dblclick, so two clicks within 400ms count).
- Theme and UI layout live in `localStorage` (`brain.prefs`) for now; they move to `settings.json` in milestone 6 where it matters (theme).

## Milestone 2: vault + index
- Rust split into `vault.rs` (files), `index.rs` (SQLite), `store.rs` (service), `settings.rs`, `watch.rs`, `commands.rs`, `state.rs`, `error.rs`. AI/embed/capture/GitHub modules get added by their milestones.
- File names are the title with only filesystem/wikilink-unsafe characters removed ("Writeup JWT none-alg bypass.md"), not a lowercase-hyphen slug: Obsidian resolves `[[Title]]` by file name, so this keeps links working when the vault is opened in Obsidian. `title:` is always written to frontmatter, so the exact title survives.
- New ids are ULIDs (`ulid` crate); files without an `id:` keep their path as id (never rewritten behind the user's back).
- A type change moves the file into the new type's folder.
- FTS5 is part of rusqlite's bundled SQLite. Query = each word quoted + prefix-matched, ANDed; bm25 weights title 10, tags 4, body 1, other fields 0.5. Snippet markers are \u0001/\u0002 so the UI can escape first, then highlight.
- The index remembers which vault it belongs to; opening another vault clears it and re-syncs (one `brain.db` per install is enough).
- File watcher: `notify-debouncer-mini`, 400ms. It ignores dot-folders except `.brain/lobes.json`; own writes cause a harmless no-op sync (mtime+size unchanged).
- Commands are `async` so a big sync/rebuild never blocks the UI thread; every write emits `vault-changed`.
- A vault that can't be opened doesn't crash the app: the error is shown in the empty state with "Open another folder".
- Settings: secrets are sent to the UI as a `__saved__` marker and only replaced if the user types a new value.
- `load_graph`/`graph.json` removed; `get_graph` returns `{ nodes, links, lobes }`.

## Milestone 3: editor + links
- Editor = CodeMirror 6 with the markdown language, no line numbers, line wrapping, styled only from theme.css variables. The editor holds the body; frontmatter is edited in the Properties pane, never as raw YAML.
- Autosave 500ms after the last keystroke, serialised through one promise chain so saves never overlap. An external change (watcher reload) replaces the editor text only when there's no unsaved typing.
- `[[` autocomplete inserts `[[Title]]`, or `[[file name|Title]]` when the file name had to drop characters, so the link also resolves in Obsidian.
- Ctrl/Cmd+click (or Ctrl Enter) on a link follows it; following a link to a missing item creates that note, like Obsidian.
- Title is an input above the editor; the rename is committed on Enter/blur (not per keystroke), because it renames the file and rewrites links everywhere.
- Reading/edit mode is remembered as the default for newly opened tabs.
- Properties pane edits type, lobe, tags (chips + existing-tag suggestions) and type fields; list fields (stack, languages, topics, used_in) are comma-separated. A pane doesn't re-render while one of its inputs has focus.
- Backlinks show the line that contains the link, like Obsidian's backlinks pane.
- Inbox is its own left-sidebar view (untagged items, newest first) with a count badge; the Tags view lists only real tags.
- Delete is a two-step button (trash, then "Confirm" for 3s) instead of a modal; files go to `.trash/`.
- Sample skill levels lowercased to match the data model (beginner|intermediate|advanced).
- Vite chunk-size warning raised to 3 MB: the single bundle loads from disk inside the desktop app.

## Milestone 4: palettes
- One palette component (`palette/palette.js`) drives both Ctrl K search and Ctrl P commands.
- Search goes through `api.search` (FTS5 bm25 in Rust); an empty query lists recently updated items. The body snippet with highlighted matches replaces the tag line when the match is in the body.
- Semantic blending is a pluggable hook (`setSemanticSearch`) + `lib/rank.js#blend`: keyword scores normalised to the best hit, weighted 0.55 keyword / 0.45 semantic; semantic-only hits need ≥ 0.35 similarity.
- Commands: a registry (`registerCommand`) with optional `when` (hide) and `disabled` (shown greyed with a reason). Subsequence fuzzy match with word-start bonus; recently used commands float up.
- Frontend unit tests: `npm test` runs `node --test` on the DOM-free modules (wikilinks, ranking, lobe layout, mock backend). The mock waits for its seed on every call (a test caught search racing the seed).

## Milestone 5: quick capture
- The capture window is created on first use (not at startup) from `capture.html`, a second Vite page: 480×120, undecorated, always on top, skip taskbar. Enter saves, Esc hides it (hidden, not destroyed, so it reopens instantly).
- Global shortcut from `settings.shortcuts.capture` (default Ctrl+Shift+Space); failure to register is logged, not fatal. `tauri-plugin-single-instance` forwards `brain --capture` from a second process, which is the Wayland route.
- Text that isn't a URL is saved as a note (first line = title) and lands in the Inbox; it's quicker than rejecting it.
- Capturing a URL that's already saved doesn't create a duplicate ("Already saved").
- The link item is written immediately with `status: pending` and a host/path placeholder title; the pipeline then runs in the background (`tauri::async_runtime::spawn`). The fetched title replaces the placeholder only if the user hasn't renamed it meanwhile. On failure the item keeps its URL/title with `status: failed` and `error:`, and the sidebar has a refetch button.
- Fetch: reqwest (rustls, 20s timeout, 4 MB cap, HTML/text only). Extraction: `scraper`; title from og:title → <title> → <h1>; text from article → main → body, skipping nav/header/footer/aside/script/form and short fragments.
- Summary without AI = the page's meta description, else its first two sentences. `enrich.rs` is the hook for AI summary, embedding and suggestions (milestones 6 and 8).
- The fetched page text is not written into the vault (the body stays the user's); it's only used for the summary and the embedding.
- In the browser preview the capture page has its own in-memory mock, and "fetching" is simulated.

## Milestone 6: settings + AI layer
- `ai.rs`: one OpenAI-compatible client (reqwest, shared, 120s timeout / 5s connect) for chat and embeddings; works for llama.cpp's `llama-server`, Groq and any compatible server. Error messages carry the provider's message, never the request. `<think>` blocks from local reasoning models are stripped.
- Provider presets in Settings: llama.cpp (http://127.0.0.1:8080/v1), Groq (https://api.groq.com/openai/v1, default model llama-3.1-8b-instant), custom. Embeddings point at a second local server (suggested :8081) started with `--embedding`.
- Embedding text = title, tags, summary-like fields, list fields, body (4000 chars). An FNV-1a hash of that text is stored with the vector so unchanged items are never re-embedded.
- Vectors are normalised on write, kept as little-endian f32 blobs keyed by model name; they survive "Rebuild index" (no FK; pruned after sync) but are dropped when switching vaults.
- Embedding runs in a background worker: saves are debounced 1.2s, then batches of 16; progress/errors go to the status bar (`embed-status`). An unreachable server stops the run and shows "Embeddings unavailable" with the reason; nothing else breaks.
- Backfill (embed everything missing/stale) runs at startup, after imports, rebuilds, renames, outside edits and embedding-settings changes.
- Similar links: brute-force cosine neighbours (8 candidates per item, cached until vectors change), then per item the top_k (default 3) with similarity ≥ min_score (default 0.55), skipping pairs already linked by a wikilink. Without embeddings the graph keeps using shared-tag similarity.
- Semantic search embeds the query and blends into Ctrl K via the milestone-4 hook.
- Settings save on change (Obsidian-style); lobes are edited as a batch with an explicit "Save lobes" (renaming several at once shouldn't write the file per keystroke). New lobe ids are slugs of the name.
- Theme lives in settings.json; a copy in localStorage only avoids a flash of the wrong theme on start.
- Changing the capture shortcut re-registers it immediately.
- Integration test uses Tauri's mock runtime and a loopback fake embedding server; embed functions are generic over `Runtime` for that.
