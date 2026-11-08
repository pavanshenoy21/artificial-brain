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
