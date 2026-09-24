# Artificial Brain: context for Claude Code

Owner: Pavvy (Fedora, first-year RVCE student). Idea handed off from the Cowork session (Sept 2026).
Style in interactive sessions: casual, short back-and-forth. Ask before building big new pieces.

> **Overnight / cloud build mode.** When a session is asked to "build the project" from this file, don't
> stop to ask questions. Work through the milestones below in order. Make sensible calls and log each one
> in `DECISIONS.md` (one line: what you chose and why). Commit after each milestone. Every commit must
> build. If something needs Pavvy (tokens, local models, a real display), build it with a clean fallback
> and list it in `TODO-PAVVY.md`.

## Vision
A personal knowledge base that feels like **Obsidian on steroids**: the same calm, dense, keyboard-first
workspace (markdown files, wikilinks, backlinks, tabs, command palette), plus a 3D/2D graph "brain",
typed items (links, skills, hackathons, projects), and an AI that lives in the graph.
It's a cross-platform **desktop** app, not a website. Main target: Fedora (GNOME, Wayland).
It's separate from "Jarvis", Pavvy's local life-assistant project. Don't mix the two.

Item types:
- **note**: normal markdown notes.
- **link**: a saved URL. A quick-capture window takes a pasted URL and turns it into a node. On save, the
  page is fetched, summarised and embedded, so saved links don't turn into a bookmark graveyard.
- **skill**: a skill Pavvy has learnt, entered with a form. Starting a new project, he can see what he knows.
- **hackathon**: one he attended and what he built, entered with a form (date, role, built, stack, ...).
- **project**: synced from GitHub with a fine-grained, read-only personal access token.

## Design direction (important)
It must **not look AI-generated**. Think Obsidian or a good code editor: quiet, flat, dense, functional.
Keep it simple and solid-coloured for now. Pavvy will ask for visual changes later.

Do:
- Solid, flat colours. 1px borders. Small radius (4–6px). Obsidian-like density (13–14px UI text,
  tight padding). System font stack (`Inter` only if already present, else system-ui), monospace for code.
- One neutral dark theme (default) and a light theme, both from CSS variables in one `theme.css`.
  Suggested dark: bg `#1e1e1e`, sidebars `#181818`, raised `#252525`, border `#2e2e2e`, text `#dcddde`,
  muted `#999`, faint `#666`. One accent colour (a calm blue or violet, e.g. `#7c8cff`). No other decorative colour.
- Lobe colours are the only "colourful" part. Use them as plain solid fills in the graph and as small dots in lists.
- One icon set: Lucide SVGs (stroke 1.5, 16px), inlined. No emoji anywhere in the UI.
- Plain, short, lowercase-ish labels ("New note", "Save link", "Sync now"). No marketing copy, no
  exclamation marks, no "magic" wording. AI features look like normal features: no sparkle icons, no
  purple gradients, no "✨ AI".
- Motion: fast (120–200ms), ease-out, only where it explains something (panel open, fly-to-node).
  Respect `prefers-reduced-motion`.

Don't:
- No gradients, glassmorphism/backdrop-blur, glows, neon, bloom, vignettes, drop shadows (except
  one subtle shadow on popovers/menus), animated backgrounds, or particle effects.
- No big rounded "cards" floating over the graph. Panels are docked, like Obsidian's.
- No hero sections, splash screens, empty-state illustrations or onboarding carousels.

The current MVP UI (glass panels, glow sprites, additive halos, link particles, glowing travel arc,
vignette) **breaks these rules and must be restyled** in Milestone 1.

## Layout (Obsidian-style)
```
┌ribbon┬ left sidebar ──┬ workspace (tabs) ─────────────────┬ right sidebar ───┐
│ icons│ Files | Tags  │ [Graph] [Note A] [Note B]  +       │ Backlinks        │
│      │ Inbox | Types │                                    │ Outgoing links   │
│      │ (lobe dots)   │  graph view  OR  markdown editor   │ Suggested (AI)   │
│      │               │                                    │ Properties/form  │
│      │               │                                    │ Ask (agent chat) │
├──────┴───────────────┴────────────────────────────────────┴──────────────────┤
│ status bar: vault · words · backlinks · AI provider status · last sync       │
└──────────────────────────────────────────────────────────────────────────────┘
```
- The left and right sidebars can be collapsed and resized. Their state is remembered.
- The graph is a workspace tab (always available; Ctrl G focuses it). Notes open in tabs.
- Clicking a node in the graph focuses it (focus mode) and shows it in the right sidebar.
  Double-click or Enter opens it in a tab.

## Stack and decisions
- Tauri v2 (Rust) + Vite + vanilla JS (ES modules, no framework) + three.js via 3d-force-graph
  (+ three-spritetext).
- Editor: CodeMirror 6 (markdown mode). It has a "Reading" view rendered with markdown-it; Ctrl E toggles.
  `[[` autocompletes titles, Ctrl+click follows a wikilink, autosave after a 500ms debounce.
- **Files are the source of truth.** A vault folder of plain markdown with YAML frontmatter, which
  Obsidian can open. SQLite (rusqlite, bundled, FTS5) is only an index/cache and can be rebuilt from the
  files at any time ("Rebuild index" command). A file watcher (`notify`) picks up edits made outside the app.
- Tagging: the AI *suggests* 2–3 tags, chosen only from tags that already exist. The user accepts them
  with one key (Ctrl Enter accepts all). Untagged items go to the **Inbox**. No automatic folders.
- Links: explicit `[[wikilinks]]` are solid lines. Embedding-similarity links are faint dashed "suggested"
  lines, and they are never written into files unless the user accepts one (which inserts a wikilink).
- Graph readability: lobes (colour = lobe, shape = type), focus mode (the node plus 1–2 hops, the rest
  fades), semantic zoom (lobe names from far away, node labels up close), type filters, and a **2D/3D
  switch** (already built: V key or the top-bar toggle; 2D flattens the same scene and locks the camera
  top-down). Later: UMAP of embeddings for starting positions.
- Search = palette (Ctrl K or /). Commands = palette (Ctrl P). The selected result flies from its spot in
  the graph to where it opens. Keep that animation short, plain (a flat card, no glow) and skippable.
- Right-click AI actions (on demand; show a diff; keep the original; never add facts): Polish, Summarize,
  Fill form from messy text. The provider is configurable: a local llama.cpp server or Groq (both use
  OpenAI-compatible APIs). Groq has no embeddings, so embeddings come only from the local llama.cpp server.
  If that isn't available, fall back to shared-tag similarity.

## Data model
Vault: default `~/Brain` (can be changed in Settings, picked with the dialog plugin).
```
~/Brain/
  notes/        *.md
  links/        *.md
  skills/       *.md
  hackathons/   *.md
  projects/     *.md
  .brain/       lobes.json, history/ (originals kept by AI actions), attachments later
```
These are fixed per-type folders, not organisation. Users never sort into folders; tags and lobes do that.
- File name = slugified title. The stable identity is `id:` (a ULID) in the frontmatter, so renames are safe.
  Wikilinks resolve by title or file name, like Obsidian (`[[Title]]`, `[[Title|alias]]`).
  Renaming a note updates the wikilinks that point to it.
- Common frontmatter: `id, type, title, lobe, tags, created, updated`.
  - link: `url, site, summary, fetched, status (ok|failed|pending)`
  - skill: `level (beginner|intermediate|advanced), since, used_in: [[project]]`
  - hackathon: `date, location, role, team, built, stack, result, repo`
  - project: `repo, description, languages, topics, stars, pushed_at, status, role` (fields from GitHub
    are overwritten on sync; `status`, `role` and the body never are)
- Lobes live in `.brain/lobes.json` (`id, name, color`), and are editable in Settings. Seed them with the six
  from `src/data/sample.js`. The app computes lobe centres (evenly spread) instead of taking hand-written
  coordinates. An item with no `lobe` goes into a grey "Unsorted" lobe. The AI can suggest a lobe the same way it suggests tags.
- SQLite in the app data dir: `items`, `tags`, `links (src, dst, kind)`, `items_fts`, `embeddings (item_id, model, dim, vector BLOB)`.
  Brute-force cosine is fine at personal scale.
- Settings: `settings.json` in the app config dir (vault path, theme, AI provider base URL/model/key,
  embedding URL/model, GitHub token, shortcuts). The file holding secrets gets 0600 permissions. Never log secrets.

## Architecture rules
- All frontend↔backend calls go through `src/api.js`. When `window.__TAURI_INTERNALS__` is missing, it
  uses an in-memory **mock backend** seeded from `src/data/sample.js`. That way `npm run dev` works in a
  plain browser, which is needed for screenshots/Playwright in the cloud where there is no display.
- Rust: split `src-tauri/src/` into modules (`vault.rs`, `index.rs`, `watch.rs`, `ai.rs`, `embed.rs`,
  `capture.rs`, `github.rs`, `settings.rs`, `commands.rs`). Commands return `Result<T, String>`.
  Slow work (fetching, LLM calls, embedding, sync) runs async and reports progress with events.
- Frontend: small modules (`shell/`, `graph/`, `editor/`, `palette/`, `sidebar/`, `forms/`, `ai/`).
  Split the current `src/main.js` along these lines. Keep the existing graph behaviour working.
- Unit tests for Rust: frontmatter parse/write round-trip, wikilink parsing and resolution, rename
  rewriting, index rebuild, FTS search, cosine ranking. Tests must not use the network.

## Milestones (work in this order; commit after each)
1. **Shell + restyle.** `api.js` + mock backend. Obsidian layout (ribbon, sidebars, tabs, status bar).
   `theme.css` with dark/light tokens. Restyle the graph flat: `MeshLambertMaterial`/`MeshBasicMaterial` in
   solid lobe colours; remove glow sprites, additive halos, particles and the vignette; lobes shown by colour
   and a plain name label; lines plain (solid for wikilinks, faint dashed for similar); idle orbit off by
   default. Keep focus mode, semantic zoom, filters, fly-to-lobe, search travel (flattened) and 2D/3D.
2. **Vault + index.** Vault create/open, CRUD commands, SQLite index + FTS, watcher, rebuild index.
   Replace the sample data. Add a first-run empty state: plain text with "New note" and "Import sample data"
   (the import writes the sample brain as real files). Remove `graph.json`/`load_graph`.
3. **Editor + links.** CodeMirror editor in tabs, reading view, wikilink autocomplete/follow, backlinks and
   outgoing panes, properties pane, tags pane, Inbox, rename with link rewriting.
4. **Palettes.** Ctrl K search (FTS bm25; blended with embeddings once they exist), Ctrl P commands
   (new note/link/skill/hackathon, toggle 2D/3D, toggle theme, sync GitHub, rebuild index, settings).
5. **Quick capture.** A small undecorated, always-on-top `capture` window (about 480×120): paste a URL,
   Enter saves, Esc closes. Global shortcut Ctrl Shift Space (tauri-plugin-global-shortcut). **Wayland
   fallback:** global shortcuts often don't work on GNOME Wayland, so also support `brain --capture`
   through tauri-plugin-single-instance, and put "bind a GNOME custom shortcut to `brain --capture`" in
   `TODO-PAVVY.md`. Link pipeline in the background: fetch (reqwest, rustls) → title + main text →
   summary (if AI configured) → embed → suggest tags/lobe. The node shows its pending/failed state; a
   failure still keeps the URL and title.
6. **Settings + AI layer.** Settings view (vault, theme, lobes editor, AI provider, embeddings, GitHub
   token, test-connection buttons). An OpenAI-compatible client for chat + embeddings. Embed on save
   (debounced), similarity links (top-k above a threshold) and search blending. Everything degrades
   cleanly when no provider is set: the status bar says "AI off", and AI actions are disabled with a tooltip.
7. **Forms + GitHub sync.** Forms for skill / hackathon / project in the properties pane and in a "New ..."
   dialog. Fields write frontmatter; the body stays free markdown. GitHub sync: list repos
   (`/user/repos`), languages, topics, README → project files; "Sync now" + auto-sync on startup if the
   last sync is more than 24h old; never overwrite user fields or the body.
8. **AI actions + tag suggestions.** Right-click on a node / editor selection: Polish, Summarize, Fill form
   from messy text. Show a diff (jsdiff), Accept/Reject, save the original to `.brain/history/`. Prompts
   must forbid adding facts. Tag and lobe suggestions appear as chips; Ctrl Enter accepts.
9. **Ask (agent chat).** A right-sidebar pane. RAG: embed the question → top-k items + 1-hop neighbours
   (FTS fallback) → answer with `[[wikilink]]` citations. Clicking a citation opens it; the cited nodes
   light up in the graph via focus mode.
10. **Wrap-up.** README (setup, features, shortcuts, Wayland note), `npm run build` + `cargo clippy` clean,
    `npm run tauri build` if the environment allows, and final updates to `DECISIONS.md` / `TODO-PAVVY.md`.
    Update the "Current state" section below.

## Keyboard
Ctrl K search · Ctrl P commands · Ctrl N new note · Ctrl G graph · Ctrl E edit/reading · Ctrl W close tab ·
Ctrl Tab next tab · Ctrl Shift Space quick capture · Ctrl Enter accept suggestions · V 2D/3D (graph focused) ·
Esc clear focus / close palette.

## Cloud session notes
- No display: Tauri windows can't be opened. Verify with `npm run build`, `cargo check`, `cargo test`,
  `cargo clippy`, and browser mode (`npm run dev`, port 1420) + Playwright screenshots to check the look.
- On Ubuntu, install the Tauri deps first: `libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev
  librsvg2-dev libxdo-dev build-essential`.
- Don't commit secrets, `node_modules`, `dist` or `target`.

## Current state
- All 10 milestones are built (see git log, one commit per milestone). `README.md` has setup, features and
  shortcuts; `DECISIONS.md` logs every call made along the way; `TODO-PAVVY.md` lists what needs Pavvy.
- Rust (`src-tauri/src/`): `vault.rs` (files, frontmatter, lobes.json, trash, history), `index.rs` (SQLite: items,
  tags, links, items_fts, embeddings, meta), `store.rs` (sync, CRUD, rename rewriting, import, rebuild),
  `markdown.rs` (frontmatter + wikilinks), `settings.rs` (settings.json, 0600, secrets redacted for the UI),
  `watch.rs` (notify watcher), `capture.rs` (capture window, link fetch/extract pipeline), `enrich.rs` (post-save
  hooks), `ai.rs` (OpenAI-compatible client), `embed.rs` (vectors, worker, similar links, semantic search),
  `assist.rs` (Polish/Summarize/Fill form/suggestions), `ask.rs` (RAG answers), `github.rs` (repo sync),
  `commands.rs`, `state.rs`, `error.rs`, `tests_integration.rs` (mock runtime + loopback fake servers).
- Frontend (`src/`): `main.js` (bootstrap, keys), `state.js` (shared state + events), `api.js` (+ `mock/backend.js`),
  `actions.js`, `core-commands.js`, `shell/` (layout, tabs, statusbar, toast, empty state, menu), `graph/view.js`,
  `sidebar/` (left: files/tags/inbox/filters, right: item), `editor/` (item tab, CodeMirror, markdown-it),
  `palette/` (palette, search, commands), `forms/` (field controls, New … dialog), `ai/` (actions, review dialog,
  Ask pane), `settings/view.js`, `lib/` (types + forms, lobes, wikilinks, prefs, rank), `capture.html` + `capture.js`,
  `theme.css` + `app.css`.
- Run: `npm install && npm run tauri dev` (browser only: `npm run dev`, port 1420; `?empty` = empty mock vault).
- Checks: `npm test`, `npm run build`, `cd src-tauri && cargo test && cargo clippy --all-targets` (all clean).
- Cloud sessions CAN run the real desktop build headless: install `xvfb xdotool imagemagick dbus-x11`, then
  `npx tauri build --no-bundle && scripts/desktop-smoke.sh <out-dir>` (screenshots of the real window).
