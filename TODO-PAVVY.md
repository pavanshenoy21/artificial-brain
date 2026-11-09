# Things that need Pavvy

These couldn't be done or fully checked from the cloud build (no Hyprland, no real GPU there).

## Try it on Fedora + Hyprland
- Build and install the rpm (README → Install on Fedora), run `brain`.
- Point it at your Obsidian vault: Ctrl P → "Open another vault folder". Your top-level folders become
  lobes; check that the colours make sense and pick your own (right-click a folder → Colour).
- Check the window on Hyprland: no GTK title bar, dragging by the empty tab-bar area when floating, and
  the class name for window rules (`hyprctl clients`, look for "Artificial Brain").
- Add the keybind from the README (`bind = SUPER, B, exec, brain`).

## Git backup on close
- In a terminal, once: `cd` into the vault, add the GitHub remote, make the first push (README → Git backup).
- Check `git push` works without any prompt (SSH key in an agent or no passphrase, or a credential helper).
  Then open the app, edit something, close it, and look at the repo on GitHub. Settings → Backup (git)
  shows the last result.
- On a second device: `git clone` the repo, point the app at it, and `git pull` before writing there.

## Watch out for
- The file watcher was tested in the cloud (outside edits show up); check it with Obsidian open on the same vault.
- Renames and moves rewrite links in other files. Try one on a copy of your vault first if you're nervous.
- If the graph flickers or goes black, see "Black, flickering or frozen window" in the README.

## Removed for now (to re-design together)
- Typed items (skills, hackathons, projects, links) and their forms, quick capture, AI (polish, summaries,
  Ask, embeddings), GitHub sync, flashcards, the Tasks pane. They're in the git history
  (before commit "Rebuild as an Obsidian copy with folder lobes") if any of it should come back.
