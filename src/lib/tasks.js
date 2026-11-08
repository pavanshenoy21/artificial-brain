// Markdown tasks ("- [ ] thing", "- [x] done"): ticking a checkbox in the
// reading view or on a canvas flips that one character in the file.

const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\](?:\s+|$))(.*)$/;

// Flips the checkbox on one line; anything else is left byte-for-byte alone.
export function toggleTask(body, line) {
  const all = body.split("\n");
  const m = TASK.exec((all[line] || "").replace(/\r$/, ""));
  if (!m) return body;
  const cr = all[line].endsWith("\r") ? "\r" : "";
  all[line] = all[line].slice(0, all[line].length - cr.length).replace(TASK, (_, a, mark, b, rest) => `${a}${mark === " " ? "x" : " "}${b}${rest}`) + cr;
  return all.join("\n");
}

// Local date as YYYY-MM-DD (daily notes).
export const today = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  return today(new Date(y, m - 1, d + n));
}
