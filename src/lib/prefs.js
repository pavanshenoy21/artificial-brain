// Per-install UI preferences (sidebar widths, open tabs, view mode, theme).
// localStorage can throw (private mode, blocked storage); never let that break the app.
const KEY = "brain.prefs";
let cache;
function all() {
  if (!cache) {
    try { cache = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { cache = {}; }
  }
  return cache;
}
export const prefs = {
  get: (k, dflt) => (k in all() ? all()[k] : dflt),
  set(k, v) {
    all()[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch {}
  },
};
