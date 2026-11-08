// A small modal for confirmations ("Delete …?"), keyboard first:
// Enter confirms, Esc cancels.

import { esc } from "../util.js";

export function confirmDialog({ title, body = "", ok = "Delete", danger = true }) {
  return new Promise(resolve => {
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.innerHTML = `<div class="dialog dialog-small" role="dialog" aria-modal="true">
      <div class="dialog-head">${esc(title)}</div>
      ${body ? `<div class="dialog-body">${esc(body)}</div>` : ""}
      <div class="dialog-foot"><span class="fill"></span>
        <button type="button" class="btn" data-act="cancel">Cancel</button>
        <button type="button" class="btn ${danger ? "danger-solid" : "primary"}" data-act="ok">${esc(ok)}</button>
      </div></div>`;
    document.body.appendChild(back);
    const prev = document.activeElement;
    const done = v => {
      back.remove();
      prev?.focus?.();
      resolve(v);
    };
    back.addEventListener("click", e => {
      if (e.target === back || e.target.closest('[data-act="cancel"]')) done(false);
      if (e.target.closest('[data-act="ok"]')) done(true);
    });
    back.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Escape") done(false);
      if (e.key === "Enter") { e.preventDefault(); done(true); }
    });
    back.querySelector('[data-act="ok"]').focus();
  });
}
