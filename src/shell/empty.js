// First-run / error state shown over the graph pane when the vault is empty
// (or couldn't be opened). Plain text and buttons, nothing else.

import { app } from "../state.js";
import { isDesktop } from "../api.js";
import { newItem, importSample, openVaultFolder } from "../actions.js";
import { esc } from "../util.js";

export function initEmptyState(pane, getInfo) {
  const el = document.createElement("div");
  el.className = "empty-state";
  el.hidden = true;
  pane.appendChild(el);

  function render() {
    const info = getInfo();
    const empty = app.loaded && app.items.size === 0;
    el.hidden = !(empty || info?.error);
    pane.classList.toggle("is-empty", !el.hidden);
    if (el.hidden) return;
    el.innerHTML = info?.error
      ? `<p class="empty-title">The vault couldn't be opened.</p>
         <p class="muted">${esc(info.error)}</p>
         <div class="empty-actions">${isDesktop ? `<button type="button" class="btn" data-act="open">Open another folder</button>` : ""}</div>`
      : `<p class="empty-title">This vault is empty.</p>
         <p class="muted">${esc(info?.path || "")}</p>
         <div class="empty-actions">
           <button type="button" class="btn primary" data-act="new">New note</button>
           <button type="button" class="btn" data-act="sample">Import sample data</button>
           ${isDesktop ? `<button type="button" class="btn" data-act="open">Open another folder</button>` : ""}
         </div>
         <p class="faint">Or drop markdown files into the folder; they show up here.</p>`;
  }

  el.addEventListener("click", e => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "new") newItem("note");
    if (act === "sample") importSample();
    if (act === "open") openVaultFolder();
  });
  app.on("data", render);
  return { render };
}
