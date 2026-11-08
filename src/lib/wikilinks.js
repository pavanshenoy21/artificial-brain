// [[Wikilink]] helpers, mirroring src-tauri/src/markdown.rs so the mock
// backend and the UI resolve links exactly like the Rust side.

const RE = /!?\[\[([^\[\]\n]+?)\]\]/g;

// Target of a link body: strips |alias, #heading and ^block.
export const linkTarget = inner => inner.split(/[|#^]/)[0].trim();

// Calls fn(inner, start, end) for every [[...]] outside code fences / inline code.
// start/end are offsets of the inner text in `text`.
export function eachWikilink(text, fn) {
  let offset = 0;
  let fence = false;
  for (const line of text.split(/(?<=\n)/)) {
    const t = line.trimStart();
    if (t.startsWith("```") || t.startsWith("~~~")) fence = !fence;
    else if (!fence) {
      // blank out inline code so links inside it don't match
      const masked = line.replace(/`[^`]*`/g, m => " ".repeat(m.length));
      for (const m of masked.matchAll(RE)) {
        const s = offset + m.index + m[0].indexOf("[[") + 2;
        fn(line.substr(m.index + m[0].indexOf("[[") + 2, m[1].length), s, s + m[1].length);
      }
    }
    offset += line.length;
  }
}

export function wikilinks(text) {
  const out = [];
  eachWikilink(text || "", inner => {
    const t = linkTarget(inner);
    if (t && !out.includes(t)) out.push(t);
  });
  return out;
}

// [[old]] → [[new]], keeping #heading / |alias. Case-insensitive.
export function renameWikilinks(text, oldName, newName) {
  let out = "";
  let last = 0;
  eachWikilink(text, (inner, s, e) => {
    const t = linkTarget(inner);
    if (t.toLowerCase() !== oldName.toLowerCase()) return;
    out += text.slice(last, s) + newName + inner.slice(inner.indexOf(t) + t.length);
    last = e;
  });
  return out + text.slice(last);
}

// Same rules as markdown::file_stem_for.
export function fileStem(title) {
  let s = title.replace(/[\/\\:*?"<>|#^\[\]\p{Cc}]/gu, " ").split(/\s+/).filter(Boolean).join(" ");
  s = s.replace(/^[.\s]+|[.\s]+$/g, "");
  if ([...s].length > 120) s = [...s].slice(0, 120).join("").trimEnd();
  return s || "Untitled";
}

// Lookup of lowercase file name / path (".md" dropped) / alias -> path, the
// same rules as index.rs: when two files share a name, a bare [[Name]] goes
// to the one nearest the vault root; a real file name beats an alias.
export function linkIndex(items) {
  const m = new Map();
  for (const it of items)
    for (const a of [].concat(it.props?.aliases ?? [], it.props?.alias ?? []).flatMap(x => String(x).split(",")))
      if (a.trim()) m.set(a.trim().toLowerCase(), it.id);
  const depth = p => p.split("/").length;
  const paths = items.map(it => it.path || it.id).filter(Boolean)
    .sort((a, b) => depth(b) - depth(a) || (b < a ? -1 : b > a ? 1 : 0));
  for (const p of paths) {
    const noExt = p.replace(/\.md$/, "");
    m.set(noExt.toLowerCase(), p);
    m.set(noExt.split("/").pop().toLowerCase(), p);
  }
  return m;
}

export function resolve(index, target) {
  return index.get(target.trim().replace(/\.md$/, "").toLowerCase());
}
