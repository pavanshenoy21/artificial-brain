// Review dialog for AI actions: shows what would change as a word diff (or a
// field table), Accept (Ctrl Enter) or Reject (Esc). Nothing changes until
// Accept, and the backend keeps the original in .brain/history/.

import { diffWords } from "diff";
import { esc } from "../util.js";

let root;

function wordDiff(before, after) {
  return diffWords(before || "", after || "")
    .map(p => p.added ? `<ins>${esc(p.value)}</ins>` : p.removed ? `<del>${esc(p.value)}</del>` : esc(p.value))
    .join("");
}

const show = v => (Array.isArray(v) ? v.join(", ") : v ?? "");

/**
 * @param {object} o
 * @param {string} o.title                    e.g. "Polish · Note title"
 * @param {() => Promise<{before:string, after:string} | {rows:{key:string, before:any, after:any}[]}>} o.load
 * @param {(result) => Promise<void>} o.onAccept
 * @param {string} [o.working]                text while waiting
 */
export function openReview({ title, load, onAccept, working = "Working…" }) {
  root?.remove();
  root = document.createElement("div");
  root.className = "modal-backdrop";
  root.innerHTML = `
    <div class="dialog review" role="dialog" aria-modal="true" aria-label="${esc(title)}" tabindex="-1">
      <div class="dialog-head">${esc(title)}</div>
      <div class="dialog-body review-body"><p class="muted">${esc(working)}</p></div>
      <div class="dialog-foot">
        <span class="dialog-error" role="alert"></span>
        <span class="faint review-note">The original is kept in .brain/history</span>
        <button type="button" class="btn" data-act="reject">Reject <kbd>Esc</kbd></button>
        <button type="button" class="btn primary" data-act="accept" disabled>Accept <kbd>Ctrl Enter</kbd></button>
      </div>
    </div>`;
  document.body.appendChild(root);
  const dlg = root.querySelector(".dialog");
  const body = root.querySelector(".review-body");
  const accept = root.querySelector('[data-act="accept"]');
  const error = root.querySelector(".dialog-error");
  dlg.focus();

  let result = null;
  let closed = false;
  const close = () => { closed = true; root?.remove(); root = null; };

  load().then(r => {
    if (closed) return;
    result = r;
    if (r.rows) {
      const rows = r.rows.filter(x => JSON.stringify(x.before ?? null) !== JSON.stringify(x.after ?? null));
      if (!rows.length) { body.innerHTML = `<p class="muted">Nothing to change.</p>`; return; }
      result = { rows };
      body.innerHTML = `<table class="review-fields">${rows.map(x => `<tr><th>${esc(x.key.replace(/_/g, " "))}</th>
        <td>${wordDiff(show(x.before), show(x.after))}</td></tr>`).join("")}</table>`;
    } else {
      if (r.before === r.after) { body.innerHTML = `<p class="muted">No changes suggested.</p>`; return; }
      body.innerHTML = `<div class="review-diff">${wordDiff(r.before, r.after)}</div>`;
    }
    accept.disabled = false;
    accept.focus();
  }).catch(e => {
    if (closed) return;
    body.innerHTML = "";
    error.textContent = String(e);
  });

  async function doAccept() {
    if (!result || accept.disabled) return;
    accept.disabled = true;
    try {
      await onAccept(result);
      close();
    } catch (e) {
      error.textContent = String(e);
      accept.disabled = false;
    }
  }

  accept.addEventListener("click", doAccept);
  root.querySelector('[data-act="reject"]').addEventListener("click", close);
  root.addEventListener("mousedown", e => { if (e.target === root) close(); });
  dlg.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); doAccept(); }
  });
}
