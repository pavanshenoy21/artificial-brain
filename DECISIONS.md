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
