// Settings tab: vault, appearance, lobes, AI provider, embeddings, GitHub,
// shortcuts. Fields save on change (like Obsidian); secrets never come back
// from the backend, only a "saved" marker.

import { app } from "../state.js";
import { api, isDesktop } from "../api.js";
import { icon } from "../icons.js";
import { esc } from "../util.js";
import { toast } from "../shell/toast.js";
import { openVaultFolder, rebuildIndex } from "../actions.js";

const SECRET = "__saved__";

export const PROVIDERS = {
  "": { name: "Off" },
  llama: { name: "llama.cpp (local)", base_url: "http://127.0.0.1:8080/v1", model: "" },
  groq: { name: "Groq", base_url: "https://api.groq.com/openai/v1", model: "llama-3.1-8b-instant" },
  custom: { name: "Other OpenAI-compatible", base_url: "", model: "" },
};

const slug = s => s.toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "lobe";

export function settingsTab(pane) {
  let s = null;          // settings as last saved
  let lobes = [];        // lobes being edited
  let lobesDirty = false;
  let vault = null;

  const row = (label, desc, control) => `
    <div class="set-row"><div class="set-text"><div class="set-label">${label}</div>${desc ? `<div class="set-desc">${desc}</div>` : ""}</div>
    <div class="set-control">${control}</div></div>`;
  const input = (path, value, attrs = "") => `<input class="input" data-path="${path}" value="${esc(value ?? "")}" spellcheck="false" ${attrs} />`;
  const secret = (path, value, ph) => `<input class="input" type="password" data-path="${path}" data-secret value="" placeholder="${value === SECRET ? "Saved (type to replace)" : esc(ph)}" autocomplete="off" />`;

  function render() {
    const counts = new Map();
    for (const n of app.items.values()) counts.set(n.lobe, (counts.get(n.lobe) || 0) + 1);
    pane.innerHTML = `<div class="doc"><div class="doc-inner settings">
      <h1 class="doc-title">Settings</h1>

      <h2>Vault</h2>
      ${row("Folder", "Markdown files live here. Obsidian can open the same folder.",
        `<code class="set-path" title="${esc(vault?.path || "")}">${esc(vault?.path || "")}</code>
         ${isDesktop ? `<button type="button" class="btn" data-act="vault">Change</button>` : ""}`)}
      ${row("Index", "The search index is a cache; rebuilding re-reads every file.", `<button type="button" class="btn" data-act="rebuild">Rebuild index</button>`)}

      <h2>Appearance</h2>
      ${row("Theme", "", `<select class="input" data-path="theme"><option value="dark">Dark</option><option value="light">Light</option></select>`)}

      <h2>Lobes</h2>
      <p class="set-desc">Lobes group the graph by colour. Items in a removed lobe move to Unsorted.</p>
      <div class="lobe-list">${lobes.map((l, i) => `
        <div class="lobe-row" data-i="${i}">
          <input type="color" value="${esc(l.color)}" data-lobe="color" aria-label="Colour" />
          <input class="input" value="${esc(l.name)}" data-lobe="name" aria-label="Name" spellcheck="false" />
          <span class="faint lobe-id" title="id used in frontmatter">${esc(l.id)}</span>
          <span class="count">${counts.get(l.id) || 0}</span>
          <button type="button" class="icon-btn" data-act="lobe-del" title="Remove lobe">${icon("trash", { size: 14 })}</button>
        </div>`).join("")}
      </div>
      <div class="set-actions">
        <button type="button" class="btn" data-act="lobe-add">${icon("plus", { size: 14 })}Add lobe</button>
        <button type="button" class="btn primary" data-act="lobe-save" ${lobesDirty ? "" : "disabled"}>Save lobes</button>
      </div>

      <h2>AI provider</h2>
      <p class="set-desc">Used for link summaries, Polish / Summarize / Fill form, tag suggestions and Ask. Everything works without it.</p>
      ${row("Provider", "", `<select class="input" data-path="ai.provider">${Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}">${p.name}</option>`).join("")}</select>`)}
      <div class="${s.ai.provider ? "" : "set-off"}">
        ${row("Base URL", "OpenAI-compatible, ending in /v1.", input("ai.base_url", s.ai.base_url, `placeholder="${esc(PROVIDERS[s.ai.provider]?.base_url || "http://127.0.0.1:8080/v1")}"`))}
        ${row("Model", s.ai.provider === "llama" ? "Optional for llama.cpp (the server's loaded model)." : "", input("ai.model", s.ai.model))}
        ${row("API key", s.ai.provider === "llama" ? "Not needed for a local server." : "Stored in settings.json (permissions 0600).", secret("ai.api_key", s.ai.api_key, "sk-…"))}
        ${row("", "", `<button type="button" class="btn" data-act="test-ai">Test connection</button><span class="set-result" data-result="ai"></span>`)}
      </div>

      <h2>Embeddings</h2>
      <p class="set-desc">A local llama.cpp server started with <code>--embedding</code> (Groq has no embeddings). Without it, suggested links come from shared tags.</p>
      ${row("Base URL", "", input("embed.base_url", s.embed.base_url, `placeholder="http://127.0.0.1:8081/v1"`))}
      ${row("Model", "Optional.", input("embed.model", s.embed.model))}
      ${row("Suggestions per item", "", input("embed.top_k", s.embed.top_k, `type="number" min="1" max="10"`))}
      ${row("Minimum similarity", "0 to 1. Higher means fewer, closer suggestions.", input("embed.min_score", s.embed.min_score, `type="number" min="0" max="1" step="0.05"`))}
      ${row("", "", `<button type="button" class="btn" data-act="test-embed">Test connection</button>
        <button type="button" class="btn" data-act="embed-all">Embed everything now</button><span class="set-result" data-result="embed"></span>`)}

      <h2>GitHub</h2>
      <p class="set-desc">A fine-grained personal access token with read-only access to your repositories (Contents and Metadata: read).</p>
      ${row("Token", "", secret("github.token", s.github.token, "github_pat_…"))}
      ${row("Sync on startup", "When the last sync is more than a day old.", `<input type="checkbox" data-path="github.auto_sync" ${s.github.auto_sync ? "checked" : ""} />`)}
      <div data-slot="github"></div>

      <h2>Shortcuts</h2>
      ${row("Quick capture", "Global shortcut. On GNOME Wayland, bind <code>brain --capture</code> as a custom shortcut instead.",
        input("shortcuts.capture", s.shortcuts.capture, `placeholder="CommandOrControl+Shift+Space"`))}
    </div></div>`;
    pane.querySelector('[data-path="theme"]').value = s.theme || "dark";
    pane.querySelector('[data-path="ai.provider"]').value = s.ai.provider || "";
    app.emit("settings-rendered", pane);
  }

  function get(path) { return path.split(".").reduce((o, k) => o?.[k], s); }
  function set(obj, path, v) {
    const ks = path.split(".");
    const last = ks.pop();
    ks.reduce((o, k) => o[k], obj)[last] = v;
  }

  async function save(next) {
    try {
      s = await api.saveSettings(next);
      app.settings = s;
      app.emit("settings", s);
    } catch (e) {
      toast(`Couldn't save settings: ${e}`, "error");
    }
  }

  // The settings as currently shown (secrets typed but not yet saved included).
  function current() {
    const next = structuredClone(s);
    for (const el of pane.querySelectorAll("[data-path]")) {
      const path = el.dataset.path;
      let v = el.type === "checkbox" ? el.checked : el.value;
      if ("secret" in el.dataset) v = el.value ? el.value : get(path);
      if (el.type === "number") v = v === "" ? get(path) : Number(v);
      set(next, path, v);
    }
    return next;
  }

  pane.addEventListener("change", async e => {
    const el = e.target;
    if (el.dataset.lobe) return;
    if (!el.dataset.path) return;
    const next = current();
    if (el.dataset.path === "ai.provider") {
      const p = PROVIDERS[el.value] || {};
      if (el.value && (!next.ai.base_url || Object.values(PROVIDERS).some(x => x.base_url === next.ai.base_url))) next.ai.base_url = p.base_url || "";
      if (el.value && !next.ai.model && p.model) next.ai.model = p.model;
    }
    if (el.dataset.path === "theme") app.emit("theme", el.value);
    await save(next);
    if (el.dataset.path === "ai.provider") render();
    if ("secret" in el.dataset) { el.value = ""; el.placeholder = "Saved (type to replace)"; }
  });

  pane.addEventListener("input", e => {
    const row = e.target.closest(".lobe-row");
    if (!row) return;
    const l = lobes[+row.dataset.i];
    l[e.target.dataset.lobe] = e.target.value;
    lobesDirty = true;
    pane.querySelector('[data-act="lobe-save"]').disabled = false;
  });

  pane.addEventListener("click", async e => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    const result = k => pane.querySelector(`[data-result="${k}"]`);
    if (act === "vault") { await openVaultFolder(); vault = await api.vaultInfo(); render(); }
    if (act === "rebuild") rebuildIndex();
    if (act === "lobe-add") {
      const used = new Set(lobes.map(l => l.id));
      let id = "new", i = 2;
      while (used.has(id)) id = `new-${i++}`;
      lobes.push({ id, name: "New lobe", color: "#8a8a8a", fresh: true });
      lobesDirty = true;
      render();
      pane.querySelector(`.lobe-row[data-i="${lobes.length - 1}"] [data-lobe="name"]`)?.select();
    }
    if (act === "lobe-del") {
      lobes.splice(+e.target.closest(".lobe-row").dataset.i, 1);
      lobesDirty = true;
      render();
    }
    if (act === "lobe-save") {
      // new lobes get their id from the name
      const used = new Set(lobes.filter(l => !l.fresh).map(l => l.id));
      const out = lobes.map(l => {
        if (!l.fresh) return { id: l.id, name: l.name.trim(), color: l.color };
        let id = slug(l.name), i = 2;
        while (used.has(id)) id = `${slug(l.name)}-${i++}`;
        used.add(id);
        return { id, name: l.name.trim(), color: l.color };
      });
      try {
        await api.saveLobes(out);
        lobes = out.map(l => ({ ...l }));
        lobesDirty = false;
        await app.reload();
        toast("Lobes saved");
      } catch (err) {
        toast(`Couldn't save lobes: ${err}`, "error");
      }
      render();
    }
    if (act === "test-ai" || act === "test-embed") {
      const k = act === "test-ai" ? "ai" : "embed";
      result(k).textContent = "Testing…";
      result(k).className = "set-result";
      const r = await (k === "ai" ? api.testAi(current()) : api.testEmbed(current())).catch(err => ({ ok: false, message: String(err) }));
      result(k).textContent = r.message;
      result(k).className = `set-result ${r.ok ? "ok" : "error"}`;
    }
    if (act === "embed-all") {
      await api.embedAll();
      result("embed").textContent = "Embedding in the background (see the status bar).";
      result("embed").className = "set-result";
    }
  });

  async function load() {
    [s, vault] = await Promise.all([api.getSettings(), api.vaultInfo()]);
    lobes = app.lobes.map(l => ({ ...l }));
    render();
  }
  load();

  return {
    update() {
      if (!s) return;
      if (!lobesDirty) lobes = app.lobes.map(l => ({ ...l }));
      // don't re-render under the user's cursor
      if (!pane.contains(document.activeElement) || document.activeElement === document.body) render();
    },
  };
}
