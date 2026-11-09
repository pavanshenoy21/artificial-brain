# Artificial Brain

A personal knowledge base that works like Obsidian (a folder of markdown notes, wikilinks, backlinks,
canvases, a command palette) with a 3D/2D graph where your folders are the brain's lobes.
Desktop app for **Fedora with Hyprland** (Tauri + WebKitGTK, Wayland native).

The vault is plain files. Obsidian can open the same folder, and the app never adds anything to a note
that you didn't type (no ids, no timestamps).

## How folders shape the graph

```
Coding Club/                      lobe: in the graph only its name, in the lobe's colour
Coding Club/CTF/                  folder: its own colour; every note inside gets it
Coding Club/CTF/CTFd setup.md     a note, drawn in the CTF colour
Coding Club/Hackathons/…          another colour, same lobe
```

Notes hang off their folder, and folders off the lobe's name, as a tree, so each lobe is one chunk in
3D with its folders as coloured sub-chunks. Plain grey lines are your `[[wikilinks]]`. Colours come from
two palettes (one for lobes, one for folders) or are picked per folder: right-click a folder → Colour, or
Settings → Lobes and folder colours. They're saved in the vault (`.brain/colors.json`).

## Features

- **File explorer:** folders and files like Obsidian's. New note / folder / canvas, rename (F2 or
  inline), drag files and folders into folders, "Move file to…", delete (to the vault's `.trash`),
  sort, collapse all. Renaming or moving updates every `[[link]]` and canvas card that pointed there.
- **Editor:** CodeMirror with autosave, reading view (Ctrl E), `[[` autocomplete, Ctrl+click to follow a
  link (a missing note is created), checkboxes you can tick in the reading view.
- **Properties:** frontmatter shown at the top of the note; edit, add and remove properties and tags.
- **Right sidebar:** Backlinks (with the line that links here) and unlinked mentions (one click turns a
  mention into a link), Outgoing links (including notes not created yet), Outline.
- **Canvas:** Obsidian `.canvas` files: text, note, image and link cards, groups, arrows, colours, undo.
  Same JSON as Obsidian.
- **Daily notes:** Ctrl Shift D opens `YYYY-MM-DD.md` (in the vault root, like Obsidian's default).
- **Search:** Ctrl K finds notes by name and text (SQLite full-text index, rebuilt from the files any time).
- **Graph:** 3D or 2D (V), focus mode (a note and its neighbours), click a lobe name or folder hub to
  light up everything in it, semantic zoom (lobe names far away, note names up close).
- **Git backup:** when the app closes it commits and pushes the vault (see below).

## Install on Fedora

```bash
# build tools and the libraries Tauri needs
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel libxdo-devel
sudo dnf group install c-development
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust, if you don't have it
sudo dnf install nodejs

# build and install the rpm
npm install
npm run tauri build
sudo dnf install ./src-tauri/target/release/bundle/rpm/*.rpm
```

Then run `brain` (or open "Artificial Brain" from your launcher). The first start creates `~/Brain`;
use "Import sample data" for an example vault, or "Open another folder" to point it at your Obsidian vault.
For development: `npm run tauri dev`.

## Hyprland

The window has no title bar (Hyprland draws the borders). If you float it, drag it by the empty part
of the tab bar. Useful lines for `~/.config/hypr/hyprland.conf`:

```ini
# open the brain
bind = SUPER, B, exec, brain

# optional: always on its own workspace (check the class with: hyprctl clients)
windowrulev2 = workspace 3, class:^(brain)$
```

Launching `brain` again just focuses the open window.

### Black, flickering or frozen window (GPU)

WebKitGTK's DMA-BUF renderer is turned off by default (`WEBKIT_DISABLE_DMABUF_RENDERER=1`), which fixes
most blank or flickering windows on Wayland. If the graph still misbehaves:

- NVIDIA: try `env = __NV_DISABLE_EXPLICIT_SYNC,1` in `hyprland.conf`, or start with
  `__NV_DISABLE_EXPLICIT_SYNC=1 brain`.
- Mesa "device lost" crashes: the graph stops and shows a Reload button; the rest of the app keeps
  working. `WEBKIT_DISABLE_COMPOSITING_MODE=1 brain` avoids GPU compositing completely.
- To compare, run once under XWayland: `GDK_BACKEND=x11 brain`.

## Keyboard

| Keys | Action |
| --- | --- |
| Ctrl K, Ctrl O or / | Search / open a note |
| Ctrl P | Command palette |
| Ctrl N | New note |
| Ctrl Shift D | Today's daily note |
| Ctrl G | Graph |
| Ctrl E | Edit / reading view |
| Ctrl W, Ctrl Tab | Close tab, next tab |
| F2 | Rename the current file (or the selected row in the explorer) |
| V | 2D / 3D (graph) |
| Enter / double-click | Open the selected node |
| Esc | Clear graph focus, close a palette or dialog |

In the explorer: arrows move, Right/Left open and close folders, Enter opens, F2 renames, Delete deletes.
On a canvas: double-click to add or edit, drag a side dot to connect, drag empty space to pan, Shift drag
to select, Ctrl scroll to zoom, Delete, Ctrl Z / Ctrl Shift Z, Ctrl D duplicate.

## Git backup

When you close the app it runs `git add -A`, `git commit` and `git push` in the vault folder, so your
notes end up on GitHub and you can `git clone` / `git pull` them on another device. Set the repository
up once in a terminal:

```
cd ~/Brain
git init -b main                                   # skip if it's already a repo
git remote add origin git@github.com:<you>/<repo>.git
git add -A && git commit -m "first commit" && git push -u origin main
```

Git must be able to push without asking anything: use an SSH key (`ssh -T git@github.com` should work
without a password prompt, so load the key in an agent or leave it without a passphrase) or a credential
helper for HTTPS. The app never waits for a prompt; it gives up after 90 seconds.

- Commits look like "Vault backup from <hostname>: 3 files changed". Nothing changed means no commit.
- If the push is rejected because the remote has commits you don't have (you backed up from another
  device), the commit stays local and the app tells you to run `git pull` in the vault. Pull before you
  start writing on a second device and this won't happen.
- A merge or rebase you left half-done is never touched.
- The last result is in Settings → Backup (git), with a "Back up now" button. A failed backup also shows
  "backup failed" in the status bar. The toggle there turns it off.
- `.trash/` is committed like everything else; add it to a `.gitignore` in the vault if you don't want that.

## Vault format

```
~/Brain/
  <any folders>/*.md        notes, named after their file
  <any folders>/*.canvas    canvases (JSON Canvas, same as Obsidian)
  .brain/colors.json        lobe and folder colours you picked
  .trash/                   deleted files and folders (never hard-deleted)
  .obsidian/                left alone if you also use Obsidian
```

The search index lives in `~/.local/share/dev.pavvy.brain/brain.db` and is only a cache ("Rebuild index"
in Ctrl P re-reads every file). Settings (vault folder, theme, git backup) are in `~/.config/dev.pavvy.brain/settings.json`.

## Development

```
src-tauri/src/   vault.rs (files, frontmatter) · markdown.rs · index.rs (SQLite + FTS5) · store.rs (CRUD,
                 renames, folders, link rewriting) · canvas.rs · watch.rs · settings.rs · gitsync.rs (backup on close) · commands.rs
src/             main.js · state.js · api.js (+ mock/backend.js) · actions.js · graph/ · sidebar/ (explorer,
                 menus, right) · editor/ · canvas/ · palette/ · settings/ · shell/ · lib/
```

- All frontend↔backend calls go through `src/api.js`; outside Tauri it uses `src/mock/backend.js`, so
  `npm run dev` (port 1420) works in a browser with the sample vault (`?empty` starts empty).
- Checks: `npm test` (unit), `npm run test:e2e` (Playwright, browser build), `cd src-tauri && cargo test &&
  cargo clippy --all-targets`.
- `scripts/desktop-smoke.sh` runs the real release build under Xvfb (see the script header).
- Design choices are logged in `DECISIONS.md`.
