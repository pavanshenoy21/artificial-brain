// CodeMirror 6 markdown editor: wikilink highlighting, [[ autocomplete,
// Ctrl/Cmd+click to follow a link. Styled from theme.css variables.

import { EditorView, keymap, drawSelection, highlightActiveLine, placeholder, Decoration, MatchDecorator, ViewPlugin } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.45em", fontWeight: "700" },
  { tag: t.heading2, fontSize: "1.25em", fontWeight: "700" },
  { tag: t.heading3, fontSize: "1.1em", fontWeight: "600" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "600" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--accent)" },
  { tag: t.monospace, fontFamily: "var(--mono)", fontSize: "0.9em" },
  { tag: [t.processingInstruction, t.meta, t.punctuation, t.contentSeparator], color: "var(--faint)" },
  { tag: t.quote, color: "var(--muted)" },
  { tag: t.list, color: "var(--muted)" },
]);

const theme = EditorView.theme({
  "&": { color: "var(--text)", backgroundColor: "transparent", fontSize: "15px", height: "100%" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font)", lineHeight: "1.65", overflow: "visible" },
  ".cm-content": { padding: "0 0 40vh", caretColor: "var(--text)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent-soft) !important" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-placeholder": { color: "var(--faint)" },
  ".cm-wikilink": { color: "var(--accent)" },
  ".cm-wikilink.unresolved": { color: "var(--muted)", textDecoration: "underline dotted" },
  ".cm-selectionMatch": { backgroundColor: "var(--bg-active)" },
  ".cm-tooltip": { backgroundColor: "var(--bg-raised)", border: "1px solid var(--border-strong)", borderRadius: "5px", boxShadow: "var(--shadow-pop)" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font)", maxHeight: "260px" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "3px 8px !important" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--bg-active)", color: "var(--text)" },
  ".cm-completionDetail": { color: "var(--faint)", fontStyle: "normal", marginLeft: "8px" },
  ".cm-panels": { backgroundColor: "var(--bg-side)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-panel input, .cm-panel button": { fontSize: "12px" },
  ".cm-searchMatch": { backgroundColor: "var(--accent-soft)" },
});

const WIKI_RE = /!?\[\[([^\[\]\n]+?)\]\]/g;
const targetOf = inner => inner.split(/[|#^]/)[0].trim();

function wikilinkDecorations(resolve) {
  const deco = new MatchDecorator({
    regexp: WIKI_RE,
    decoration: m => Decoration.mark({ class: `cm-wikilink${resolve(targetOf(m[1])) ? "" : " unresolved"}` }),
  });
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = deco.createDeco(view); }
    update(u) { this.decorations = deco.updateDeco(u, this.decorations); }
  }, { decorations: v => v.decorations });
}

// The [[wikilink]] under a document position, if any.
export function wikilinkAt(state, pos) {
  const line = state.doc.lineAt(pos);
  for (const m of line.text.matchAll(WIKI_RE)) {
    const from = line.from + m.index, to = from + m[0].length;
    if (pos >= from && pos <= to) return targetOf(m[1]);
  }
  return null;
}

/**
 * @param {object} o
 * @param {HTMLElement} o.parent
 * @param {string} o.doc
 * @param {(doc: string) => void} o.onChange
 * @param {(target: string) => void} o.onFollow     Ctrl/Cmd+click or Ctrl+Enter on a wikilink
 * @param {(target: string) => string|undefined} o.resolve
 * @param {() => {label: string, apply: string, detail?: string}[]} o.linkOptions
 */
export function createEditor({ parent, doc, onChange, onFollow, resolve, linkOptions }) {
  const wikiComplete = ctx => {
    const before = ctx.matchBefore(/\[\[[^\[\]\n|]*$/);
    if (!before) return null;
    const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
    return {
      from: before.from + 2,
      validFor: /^[^\[\]\n|]*$/,
      options: linkOptions().map(o => ({
        label: o.label,
        detail: o.detail,
        type: "text",
        apply: (view, _c, from, to) => {
          const insert = o.apply + (after === "]]" ? "" : "]]");
          view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length + (after === "]]" ? 2 : 0) } });
        },
      })),
    };
  };

  let external = false; // true while applying a change that came from outside
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(highlight),
        autocompletion({ override: [wikiComplete], icons: false }),
        wikilinkDecorations(resolve),
        placeholder("Start writing. [[ links to another item."),
        theme,
        keymap.of([
          { key: "Mod-Enter", run: v => { const tg = wikilinkAt(v.state, v.state.selection.main.head); if (tg) { onFollow(tg); return true; } return false; } },
          ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap, indentWithTab,
        ]),
        EditorView.updateListener.of(u => { if (u.docChanged && !external) onChange(u.state.doc.toString()); }),
        EditorView.domEventHandlers({
          mousedown(e, v) {
            if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
            const tg = pos != null && wikilinkAt(v.state, pos);
            if (!tg) return false;
            e.preventDefault();
            onFollow(tg);
            return true;
          },
        }),
      ],
    }),
  });

  return {
    view,
    get value() { return view.state.doc.toString(); },
    // Replace the whole text (external change) keeping the cursor where it can.
    setValue(text) {
      if (text === view.state.doc.toString()) return;
      const head = Math.min(view.state.selection.main.head, text.length);
      external = true;
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: head } });
      } finally {
        external = false;
      }
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
