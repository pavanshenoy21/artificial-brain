// "New skill / hackathon / project / link" dialog: title, lobe, tags and the
// type's form fields. A link goes through quick capture (fetch + summary).

import { app } from "../state.js";
import { allTags } from "../lib/tags.js";
import { api } from "../api.js";
import { FORMS, TYPE } from "../lib/types.js";
import { UNSORTED } from "../lib/lobes.js";
import { fieldControl, readValue, bindLinkInputs } from "./fields.js";
import { esc } from "../util.js";
import { toast } from "../shell/toast.js";
import { uniqueTitle } from "../actions.js";

let root;

export function openNewDialog(type, { prefill = {} } = {}) {
  root?.remove();
  root = document.createElement("div");
  root.className = "modal-backdrop";
  const lobes = [...app.lobes, app.lobe.get(UNSORTED.id)].filter(Boolean);
  const form = (FORMS[type] || []).filter(f => !f.readonly && !f.github);
  const isLink = type === "link";

  root.innerHTML = `
    <form class="dialog" role="dialog" aria-modal="true" aria-label="New ${esc(TYPE[type].one.toLowerCase())}">
      <div class="dialog-head">New ${esc(TYPE[type].one.toLowerCase())}</div>
      <div class="dialog-body props-form">
        ${isLink
          ? `<label class="prop"><span>URL</span><input data-f="url" type="url" required placeholder="https://…" spellcheck="false" value="${esc(prefill.url || "")}" /></label>
             <p class="set-desc">The page is fetched and summarised in the background.</p>`
          : `<label class="prop"><span>title</span><input data-f="title" required spellcheck="false" value="${esc(prefill.title || "")}" /></label>
             <label class="prop"><span>lobe</span><select data-f="lobe">${lobes.map(l => `<option value="${esc(l.id)}" ${l.id === (prefill.lobe || UNSORTED.id) ? "selected" : ""}>${esc(l.name)}</option>`).join("")}</select></label>
             <label class="prop"><span>tags</span><input data-f="tags" placeholder="comma-separated" spellcheck="false" list="dlg-tags" value="${esc((prefill.tags || []).join(", "))}" /></label>
             <datalist id="dlg-tags">${[...new Set([...app.items.values()].flatMap(allTags))].sort().map(t => `<option value="${esc(t)}"></option>`).join("")}</datalist>
             ${form.map(f => fieldControl(f, prefill[f.key])).join("")}`}
      </div>
      <div class="dialog-foot">
        <span class="dialog-error" role="alert"></span>
        <button type="button" class="btn" data-act="cancel">Cancel</button>
        <button type="submit" class="btn primary">Create</button>
      </div>
    </form>`;
  document.body.appendChild(root);
  const formEl = root.querySelector("form");
  const first = formEl.querySelector("input:not([type=hidden]), select");
  first?.focus();
  first?.select?.();

  // [[link]] chips re-render in place
  bindLinkInputs(formEl, (key, list) => {
    const f = form.find(x => x.key === key);
    const label = formEl.querySelector(`[data-links="${key}"]`).closest(".prop");
    label.outerHTML = fieldControl(f, list);
    formEl.querySelector(`[data-link-input="${key}"]`)?.focus();
  });

  const close = () => { root?.remove(); root = null; };
  root.addEventListener("mousedown", e => { if (e.target === root) close(); });
  formEl.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    // Enter in a [[link]] input adds a chip instead of submitting
    if (e.key === "Enter" && e.target.dataset.linkInput) e.preventDefault();
  });
  formEl.querySelector('[data-act="cancel"]').addEventListener("click", close);

  formEl.addEventListener("submit", async e => {
    e.preventDefault();
    const err = formEl.querySelector(".dialog-error");
    try {
      if (isLink) {
        const url = formEl.querySelector('[data-f="url"]').value.trim();
        const r = await api.capture(url);
        close();
        await app.reload();
        if (r.existing) toast("That link is already saved");
        app.select(r.item.id, { source: "list" });
        return;
      }
      const input = { type };
      const title = formEl.querySelector('[data-f="title"]').value.trim();
      input.title = title || uniqueTitle(`Untitled ${type}`);
      const lobe = formEl.querySelector('[data-f="lobe"]').value;
      if (lobe !== UNSORTED.id) input.lobe = lobe;
      input.tags = formEl.querySelector('[data-f="tags"]').value.split(",").map(s => s.trim().replace(/^#/, "")).filter(Boolean);
      for (const el of formEl.querySelectorAll("[data-field]")) {
        const v = readValue(el);
        if (v !== null) input[el.dataset.field] = v;
      }
      const item = await api.createItem(input);
      close();
      await app.reload();
      app.open(item.id);
    } catch (ex) {
      err.textContent = String(ex);
    }
  });
}
