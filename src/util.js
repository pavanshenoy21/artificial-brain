export const esc = s =>
  String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const v = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return `${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`;
}

export const idOf = x => (x && typeof x === "object" ? x.id : x);

export const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Open external links in the system browser inside Tauri, new tab in a plain browser.
export async function openExternal(url) {
  if (window.__TAURI_INTERNALS__) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      return await openUrl(url);
    } catch (e) {
      console.warn("opener failed", e);
    }
  }
  window.open(url, "_blank", "noopener");
}

// Replace an element's HTML only when it actually changed. Sidebars re-render
// on every data reload (each autosave); swapping identical HTML makes them
// flicker, lose hover and reset scroll.
export function setHtml(el, html, force = false) {
  if (!force && el.__html === html) return false;
  el.innerHTML = html;
  el.__html = html;
  return true;
}
