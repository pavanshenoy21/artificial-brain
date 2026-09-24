// Form controls for frontmatter fields, shared by the properties pane and the
// "New …" dialog. Each control carries data-field; readValue() turns it back
// into a frontmatter value (null = remove the field).

import { app } from "../state.js";
import { esc } from "../util.js";
import { icon } from "../icons.js";

const label = f => f.label || f.key.replace(/_/g, " ");
const asText = v => (Array.isArray(v) ? v.join(", ") : v && typeof v === "object" ? JSON.stringify(v) : v ?? "");
const unlink = s => String(s).replace(/^\[\[|\]\]$/g, "").split("|").pop();

export function fieldControl(f, value, { github = false } = {}) {
  const ro = f.readonly || (f.github && github);
  const attrs = `data-field="${esc(f.key)}" data-kind="${f.kind}" ${ro ? "readonly tabindex=-1" : ""} spellcheck="false" placeholder="${esc(f.placeholder || "")}"`;
  let control;
  switch (f.kind) {
    case "select":
      control = `<select ${attrs} ${ro ? "disabled" : ""}><option value=""></option>${f.options.map(o => `<option value="${esc(o)}" ${o === value ? "selected" : ""}>${esc(o)}</option>`).join("")}
        ${value && !f.options.includes(value) ? `<option selected value="${esc(value)}">${esc(value)}</option>` : ""}</select>`;
      break;
    case "textarea":
      control = `<textarea rows="2" ${attrs}>${esc(asText(value))}</textarea>`;
      break;
    case "date":
      control = `<input type="date" value="${esc(/^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : "")}" ${attrs} />`;
      break;
    case "number":
      control = `<input type="number" value="${esc(value ?? "")}" ${attrs} />`;
      break;
    case "links": {
      const list = (Array.isArray(value) ? value : value ? [value] : []).map(unlink);
      const opts = [...app.items.values()].filter(n => !f.linkType || n.type === f.linkType).map(n => n.title).sort();
      control = `<div class="tag-edit" data-links="${esc(f.key)}">
        ${list.map(t => `<span class="tag link-chip">${esc(t)}<button type="button" data-unlink="${esc(t)}" aria-label="Remove">${icon("x", { size: 11 })}</button></span>`).join("")}
        <input data-link-input="${esc(f.key)}" list="opts-${esc(f.key)}" placeholder="${list.length ? "" : "add…"}" spellcheck="false" />
        <datalist id="opts-${esc(f.key)}">${opts.map(o => `<option value="${esc(o)}"></option>`).join("")}</datalist>
        <input type="hidden" data-field="${esc(f.key)}" data-kind="links" value="${esc(JSON.stringify(list))}" /></div>`;
      break;
    }
    default: {
      const dl = f.suggestions ? `list="sugg-${esc(f.key)}"` : "";
      control = `<input type="${f.kind === "url" ? "url" : "text"}" value="${esc(asText(value))}" ${attrs} ${dl} />
        ${f.suggestions ? `<datalist id="sugg-${esc(f.key)}">${f.suggestions.map(o => `<option value="${esc(o)}"></option>`).join("")}</datalist>` : ""}`;
    }
  }
  return `<label class="prop ${ro ? "prop-ro" : ""}" ${f.github ? `title="From GitHub (updated on sync)"` : ""}><span>${esc(label(f))}</span>${control}
    ${f.kind === "url" && value ? `<button type="button" class="icon-btn" data-open-url="${esc(value)}" title="Open in browser">${icon("external", { size: 13 })}</button>` : ""}</label>`;
}

// Control value → frontmatter value.
export function readValue(el) {
  const kind = el.dataset.kind;
  const raw = (el.value ?? "").trim();
  if (kind === "links") {
    const list = JSON.parse(el.value || "[]");
    return list.length ? list.map(t => `[[${t}]]`) : null;
  }
  if (!raw) return null;
  if (kind === "list") return raw.split(",").map(s => s.trim()).filter(Boolean);
  if (kind === "number") return isNaN(+raw) ? raw : +raw;
  return raw;
}

// Wire the [[link]] chip inputs inside `root`; `onChange(key, list)` fires on edits.
export function bindLinkInputs(root, onChange) {
  root.addEventListener("keydown", e => {
    const key = e.target.dataset?.linkInput;
    if (!key || e.key !== "Enter") return;
    e.preventDefault();
    const hidden = root.querySelector(`input[type=hidden][data-field="${key}"]`);
    const list = JSON.parse(hidden.value || "[]");
    const v = e.target.value.trim();
    if (v && !list.includes(v)) list.push(v);
    e.target.value = "";
    hidden.value = JSON.stringify(list);
    onChange(key, list);
  });
  root.addEventListener("click", e => {
    const b = e.target.closest("[data-unlink]");
    if (!b) return;
    const box = b.closest("[data-links]");
    const hidden = box.querySelector("input[type=hidden]");
    const list = JSON.parse(hidden.value || "[]").filter(t => t !== b.dataset.unlink);
    hidden.value = JSON.stringify(list);
    onChange(box.dataset.links, list);
  });
}
