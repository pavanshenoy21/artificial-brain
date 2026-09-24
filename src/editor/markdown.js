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
