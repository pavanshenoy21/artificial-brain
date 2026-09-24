# Artificial Brain: graph view MVP

A cross-platform desktop app (Linux, Windows, macOS) built with **Tauri v2**: a Rust shell around a web UI. The UI uses **three.js** through **3d-force-graph**.

This MVP is the graph view only, running on sample data. It includes:

- **Lobes.** Nodes cluster by area (Security & CTF, Web & Apps, AI & ML, CP, Linux, College). Each lobe has a soft halo and a floating name.
- **Colour = lobe, shape = type.** Sphere = note, diamond = saved link, pyramid = skill, gem = hackathon, cube = project.
- **Two kinds of links.** Solid = links you make yourself. Faint = "similar" (shared tags for now, embeddings later). Toggle the similar ones from the top bar.
- **Focus mode.** Click a node. It and its neighbours light up, the second ring dims, everything else fades out. Particles run along your links.
- **Semantic zoom.** Zoomed out you see only the lobe names. Zoom in and node labels appear.
- **Search (Ctrl K or /).** Pick a result and the camera flies to the node, the node pulses, and a card travels along a glowing arc into the detail panel.
- **Filters.** Click a type in the legend to hide or show it. Click a lobe to fly to it.
- **Idle orbit.** The brain slowly rotates when you leave it alone.

## Run it on Fedora

One-time setup:

```bash
# system libraries Tauri needs
sudo dnf check-update
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel libxdo-devel
sudo dnf group install "c-development"

# Rust + Node (skip what you already have)
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
sudo dnf install nodejs
```

Then:

```bash
npm install
npm run tauri dev      # opens the desktop window (first build takes a few minutes)
```

Build an installable package (`.rpm`, `.deb` and an AppImage end up in `src-tauri/target/release/bundle/`):

```bash
npm run tauri build
```

To work on only the UI in a browser tab (faster reloads, no Rust needed), run `npm run dev` and open http://localhost:1420.

## Using your own data

On start, the app asks the Rust side for `graph.json` in the app data folder:

- Linux: `~/.local/share/dev.pavvy.brain/graph.json`
- Windows: `%APPDATA%\dev.pavvy.brain\graph.json`
- macOS: `~/Library/Application Support/dev.pavvy.brain/graph.json`

If that file doesn't exist, it uses the sample data. The format is the same as `src/data/sample.js`:

```json
{
  "nodes": [
    { "id": "n1", "type": "note", "lobe": "sec", "title": "…", "tags": ["ctf"], "body": "…" },
    { "id": "n2", "type": "link", "lobe": "sec", "title": "…", "tags": [], "url": "https://…", "summary": "…" }
  ],
  "links": [{ "source": "n1", "target": "n2", "kind": "explicit" }]
}
```

- Node types: `note`, `link`, `skill`, `hackathon`, `project`.
- Lobe ids: `sec`, `web`, `ai`, `cp`, `sys`, `col`. Lobes are defined in `src/data/sample.js`.

## Code map

```
src/
  main.js        graph setup, forces, lobes, focus mode, semantic zoom, orbit, wiring
  search.js      command palette + keyword scoring
  travel.js      the node → panel travel animation
  panel.js       detail panel per node type
  shapes.js      3D geometry + 2D icon per type
  data/sample.js sample brain + similarity links
src-tauri/
  src/lib.rs     Rust commands (load_graph)
```

## Next steps

1. Storage: markdown files + SQLite in the app data dir. Rust commands for create, update and delete.
2. Quick-capture window + global shortcut (`tauri-plugin-global-shortcut`).
3. Embeddings (llama.cpp) → real similarity links + UMAP starting positions.
4. GitHub sync with a fine-grained, read-only token.
5. Right-click AI actions: Polish, Summarize, Fill form (local llama.cpp or Groq).
