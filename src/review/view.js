// Review: flashcards from "question :: answer" lines in your notes, spaced
// out with SM-2 so you see each one just before you'd forget it. The
// schedule is kept in .brain/review.json (never in the notes).
//
// Keys: Space / Enter shows the answer, 1–4 grade it (Again, Hard, Good, Easy).

import { app } from "../state.js";
import { api } from "../api.js";
import { md } from "../editor/markdown.js";
import { typeIcon } from "../icons.js";
import { esc } from "../util.js";
import { status } from "../shell/statusbar.js";
import { tabsApi } from "../shell/tabs.js";
import { toast } from "../shell/toast.js";
import { allCards, queue, schedule, nextDue, GRADES, spanLabel, NEW_PER_DAY } from "../lib/srs.js";
import { today } from "../lib/tasks.js";

let state = null;          // { cards: { key: { due, interval, ease, reps, lapses, last } }, newDay, newCount }
let loading = null;

export async function loadReviewState() {
  loading ||= api.getState("review").then(s => {
    state = s && typeof s === "object" ? s : { cards: {} };
    state.cards ||= {};
    return state;
  }).catch(() => (state = { cards: {} }));
  return loading;
}

function saveState() {
  return api.setState("review", state).catch(e => toast(`Review progress not saved: ${e}`, "error"));
}

// "12 to review" in the status bar.
export function initReviewStatus() {
  const show = async () => {
    await loadReviewState();
    const n = queue(allCards(app.items.values()), state).length;
    status.set("review", n ? `${n} to review` : "", "Flashcards due: click to review");
  };
  app.on("data", show);
  app.on("review", show);
}

export function reviewTab(pane, tab) {
  pane.innerHTML = `<div class="review"><div class="review-inner"></div></div>`;
  const root = pane.querySelector(".review-inner");
  let cards = [], q = [], cur = null, shown = false, done = 0;
  const again = new Map();   // key -> times failed this session

  async function refresh() {
    await loadReviewState();
    cards = allCards(app.items.values());
    const byKey = new Map(cards.map(c => [c.key, c]));
    // cards failed this session stay in the queue even though they're now due tomorrow
    const retry = q.filter(c => again.has(c.key)).map(c => byKey.get(c.key)).filter(Boolean);
    q = queue(cards, state);
    for (const c of retry) if (!q.some(x => x.key === c.key)) q.push(c);
    cur = cur && byKey.get(cur.key);
    if (cur) q = [cur, ...q.filter(c => c.key !== cur.key)];
    cur = q[0] || null;
    if (!cur) shown = false;
    render();
  }

  function answer(grade) {
    if (!cur || !shown) return;
    const now = today();
    const isNew = !state.cards[cur.key];
    state.cards[cur.key] = schedule(state.cards[cur.key], grade, now);
    if (isNew) {
      if (state.newDay !== now) { state.newDay = now; state.newCount = 0; }
      state.newCount += 1;
    }
    saveState();
    done += 1;
    q = q.filter(c => c.key !== cur.key);
    // "Again" comes back at the end of this session (at most 3 times)
    if (grade === 1 && (again.get(cur.key) || 0) < 3) {
      again.set(cur.key, (again.get(cur.key) || 0) + 1);
      q.push(cur);
    }
    cur = q[0] || null;
    shown = false;
    render();
    app.emit("review");
  }

  function render() {
    const st = state?.cards || {};
    const due = q.filter(c => st[c.key]).length, fresh = q.filter(c => !st[c.key]).length;
    const notes = new Set(cards.map(c => c.id)).size;
    const head = `<div class="review-head"><h2>Review</h2>
      <span class="faint">${cards.length} card${cards.length === 1 ? "" : "s"} in ${notes} note${notes === 1 ? "" : "s"}${done ? ` · ${done} done this session` : ""}</span></div>`;
    if (!cards.length) {
      root.innerHTML = `${head}<div class="review-empty">
        <p>No flashcards yet. Write one per line in any note:</p>
        <pre>What does chmod 640 do? :: owner read/write, group read, others nothing</pre>
        <p class="faint">Each card comes back after 1 day, then 3, then further apart the better you know it. New cards: up to ${NEW_PER_DAY} a day.</p></div>`;
      return;
    }
    if (!cur) {
      const next = nextDue(cards, state);
      root.innerHTML = `${head}<div class="review-empty"><p>Nothing to review right now.</p>
        ${next ? `<p class="faint">Next card due ${next === today() ? "later today" : esc(next)}.</p>` : ""}</div>`;
      return;
    }
    const n = app.items.get(cur.id);
    const lobe = app.lobeOf(n);
    const s = st[cur.key];
    root.innerHTML = `${head}
      <div class="review-count"><span>${due} due</span><span>${fresh} new</span></div>
      <div class="review-card">
        <button type="button" class="review-src btn-link" data-act="open" title="Open the note">${typeIcon(n.type, lobe.color, 11)}${esc(n.title)}</button>
        <div class="review-q markdown">${md.renderInline(cur.q)}</div>
        ${shown ? `<div class="review-a markdown">${md.renderInline(cur.a)}</div>` : ""}
      </div>
      <div class="review-actions">
        ${shown
          ? GRADES.map(g => `<button type="button" class="btn grade grade-${g.grade}" data-grade="${g.grade}">
              <span>${g.name}</span><small>${g.grade === 1 ? "soon" : spanLabel(schedule(s, g.grade).interval)}</small><kbd>${g.key}</kbd></button>`).join("")
          : `<button type="button" class="btn primary" data-act="show">Show answer <kbd>Space</kbd></button>`}
      </div>
      ${s ? `<div class="review-meta faint">Seen ${s.reps + s.lapses} time${s.reps + s.lapses === 1 ? "" : "s"} · last ${esc(s.last || "")}</div>` : `<div class="review-meta faint">New card</div>`}`;
  }

  pane.addEventListener("click", e => {
    const g = e.target.closest("[data-grade]");
    if (g) { answer(+g.dataset.grade); return; }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "show") { shown = true; render(); }
    if (act === "open" && cur) app.open(cur.id);
  });

  const onKey = e => {
    if (tabsApi.active !== tab || e.ctrlKey || e.metaKey || e.altKey) return;
    const a = document.activeElement;
    if (a && (/INPUT|TEXTAREA|SELECT/.test(a.tagName) || a.isContentEditable || a.closest?.(".cm-editor"))) return;
    if (document.querySelector("#palette:not([hidden])")) return;
    if ((e.key === " " || e.key === "Enter") && cur && !shown) { e.preventDefault(); shown = true; render(); }
    else if (shown && /^[1-4]$/.test(e.key)) { e.preventDefault(); answer(+e.key); }
  };
  window.addEventListener("keydown", onKey);

  refresh();
  return {
    update: refresh,
    show() {
      refresh();
      status.set("tab", "");
    },
    destroy() { window.removeEventListener("keydown", onKey); },
  };
}
