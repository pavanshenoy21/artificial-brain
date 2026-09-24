// Ask: a right-sidebar chat over the vault. Answers cite [[notes]]; clicking a
// citation opens it, and the cited notes light up in the graph.

import { app } from "../state.js";
import { api } from "../api.js";
import { right } from "../shell/layout.js";
import { md } from "../editor/markdown.js";
import { typeIcon, icon } from "../icons.js";
import { esc } from "../util.js";
import { aiOn } from "./actions.js";

export function initAsk({ highlight }) {
  const pane = right.add({ id: "ask", title: "Ask", iconName: "ask" });
  pane.classList.add("ask-pane");
  pane.innerHTML = `
    <div class="ask-log" role="log" aria-live="polite"></div>
    <form class="ask-form">
      <textarea rows="2" placeholder="Ask about your notes" spellcheck="true"></textarea>
      <div class="ask-foot"><span class="faint ask-hint"></span><button type="submit" class="btn primary">Ask</button></div>
    </form>`;
  const log = pane.querySelector(".ask-log");
  const form = pane.querySelector(".ask-form");
  const input = form.querySelector("textarea");
  const hint = form.querySelector(".ask-hint");
  const turns = [];     // { role, content } for follow-ups
  let busy = false;

  function updateHint() {
    hint.textContent = aiOn() ? "Enter to ask · Shift Enter for a new line" : "AI is off: you'll get matching notes, no answer";
  }
  updateHint();
  app.on("settings", updateHint);

  function sourceList(sources, cited) {
    if (!sources.length) return `<div class="empty-note">No matching notes.</div>`;
    return sources.map(s => {
      const n = app.items.get(s.id);
      if (!n) return "";
      return `<button type="button" class="row item-row ${cited.includes(s.id) ? "cited" : ""}" data-id="${esc(s.id)}" title="${s.why === "neighbour" ? "Linked from a match" : "Matches the question"}">
        ${typeIcon(n.type, app.lobeOf(n).color, 11)}<span class="row-title">${esc(n.title)}</span>${s.why === "neighbour" ? `<span class="row-state">linked</span>` : ""}</button>`;
    }).join("");
  }

  function addBlock(html, cls) {
    const el = document.createElement("div");
    el.className = `ask-msg ${cls}`;
    el.innerHTML = html;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  async function send() {
    const q = input.value.trim();
    if (!q || busy) return;
    busy = true;
    input.value = "";
    addBlock(esc(q), "ask-q");
    const pending = addBlock(`<span class="muted">${aiOn() ? "Reading your notes…" : "Looking for matching notes…"}</span>`, "ask-a");
    try {
      const r = await api.ask(q, turns.slice(-6));
      const cited = r.cited || [];
      pending.innerHTML = `${r.answer ? `<div class="markdown ask-answer">${md.render(r.answer)}</div>` : `<div class="muted">AI is off. Notes that match:</div>`}
        <div class="ask-sources"><div class="side-label">${icon("files", { size: 12 })}<span>Sources</span><span class="count">${r.retrieval}</span></div>${sourceList(r.sources || [], cited)}</div>`;
      if (r.answer) turns.push({ role: "user", content: q }, { role: "assistant", content: r.answer });
      const lit = cited.length ? cited : (r.sources || []).filter(s => s.why === "match").map(s => s.id);
      if (lit.length) highlight(lit, cited.length ? `Cited: ${cited.length} note${cited.length > 1 ? "s" : ""}` : "Matches");
    } catch (e) {
      pending.innerHTML = `<span class="error-text">${esc(String(e))}</span>`;
    } finally {
      busy = false;
      log.scrollTop = log.scrollHeight;
    }
  }

  form.addEventListener("submit", e => { e.preventDefault(); send(); });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  log.addEventListener("click", e => {
    const w = e.target.closest("a.wikilink");
    if (w) { e.preventDefault(); if (w.dataset.id) app.open(w.dataset.id); return; }
    const r = e.target.closest(".item-row");
    if (r) app.select(r.dataset.id, { source: "sidebar" });
  });
  log.addEventListener("dblclick", e => {
    const r = e.target.closest(".item-row");
    if (r) app.open(r.dataset.id);
  });

  return { focus: () => { right.show("ask"); input.focus(); } };
}
