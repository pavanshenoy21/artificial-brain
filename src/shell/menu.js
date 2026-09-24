// Context menu: a plain list with the one allowed shadow. Items can be
// disabled with a reason shown as a tooltip.

import { icon } from "../icons.js";
import { esc } from "../util.js";

let el;

/**
 * @param {{x:number,y:number}} at  viewport position
 * @param {Array<{label:string, iconName?:string, run?:()=>any, disabled?:string|false, keys?:string}|"-">} items
 */
export function openMenu(at, items) {
  closeMenu();
  el = document.createElement("div");
  el.className = "menu";
  el.setAttribute("role", "menu");
  el.innerHTML = items.map((it, i) => it === "-" ? `<div class="menu-sep"></div>`
    : `<button type="button" role="menuitem" class="menu-item" data-i="${i}" ${it.disabled ? `aria-disabled="true" title="${esc(it.disabled)}"` : ""}>
        ${it.iconName ? icon(it.iconName, { size: 14 }) : `<span class="menu-gap"></span>`}<span>${esc(it.label)}</span>${it.keys ? `<kbd>${esc(it.keys)}</kbd>` : ""}</button>`).join("");
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.min(at.x, innerWidth - r.width - 6)}px`;
  el.style.top = `${Math.min(at.y, innerHeight - r.height - 6)}px`;
  el.querySelector(".menu-item:not([aria-disabled])")?.focus();

  el.addEventListener("click", e => {
    const b = e.target.closest(".menu-item");
    if (!b || b.getAttribute("aria-disabled")) return;
    const it = items[+b.dataset.i];
    closeMenu();
    it.run?.();
  });
  el.addEventListener("keydown", e => {
    const btns = [...el.querySelectorAll(".menu-item")];
    const i = btns.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
  });
  setTimeout(() => {
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", closeMenu, { once: true });
  });
}

function outside(e) {
  if (el && !el.contains(e.target)) closeMenu();
}

export function closeMenu() {
  window.removeEventListener("pointerdown", outside, true);
  el?.remove();
  el = null;
}
