// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer flickers, tears or renders blank on many
    // Fedora/Wayland setups (NVIDIA especially). Turn it off unless the user
    // chose otherwise (`WEBKIT_DISABLE_DMABUF_RENDERER=0 brain` re-enables it).
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    brain_lib::run()
}
