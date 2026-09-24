import { esc } from "./util.js";
import { typeIcon } from "./shapes.js";

const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function haystacks(n) {
  return {
    title: n.title.toLowerCase(),
    tags: (n.tags || []).join(" ").toLowerCase(),
    text: [n.body, n.summary, n.built, n.url, ...(n.stack || [])].filter(Boolean).join(" ").toLowerCase(),
  };
}

// Plain keyword scoring for the MVP. Every token must match somewhere.
// Later: blend with embedding similarity so "that jwt thing" finds the writeup.
function score(h, tokens) {
  let s = 0;
  for (const t of tokens) {
    if (h.title.startsWith(t)) s += 10;
    else if (h.title.includes(" " + t)) s += 7;
    else if (h.title.includes(t)) s += 5;
    else if (h.tags.includes(t)) s += 3;
    else if (h.text.includes(t)) s += 1;
    else return 0;
  }
  return s;
}

export function createSearch({ nodes, lobes, types, onPick, onOpen, onClose }) {
  const root = document.getElementById("palette");
  const input = document.getElementById("palette-input");
  const list = document.getElementById("palette-results");
  const index = nodes.map(n => ({ n, h: haystacks(n) }));
  let results = [];
  let active = 0;

  function highlight(title, tokens) {
    let out = esc(title);
    if (!tokens.length) return out;
    const re = new RegExp(`(${tokens.map(t => reEsc(esc(t))).join("|")})`, "gi");
    return out.replace(re, "<mark>$1</mark>");
  }

  function run() {
    const tokens = input.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) {
      // empty query: most connected things first
      results = [...nodes].sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, 8);
    } else {
      results = index
        .map(({ n, h }) => ({ n, s: score(h, tokens) }))
        .filter(x => x.s > 0)
        .map(x => ({ ...x, s: x.s + (x.n.type === "project" ? 0.5 : 0) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 10)
        .map(x => x.n);
    }
    active = 0;
    render(tokens);
  }

  function render(tokens) {
    if (!results.length) {
      list.innerHTML = `<li class="palette-empty">Nothing in your brain matches that yet.</li>`;
      return;
    }
    list.innerHTML = results
      .map((n, i) => {
        const lobe = lobes[n.lobe];
        const meta = [types[n.type].name.replace(/s$/, ""), ...(n.tags || []).slice(0, 3).map(t => "#" + t)].join(" · ");
        return `<li data-i="${i}" class="${i === active ? "active" : ""}">
          ${typeIcon(n.type, lobe.color, 16)}
          <div><div class="r-title">${highlight(n.title, tokens)}</div><div class="r-meta">${esc(meta)}</div></div>
          <span class="r-lobe"><span class="dot" style="background:${lobe.color}"></span>${esc(lobe.name)}</span>
        </li>`;
      })
      .join("");
  }

  function setActive(i) {
    active = (i + results.length) % results.length;
    [...list.children].forEach((li, j) => li.classList.toggle("active", j === active));
    list.children[active]?.scrollIntoView({ block: "nearest" });
  }

  function open() {
    root.hidden = false;
    input.value = "";
    run();
    requestAnimationFrame(() => input.focus());
    onOpen?.();
  }
  function close() {
    if (root.hidden) return;
    root.hidden = true;
    onClose?.();
  }
  function pick(i) {
    const n = results[i];
    if (!n) return;
    close();
    onPick(n);
  }

  input.addEventListener("input", run);
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Enter") { e.preventDefault(); pick(active); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  });
  list.addEventListener("mousemove", e => {
    const li = e.target.closest("li[data-i]");
    if (li && +li.dataset.i !== active) setActive(+li.dataset.i);
  });
  list.addEventListener("click", e => {
    const li = e.target.closest("li[data-i]");
    if (li) pick(+li.dataset.i);
  });
  root.addEventListener("mousedown", e => { if (e.target === root) close(); });

  return { open, close, get isOpen() { return !root.hidden; } };
}
