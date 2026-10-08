// Bottom status bar: vault · counts · (per-tab info) · AI status · last sync.
import { app } from "../state.js";
import { esc, setHtml } from "../util.js";

const el = document.getElementById("status");
const slots = { vault: "", counts: "", tab: "", review: "", embed: "", github: "", ai: "AI off", sync: "" };
const titles = { ai: "No AI provider configured" };

function render() {
  setHtml(el, ["vault", "counts", "tab"].map(k => slots[k] ? `<span class="st st-${k}" title="${esc(titles[k] || "")}">${esc(slots[k])}</span>` : "").join("")
    + `<span class="st-fill"></span>`
    + (slots.review ? `<button type="button" class="st st-review" title="${esc(titles.review || "")}">${esc(slots.review)}</button>` : "")
    + ["embed", "github", "ai", "sync"].map(k => slots[k] ? `<span class="st st-${k}" title="${esc(titles[k] || "")}">${esc(slots[k])}</span>` : "").join(""));
}
el.addEventListener("click", e => { if (e.target.closest(".st-review")) app.emit("open-review"); });

export const status = {
  set(slot, text, title) {
    slots[slot] = text;
    if (title !== undefined) titles[slot] = title;
    render();
  },
};

app.on("data", () => {
  const explicit = app.links.filter(l => l.kind === "explicit").length;
  status.set("counts", `${app.items.size} items · ${explicit} links`);
  status.set("sync", `loaded ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
});
render();
