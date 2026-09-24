import { esc, hexToRgb, openExternal } from "./util.js";
import { typeIcon } from "./shapes.js";

// [[Target|alias]] / [[Target#heading]] → readable text
const unwiki = s => s.replace(/!?\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_, t, alias) => alias || t.split("#")[0]);

function fields(n) {
  const rows = [];
  const add = (k, v) => v && (Array.isArray(v) ? v.length : true) && rows.push([k, Array.isArray(v) ? v.join(", ") : v]);
  switch (n.type) {
    case "hackathon": add("When", n.date); add("Role", n.role); add("Built", n.built); add("Stack", n.stack); break;
    case "project":   add("Status", n.status); add("Stack", n.stack); add("Repo", n.repo); break;
    case "skill":     add("Level", n.level); break;
    case "link":      break;
    default: break;
  }
  if (!rows.length) return "";
  return `<div class="p-section"><dl class="p-fields">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></div>`;
}

export function createPanel({ lobes, types, byId, adj, onSelect, onClose }) {
  const root = document.getElementById("panel");
  const inner = document.getElementById("panel-inner");
  let current = null;

  function render(n) {
    const lobe = lobes[n.lobe];
    const rgb = hexToRgb(lobe.color);
    const typeName = types[n.type].name.replace(/s$/, "");

    const conns = (adj.get(n.id) || [])
      .map(e => ({ node: byId.get(e.id), kind: e.kind }))
      .filter(x => x.node)
      .sort((a, b) => (a.kind === b.kind ? a.node.title.localeCompare(b.node.title) : a.kind === "explicit" ? -1 : 1));

    // "Used in": for skills, which projects / hackathons point at them
    const usedIn = n.type === "skill" ? conns.filter(c => c.node.type === "project" || c.node.type === "hackathon") : [];

    inner.innerHTML = `
      <div class="p-head">
        <div class="p-badge" style="background:rgba(${rgb},.12);box-shadow:inset 0 0 0 1px rgba(${rgb},.35)">${typeIcon(n.type, lobe.color, 20)}</div>
        <div>
          <div class="p-title">${esc(n.title)}</div>
          <div class="p-sub"><span class="dot" style="background:${lobe.color}"></span>${esc(lobe.name)} · ${esc(typeName)}</div>
        </div>
        <button class="p-close" type="button" aria-label="Close">×</button>
      </div>
      ${n.tags?.length ? `<div class="p-tags">${n.tags.map(t => `<span class="tag">#${esc(t)}</span>`).join("")}</div>` : ""}
      ${n.body ? `<div class="p-section"><p class="p-body">${esc(unwiki(n.body))}</p></div>` : ""}
      ${n.type === "link" ? `<div class="p-section">
          ${n.summary ? `<p class="p-body">${esc(n.summary)}</p>` : ""}
          <p style="margin:10px 0 0"><a class="p-link" href="${esc(n.url)}" data-ext>${esc(n.url)}</a></p></div>` : ""}
      ${fields(n)}
      ${usedIn.length ? `<div class="p-section"><div class="p-label">Used in</div><div class="p-conn">${usedIn.map(connBtn).join("")}</div></div>` : ""}
      ${conns.length ? `<div class="p-section"><div class="p-label">Connections · ${conns.length}</div><div class="p-conn">${conns.map(connBtn).join("")}</div></div>` : ""}
      <div class="p-actions">
        <button type="button" disabled title="Coming soon: AI rewrite of this node">Polish with AI</button>
        <button type="button" disabled title="Coming soon">Edit</button>
      </div>`;

    function connBtn(c) {
      const l = lobes[c.node.lobe];
      return `<button type="button" data-id="${esc(c.node.id)}">${typeIcon(c.node.type, l.color, 13)}<span>${esc(c.node.title)}</span><span class="kind">${c.kind === "explicit" ? "linked" : "similar"}</span></button>`;
    }
  }

  inner.addEventListener("click", e => {
    if (e.target.closest(".p-close")) { close(); onClose?.(); return; }
    const a = e.target.closest("a[data-ext]");
    if (a) { e.preventDefault(); openExternal(a.getAttribute("href")); return; }
    const b = e.target.closest("button[data-id]");
    if (b) onSelect(byId.get(b.dataset.id));
  });

  function open(n) {
    current = n;
    render(n);
    inner.scrollTop = 0;
    root.classList.add("open");
    root.setAttribute("aria-hidden", "false");
  }
  function close() {
    current = null;
    root.classList.remove("open");
    root.setAttribute("aria-hidden", "true");
  }

  return {
    open, close,
    rect: () => root.getBoundingClientRect(),
    get current() { return current; },
  };
}
