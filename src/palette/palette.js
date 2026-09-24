// Generic keyboard palette (used by search and, later, commands).
// One palette element is shared; opening one mode replaces the other.

import { icon } from "../icons.js";
import { esc } from "../util.js";

const root = document.getElementById("palette");
root.innerHTML = `
  <div class="palette" role="dialog" aria-modal="true">
    <div class="palette-input">${icon("search")}<input autocomplete="off" spellcheck="false" /></div>
    <ul class="palette-results" role="listbox"></ul>
    <div class="palette-foot"></div>
  </div>`;
const input = root.querySelector("input");
const list = root.querySelector(".palette-results");
const foot = root.querySelector(".palette-foot");
const iconSlot = root.querySelector(".palette-input");

let mode = null;          // current config
let results = [];
let active = 0;
let runId = 0;

async function run() {
  const my = ++runId;
  const r = await mode.source(input.value);
  if (my !== runId) return; // a newer query finished first
  results = r;
  active = 0;
  render();
}

function render() {
  if (!results.length) {
    list.innerHTML = `<li class="palette-empty">${esc(mode.empty || "No results")}</li>`;
    return;
  }
  list.innerHTML = results.map((r, i) => `<li role="option" data-i="${i}" class="${i === active ? "active" : ""}">${mode.render(r, input.value)}</li>`).join("");
}

function setActive(i) {
  if (!results.length) return;
  active = (i + results.length) % results.length;
  [...list.children].forEach((li, j) => li.classList.toggle("active", j === active));
  list.children[active]?.scrollIntoView({ block: "nearest" });
}

function pick(i, ev) {
  const r = results[i];
  if (!r) return;
  const m = mode;
  close();
  m.onPick(r, { alt: ev?.ctrlKey || ev?.metaKey || ev?.shiftKey });
}

export function openPalette(cfg) {
  mode = cfg;
  iconSlot.firstElementChild.outerHTML = icon(cfg.iconName || "search");
  input.placeholder = cfg.placeholder || "";
  foot.innerHTML = cfg.foot || `<span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span>`;
  root.hidden = false;
  input.value = cfg.initial || "";
  input.focus();
  run();
}

export function close() {
  if (root.hidden) return;
  root.hidden = true;
  const m = mode;
  mode = null;
  m?.onClose?.();
}

export const paletteOpen = () => !root.hidden;
export const paletteMode = () => mode?.id;

input.addEventListener("input", run);
input.addEventListener("keydown", e => {
  if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) { e.preventDefault(); setActive(active + 1); }
  else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey && mode?.id !== "commands")) { e.preventDefault(); setActive(active - 1); }
  else if (e.key === "Enter") { e.preventDefault(); pick(active, e); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
});
list.addEventListener("mousemove", e => {
  const li = e.target.closest("li[data-i]");
  if (li && +li.dataset.i !== active) setActive(+li.dataset.i);
});
list.addEventListener("click", e => {
  const li = e.target.closest("li[data-i]");
  if (li) pick(+li.dataset.i, e);
});
root.addEventListener("mousedown", e => { if (e.target === root) close(); });
