// Quick-capture window: paste a URL (or type a note), Enter saves, Esc closes.
import { api, isDesktop } from "./api.js";
import { icon } from "./icons.js";

const form = document.getElementById("capture");
const input = document.getElementById("text");
const status = document.getElementById("status");
const iconSlot = document.getElementById("icon");

const looksLikeUrl = s => /^(https?:\/\/)?[^\s/]+\.[^\s]{2,}$/i.test(s.trim());
function updateIcon() { iconSlot.innerHTML = icon(looksLikeUrl(input.value) || !input.value ? "link" : "file", { size: 18 }); }
updateIcon();

function say(text, kind = "") { status.textContent = text; status.className = kind; }

async function hide() {
  input.value = "";
  updateIcon();
  if (isDesktop) await api.hideCapture();
}

let busy = false;
form.addEventListener("submit", async e => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  busy = true;
  say("Saving");
  try {
    const r = await api.capture(text);
    say(r.existing ? "Already saved" : r.item.type === "link" ? "Saved, fetching the page" : "Saved to Inbox", "ok");
    setTimeout(() => { say(""); hide(); }, r.existing ? 900 : 500);
  } catch (err) {
    say(String(err), "error");
  } finally {
    busy = false;
  }
});
input.addEventListener("input", updateIcon);
window.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); say(""); hide(); } });

// shown again via the shortcut: start fresh
if (isDesktop) {
  import("@tauri-apps/api/event").then(({ listen }) => listen("capture-shown", () => { say(""); input.focus(); }));
}
window.addEventListener("focus", () => input.focus());
input.focus();
