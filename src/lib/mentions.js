// Unlinked mentions (like Obsidian's backlinks pane): other notes that name
// this note in plain text without linking it. One click turns a mention into
// a [[link]], which is how the graph grows from what you already wrote.

import { eachWikilink } from "./wikilinks.js";

const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Body with code, [[links]], URLs and the frontmatter-free markdown link
// targets blanked out (same length, so offsets still match the original).
function masked(body) {
  let s = body;
  const blank = (a, b) => { s = s.slice(0, a) + " ".repeat(b - a) + s.slice(b); };
  eachWikilink(body, (_, a, b) => blank(a - 2, b + 2));
  for (const re of [/```[\s\S]*?(```|$)/g, /~~~[\s\S]*?(~~~|$)/g, /`[^`\n]*`/g, /https?:\/\/\S+/g, /\]\([^)\n]*\)/g])
    for (const m of s.matchAll(re)) blank(m.index, m.index + m[0].length);
  return s;
}

export function namesOf(n) {
  const stem = (n.path || "").split("/").pop().replace(/\.md$/, "");
  const all = [n.title, stem, ...[].concat(n.aliases ?? [], n.alias ?? []).flatMap(x => String(x).split(","))];
  const seen = new Set();
  return all.map(x => String(x || "").trim()).filter(x => {
    const k = x.toLowerCase();
    // very short names ("Go", "C") would match everywhere
    if ([...x].length < 3 || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => b.length - a.length);
}

// [{ id, index, length, text, snippet, count }], one per note (its first mention).
export function unlinkedMentions(target, items, linksTo) {
  const names = namesOf(target);
  if (!names.length) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${names.map(reEsc).join("|")})(?![\\p{L}\\p{N}_])`, "giu");
  const out = [];
  for (const n of items) {
    if (n.id === target.id || n.type === "canvas" || !n.body || linksTo(n.id)) continue;
    const ms = [...masked(n.body).matchAll(re)];
    if (!ms.length) continue;
    const m = ms[0];
    const a = Math.max(0, m.index - 50), b = Math.min(n.body.length, m.index + m[0].length + 50);
    out.push({
      id: n.id, index: m.index, length: m[0].length, text: n.body.slice(m.index, m.index + m[0].length), count: ms.length,
      before: (a ? "…" : "") + n.body.slice(a, m.index).replace(/\s+/g, " ").trimStart(),
      after: n.body.slice(m.index + m[0].length, b).replace(/\s+/g, " ").trimEnd() + (b < n.body.length ? "…" : ""),
    });
  }
  return out;
}

// Turns the mention at [index, index+length) into a link to `linkName`
// (the target's file name), keeping the words as they were written.
export function linkMention(body, index, length, linkName) {
  const text = body.slice(index, index + length);
  const link = text === linkName ? `[[${text}]]` : `[[${linkName}|${text}]]`;
  return body.slice(0, index) + link + body.slice(index + length);
}
