# Things that need Pavvy

These couldn't be done or fully checked from the cloud build.

## Try it
- `npm install && npm run tauri dev` on Fedora. First start creates `~/Brain`; use "Import sample data" to get the
  sample brain as real files, or "Open another folder" to point it at an existing (Obsidian) folder.
- Check the look on a real GNOME/Wayland session with a GPU (the cloud screenshots use software rendering).

## Quick capture on Wayland
- Global shortcuts usually don't reach apps on GNOME Wayland. Bind a custom shortcut:
  Settings → Keyboard → View and Customize Shortcuts → Custom Shortcuts → "+", command `brain --capture`
  (installed from the rpm it's `/usr/bin/brain`; during `tauri dev` use `src-tauri/target/debug/brain --capture`),
  shortcut Ctrl+Shift+Space.
- Capture a few real URLs: the fetch pipeline is tested on fixed HTML only; the cloud sandbox couldn't reach the web.

## AI (optional)
- Chat: Settings → AI provider. Groq: paste an API key. llama.cpp: `llama-server -m <chat-model>.gguf --port 8080`.
  Press "Test connection".
- Embeddings: `llama-server -m nomic-embed-text-v1.5.Q8_0.gguf --embedding --port 8081`, set the URL in Settings,
  then "Embed everything now". If suggested links look too many/few, tune "Minimum similarity" (model-dependent).
- Try Polish / Summarize / Fill form (right-click), tag suggestions on Inbox items, and Ask. All were tested against
  fake servers only.

## GitHub
- Create a fine-grained token (github.com → Settings → Developer settings → Fine-grained tokens), repository access
  "All repositories" (or pick), permissions Contents: read and Metadata: read. Paste it in Settings → GitHub,
  "Test token", then "Sync now".

## Watch out for
- The file watcher was tested in the cloud (outside edits show up); check it with Obsidian open on the same vault.
- Placeholder repo URLs/dates in the sample data (`github.com/…/hackemon` etc.) are made up; fix or delete them after
  importing the sample.
