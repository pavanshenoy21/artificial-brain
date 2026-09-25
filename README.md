# Artificial Brain

A personal knowledge base for the desktop: an Obsidian-style workspace (markdown files, wikilinks,
backlinks, tabs, command palette) with a 3D/2D graph of everything you know, typed items (links,
skills, hackathons, projects), quick capture from anywhere, and an optional AI that stays out of the
way until you ask.

Built with Tauri v2 (Rust) + Vite + vanilla JS + three.js (3d-force-graph) + CodeMirror 6.
Main target: Fedora (GNOME, Wayland). Works on other Linux distros, macOS and Windows.

## Features

- **Plain files.** A vault folder of markdown files with YAML frontmatter (`~/Brain` by default).
  Obsidian can open the same folder. SQLite is only a search index and can be rebuilt any time.
  Edits made outside the app (Obsidian, git, an editor) are picked up by a file watcher.
- **Workspace.** Ribbon, collapsible and resizable sidebars, tabs, status bar. Dark and light themes.
- **Graph.** Lobes (colour) and types (shape), focus mode (a node plus 1–2 hops, the rest fades),
  semantic zoom (lobe names from far away, labels up close), type filters, fly to lobe, 2D/3D switch.
  Solid lines are your `[[wikilinks]]`; faint dashed lines are suggestions.
- **Editor.** CodeMirror markdown editor with autosave, reading view, `[[` autocomplete,
  Ctrl+click to follow a link (a missing target is created), renames that rewrite links everywhere.
- **Sidebars.** Files by type, tags, Inbox (untagged items), graph filters; properties (forms per
  type), outgoing links, backlinks with context, suggested items, and Ask.
- **Typed items.** Skills (level, since, used in), hackathons (date, role, team, built, stack, …),
  projects (status, role, stack + GitHub fields), links (url, site, summary).
- **Quick capture.** A small window (Ctrl Shift Space, or `brain --capture`): paste a URL and press
  Enter. The page is fetched, titled and summarised in the background. Other text becomes a note.
- **GitHub sync.** A read-only token turns your repos into project items (description, languages,
  topics, stars, README). Your own fields and notes are never overwritten.
- **AI (optional).** Any OpenAI-compatible server: a local llama.cpp server or Groq.
  - Right-click Polish, Summarize, Fill form from messy text. You always see a diff first; the
    original is kept in `.brain/history/`. Prompts forbid adding facts.
  - Tag and lobe suggestions, chosen only from what already exists (Ctrl Enter accepts).
  - Embeddings (local llama.cpp) for suggested links and search that understands meaning.
  - Ask: questions answered from your notes with `[[citations]]`; cited notes light up in the graph.
  - Without AI everything else works; the status bar says "AI off".

## Setup (Fedora)

```sh
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel
sudo dnf group install "c-development"
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
sudo dnf install nodejs                                          # Node 20+

npm install
npm run tauri dev          # run the app
npm run tauri build        # build packages (rpm, deb, AppImage) into src-tauri/target/release/bundle/
```

On Ubuntu/Debian the build deps are `libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev
librsvg2-dev libxdo-dev build-essential`.

`npm run dev` runs the UI alone in a browser (port 1420) against an in-memory copy of the sample
data; add `?empty` to the URL to see the first-run screen.

## Quick capture on GNOME Wayland

Global shortcuts usually can't be grabbed by apps on Wayland. Bind a GNOME shortcut instead:
Settings → Keyboard → View and Customize Shortcuts → Custom Shortcuts → **+**, command
`brain --capture`, shortcut Ctrl+Shift+Space. The running app opens its capture window (a second
`brain` process just hands the request over).

## GPU crashes / black or frozen graph (Linux)

The graph is WebGL, drawn through your GPU driver. If you see `MESA: error: ZINK: vkQueueSubmit failed
(VK_ERROR_DEVICE_LOST)` or the graph goes black, the driver reset. The app keeps working and shows a Reload
button in the graph. Common fixes on Fedora:

- NVIDIA card on the open nouveau/NVK driver (that's when Mesa uses Zink): install the proprietary driver
  (`sudo dnf install akmod-nvidia` from RPM Fusion, reboot).
- Try the other WebKit renderer: `WEBKIT_DISABLE_DMABUF_RENDERER=0 npm run tauri dev`
  (the app turns DMA-BUF off by default because it flickers on many setups).
- Skip Zink and use Mesa's software OpenGL (always works, slower with big vaults):
  `LIBGL_ALWAYS_SOFTWARE=1 npm run tauri dev`.

## AI setup (optional)

Settings → AI provider:

- **llama.cpp:** `llama-server -m model.gguf --port 8080`, provider "llama.cpp", URL `http://127.0.0.1:8080/v1`.
- **Groq:** provider "Groq", paste an API key. The model defaults to `llama-3.1-8b-instant`.

Settings → Embeddings (Groq has none; use a local server):
`llama-server -m nomic-embed-text-v1.5.Q8_0.gguf --embedding --port 8081`, URL
`http://127.0.0.1:8081/v1`, then "Embed everything now". Without embeddings, suggested links come
from shared tags.

Settings are stored in `~/.config/dev.pavvy.brain/settings.json` with 0600 permissions.

## GitHub

Create a fine-grained token (GitHub → Settings → Developer settings → Fine-grained tokens) with
read access to Contents and Metadata, paste it in Settings → GitHub, then "Sync now". With
"Sync on startup" the app syncs again when the last sync is over a day old.

## Keyboard

| Keys | Action |
| --- | --- |
| Ctrl K or / | Search |
| Ctrl P | Commands |
| Ctrl N | New note |
| Ctrl G | Graph |
| Ctrl E | Edit / reading view |
| Ctrl W | Close tab |
| Ctrl Tab | Next tab |
| Ctrl Shift Space | Quick capture (see the Wayland note) |
| Ctrl Enter | Accept AI suggestions / accept a diff |
| V | 2D / 3D (graph) |
| Enter / double-click | Open the selected node in a tab |
| Esc | Clear focus, close a palette or dialog |

## Vault format

```
~/Brain/
  notes/ links/ skills/ hackathons/ projects/   one markdown file per item, named after its title
  .brain/lobes.json                             lobes (id, name, colour), editable in Settings
  .brain/history/                               originals kept by AI actions
  .trash/                                       deleted items (never hard-deleted)
```

```markdown
---
id: 01K5X3M2J8R6Z1Q0V7C4T9N2WB
type: skill
title: Rust
lobe: sys
tags: [rust, systems]
level: beginner
used_in: ["[[Artificial Brain]]"]
created: 2026-09-24T10:00:00+05:30
updated: 2026-09-24T10:00:00+05:30
---
Free markdown. [[Wikilinks]] here and in frontmatter values become graph links.
```

Files without frontmatter work too: the folder gives the type and the file name gives the title.

## Development

```
src/                     frontend (vanilla JS modules)
  main.js state.js api.js actions.js core-commands.js
  shell/ graph/ sidebar/ editor/ palette/ forms/ ai/ settings/ lib/ mock/
  theme.css app.css capture.html → capture.js
src-tauri/src/           Rust backend
  vault.rs index.rs store.rs markdown.rs watch.rs settings.rs commands.rs
  capture.rs enrich.rs ai.rs embed.rs assist.rs ask.rs github.rs
```

- All frontend↔backend calls go through `src/api.js`; outside Tauri it uses `src/mock/backend.js`.
- Tests: `npm test` (frontend, node --test) and `cd src-tauri && cargo test` (Rust, including
  mock-runtime tests against loopback fake AI/GitHub servers; no internet).
- `cargo clippy --all-targets` is clean.
- `scripts/desktop-smoke.sh` runs the real release build under Xvfb and takes screenshots.
- Design and implementation choices are logged in `DECISIONS.md`.
