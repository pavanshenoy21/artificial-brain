// Pure ranking helpers (no DOM), unit-tested in tests/.

// Subsequence match: every query char in order; bonus for word starts and runs.
export function fuzzy(text, q) {
  const t = text.toLowerCase();
  q = q.toLowerCase().replace(/\s+/g, " ").trim();
  if (!q) return { score: 0, hits: [] };
  let score = 0, ti = 0, prev = -2;
  const hits = [];
  for (const ch of q) {
    if (ch === " ") continue;
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    score += 1 + (i === prev + 1 ? 2 : 0) + (i === 0 || /[\s\-/]/.test(t[i - 1]) ? 3 : 0);
    hits.push(i);
    prev = i;
    ti = i + 1;
  }
  return { score: score - t.length * 0.02, hits };
}


// Merge keyword hits with semantic hits. Keyword scores are normalised to the
// best hit; an item found by both gets both. Semantic-only items need a decent score.
export function blend(keyword, sem, wSem = 0.45) {
  const out = new Map();
  const top = Math.max(1e-9, ...keyword.map(h => h.score));
  for (const h of keyword) out.set(h.id, { id: h.id, snippet: h.snippet, score: (1 - wSem) * (h.score / top) });
  for (const h of sem) {
    if (h.score < 0.35 && !out.has(h.id)) continue;
    const cur = out.get(h.id) || { id: h.id, snippet: "", score: 0 };
    cur.score += wSem * h.score;
    cur.semantic = true;
    out.set(h.id, cur);
  }
  return [...out.values()].sort((a, b) => b.score - a.score);
}

