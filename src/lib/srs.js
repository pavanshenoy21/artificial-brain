// Flashcards written inside notes, reviewed with spaced repetition (SM-2).
//
//   What does `chmod 640` do? :: owner rw, group r, others nothing
//
// One card per line with " :: " (the Obsidian Spaced Repetition plugin's
// single-line syntax). The schedule lives in .brain/review.json, never in the
// note, so notes stay clean. A card is keyed by its note + question, so
// editing the answer keeps its history and moving lines around is fine.

import { addDays, today } from "./tasks.js";

const SEP = /\s::\s/;

export function parseCards(body) {
  const out = [];
  let fence = false;
  const all = (body || "").split("\n");
  for (let i = 0; i < all.length; i++) {
    const t = all[i].trim();
    if (t.startsWith("```") || t.startsWith("~~~")) { fence = !fence; continue; }
    if (fence || !SEP.test(t)) continue;
    // ignore the separator inside inline code
    if (/`[^`]*\s::\s[^`]*`/.test(t)) continue;
    const at = t.search(SEP);
    const q = t.slice(0, at).replace(/^(?:[-*+]|\d+[.)])\s+/, "").trim();
    const a = t.slice(at).replace(SEP, "").trim();
    if (q && a) out.push({ line: i, q, a });
  }
  return out;
}

// FNV-1a, 32 bit, hex: short stable ids for questions.
function hash(s) {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export const cardKey = (itemId, q) => `${itemId}#${hash(q.trim().toLowerCase().replace(/\s+/g, " "))}`;

// All cards in the vault: [{ key, id, q, a, line }]
export function allCards(items) {
  const out = [];
  const seen = new Set();
  for (const n of items) {
    if (n.type === "canvas") continue;
    for (const c of parseCards(n.body)) {
      const key = cardKey(n.id, c.q);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, id: n.id, ...c });
    }
  }
  return out;
}

export const GRADES = [
  { grade: 1, name: "Again", key: "1" },
  { grade: 2, name: "Hard", key: "2" },
  { grade: 3, name: "Good", key: "3" },
  { grade: 4, name: "Easy", key: "4" },
];

// Next state after answering. `s` is the previous state (undefined for a new card).
// Again → see it again this session and tomorrow; Hard/Good/Easy grow the gap.
export function schedule(s, grade, now = today()) {
  const prev = s || { interval: 0, ease: 2.5, reps: 0, lapses: 0 };
  let { interval, ease, reps, lapses } = prev;
  if (grade === 1) {
    reps = 0;
    lapses += s ? 1 : 0;
    ease = Math.max(1.3, ease - 0.2);
    interval = 1;
  } else {
    if (grade === 2) {
      interval = reps === 0 ? 1 : Math.max(interval + 1, Math.round(interval * 1.2));
      ease = Math.max(1.3, ease - 0.15);
    } else if (grade === 3) {
      interval = reps === 0 ? 1 : reps === 1 ? 3 : Math.max(interval + 1, Math.round(interval * ease));
    } else {
      interval = reps === 0 ? 4 : Math.max(interval + 1, Math.round(interval * ease * 1.3));
      ease += 0.15;
    }
    reps += 1;
  }
  interval = Math.min(interval, 3650);
  return { due: addDays(now, interval), interval, ease: Math.round(ease * 100) / 100, reps, lapses, last: now };
}

// "1d", "3d", "2w", "4mo", "1y"
export function spanLabel(days) {
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.round(days / 7)}w`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.round((days / 365) * 10) / 10}y`;
}

export const NEW_PER_DAY = 20;

// Cards to review now: due ones first (oldest due first), then up to the day's
// allowance of new ones, in note order.
export function queue(cards, state, now = today()) {
  const st = state?.cards || {};
  const due = cards.filter(c => st[c.key] && st[c.key].due <= now).sort((a, b) => st[a.key].due.localeCompare(st[b.key].due));
  const usedNew = state?.newDay === now ? state.newCount || 0 : 0;
  const fresh = cards.filter(c => !st[c.key]).slice(0, Math.max(0, NEW_PER_DAY - usedNew));
  return [...due, ...fresh];
}

export function nextDue(cards, state) {
  const st = state?.cards || {};
  return cards.map(c => st[c.key]?.due).filter(Boolean).sort()[0] || null;
}
