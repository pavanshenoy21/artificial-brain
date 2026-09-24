import { defineConfig } from "vite";

// Tauri expects a fixed dev port and must not clear the terminal.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  // One bundle is fine: it loads from disk inside the desktop app (three.js + CodeMirror ≈ 2 MB).
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 3000,
    // two pages: the main window and the quick-capture window
    rolldownOptions: { input: { main: "index.html", capture: "capture.html" } },
  },
});
