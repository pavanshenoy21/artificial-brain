// Bottom status bar: vault · counts · (per-tab info) · last sync.
import { app } from "../state.js";
import { esc, setHtml } from "../util.js";

const el = document.getElementById("status");
const slots = { vault: "", counts: "", tab: "", backup: "", sync: "" };
const titles = {};

function render() {
  setHtml(el, ["vault", "counts", "tab"].map(k => slots[k] ? `<span class="st st-${k}" title="${esc(titles[k] || "")}">${esc(slots[k])}</span>` : "").join("")
    + `<span class="st-fill"></span>`
    + (slots.backup ? `<button type="button" class="st st-backup" title="${esc(titles.backup || "")}">${esc(slots.backup)}</button>` : "")
    + ["sync"].map(k => slots[k] ? `<span class="st st-${k}" title="${esc(titles[k] || "")}">${esc(slots[k])}</span>` : "").join(""));
}

el.addEventListener("click", e => { if (e.target.closest(".st-backup")) app.emit("open-settings"); });

export const status = {
  set(slot, text, title) {
    slots[slot] = text;
    if (title !== undefined) titles[slot] = title;
    render();
  },
};

app.on("data", () => {
  status.set("counts", `${app.items.size} files · ${app.links.length} links`);
  status.set("sync", `loaded ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
});
render();
