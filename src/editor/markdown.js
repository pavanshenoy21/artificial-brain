// markdown-it with [[wikilinks]] rendered as internal links.
import MarkdownIt from "markdown-it";

export const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

md.inline.ruler.before("link", "wikilink", (state, silent) => {
  const src = state.src;
  let pos = state.pos;
  const embed = src.charCodeAt(pos) === 0x21 /* ! */;
  if (embed) pos++;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
  const end = src.indexOf("]]", pos + 2);
  if (end < 0) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner || /[\[\]\n]/.test(inner)) return false;
  if (!silent) {
    const [target, alias] = inner.split("|");
    const tok = state.push("wikilink", "", 0);
    tok.meta = { target: target.split(/[#^]/)[0].trim(), text: (alias || target).trim() };
  }
  state.pos = end + 2;
  return true;
});

// Resolved against the current items by the caller via md.resolveWikilink.
md.resolveWikilink = () => null;
md.renderer.rules.wikilink = (tokens, i) => {
  const { target, text } = tokens[i].meta;
  const id = md.resolveWikilink(target);
  const esc = md.utils.escapeHtml;
  return `<a href="#" class="wikilink${id ? "" : " unresolved"}" data-target="${esc(target)}"${id ? ` data-id="${esc(id)}"` : ""}>${esc(text)}</a>`;
};

// External links open in the system browser (handled by a click listener).
const defaultLinkOpen = md.renderer.rules.link_open || ((t, i, o, e, self) => self.renderToken(t, i, o));
md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
  tokens[i].attrSet("data-ext", "");
  return defaultLinkOpen(tokens, i, opts, env, self);
};

// Task lists: "- [ ] x" / "- [x] x" render as checkboxes. data-line is the
// source line, so the reading view can tick a task in the note.
md.core.ruler.after("inline", "tasks", state => {
  const toks = state.tokens;
  for (let i = 2; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== "inline" || toks[i - 1].type !== "paragraph_open" || toks[i - 2].type !== "list_item_open") continue;
    const m = /^\[([ xX])\](?:\s+|$)/.exec(t.content);
    if (!m) continue;
    const first = t.children[0];
    if (!first || first.type !== "text" || !/^\[[ xX]\]/.test(first.content)) continue;
    first.content = first.content.replace(/^\[[ xX]\]\s*/, "");
    const box = new state.Token("html_inline", "", 0);
    const line = t.map ? t.map[0] : -1;
    box.content = `<input type="checkbox" class="task-box" data-line="${line}"${m[1] === " " ? "" : " checked"} />`;
    t.children.unshift(box);
    toks[i - 2].attrJoin("class", `task-item${m[1] === " " ? "" : " done"}`);
  }
});

// Flashcard lines ("question :: answer"): one per line, with a visible separator.
md.core.ruler.after("tasks", "cards", state => {
  for (const t of state.tokens) {
    if (t.type !== "inline" || !/\s::\s/.test(t.content)) continue;
    const out = [];
    for (const c of t.children) {
      if (c.type === "softbreak") { out.push(new state.Token("hardbreak", "br", 0)); continue; }
      if (c.type !== "text" || !/\s::\s/.test(c.content)) { out.push(c); continue; }
      c.content.split(/\s::\s/).forEach((part, i) => {
        if (i) {
          const sep = new state.Token("html_inline", "", 0);
          sep.content = `<span class="card-sep" title="flashcard: question :: answer">::</span>`;
          out.push(sep);
        }
        const tx = new state.Token("text", "", 0);
        tx.content = part;
        out.push(tx);
      });
    }
    t.children = out;
  }
});
