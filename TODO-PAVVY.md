# Things that need Pavvy

- Run `npm install && npm run tauri dev` on Fedora and check the real window (the cloud build can only test in a browser).
- The default vault is now `~/Brain` (created on first start). Change it with "Open another folder" or in Settings.
- Check that editing a file in another editor while the app runs updates the graph (the file watcher can't be exercised in the cloud).
- Quick capture on GNOME Wayland: global shortcuts usually don't reach apps there. Bind a custom shortcut instead:
  Settings → Keyboard → View and Customize Shortcuts → Custom Shortcuts → "+", command `brain --capture`
  (or the full path to the built binary, e.g. `/usr/bin/artificial-brain --capture`), shortcut Ctrl+Shift+Space.
- Try capturing a few real URLs: the fetch pipeline is unit-tested on fixed HTML only (no network in the cloud tests).
