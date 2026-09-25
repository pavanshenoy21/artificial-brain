// Inline #tags, mirroring markdown.rs::inline_tags (used by the mock backend),
// and the union of frontmatter + inline tags that every view should show.

export function inlineTags(body) {
  const out = [];
  let fence = false;
  for (const line of String(body || "").split("\n")) {
    const t = line.trimStart();
    if (t.startsWith("```") || t.startsWith("~~~")) { fence = !fence; continue; }
    if (fence) continue;
    const chars = [...line];
    let code = false;
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (c === "`") { code = !code; continue; }
      if (c !== "#" || code) continue;
      const prevOk = i === 0 || /\s/.test(chars[i - 1]) || "(,;\"'".includes(chars[i - 1]);
      let j = i + 1;
      while (j < chars.length && /[\p{L}\p{N}_\-/]/u.test(chars[j])) j++;
      const tag = chars.slice(i + 1, j).join("").replace(/[/-]+$/, "");
      if (prevOk && tag && !/^\d+$/.test(tag) && !out.includes(tag)) out.push(tag);
      i = Math.max(j - 1, i);
    }
  }
  return out;
}

// Frontmatter tags + inline #tags, deduplicated.
export const allTags = n => [...new Set([...(n?.tags || []), ...(n?.inline_tags || [])])];
