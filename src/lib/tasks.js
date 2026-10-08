// Markdown tasks ("- [ ] thing", "- [x] done") across the vault. Due dates are
// read the way common Obsidian setups write them: "📅 2026-10-12" (Tasks
// plugin), "due: 2026-10-12", "due 2026-10-12" or "@2026-10-12".

const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\](?:\s+|$))(.*)$/;
const DUE = /(?:📅\s*|\bdue:?\s+|@)(\d{4}-\d{2}-\d{2})\b/u;

// Lines inside ``` / ~~~ fences don't count.
function* lines(body) {
  let fence = false;
  const all = (body || "").split("\n");
  for (let i = 0; i < all.length; i++) {
    const t = all[i].trimStart();
    if (t.startsWith("```") || t.startsWith("~~~")) { fence = !fence; continue; }
    if (!fence) yield [i, all[i]];
  }
}

export function parseTasks(body) {
  const out = [];
  for (const [line, s] of lines(body)) {
    const m = TASK.exec(s.replace(/\r$/, ""));
    if (!m) continue;
    const raw = m[4].trim();
    const due = DUE.exec(raw)?.[1] || null;
    const text = raw.replace(DUE, "").replace(/\s{2,}/g, " ").trim();
    if (!text && !due) continue;
    out.push({ line, done: m[2] !== " ", text, due });
  }
  return out;
}

// Flips the checkbox on one line; anything else is left byte-for-byte alone.
export function toggleTask(body, line) {
  const all = body.split("\n");
  const m = TASK.exec((all[line] || "").replace(/\r$/, ""));
  if (!m) return body;
  const cr = all[line].endsWith("\r") ? "\r" : "";
  all[line] = all[line].slice(0, all[line].length - cr.length).replace(TASK, (_, a, mark, b, rest) => `${a}${mark === " " ? "x" : " "}${b}${rest}`) + cr;
  return all.join("\n");
}

export const today = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  return today(new Date(y, m - 1, d + n));
}

// "overdue" | "today" | "soon" (next 7 days) | "later" | "none"
export function dueBucket(due, now = today()) {
  if (!due) return "none";
  if (due < now) return "overdue";
  if (due === now) return "today";
  return due <= addDays(now, 7) ? "soon" : "later";
}

// Open tasks across items, soonest due first, undated last.
export function openTasks(items) {
  const out = [];
  for (const n of items) {
    if (n.type === "canvas") continue;
    for (const t of parseTasks(n.body)) if (!t.done) out.push({ ...t, id: n.id });
  }
  return out.sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.id.localeCompare(b.id) || a.line - b.line);
}
