import { allTags } from "../lib/tags.js";

// Stand-in for embedding similarity (used when no embedding server is set):
// items that share tags get a faint "similar" link (top 2 per item), skipping
// pairs already linked.
//
// Built from a tag -> items index, so cost follows actual overlaps instead of
// comparing every pair. Tags on a large share of the vault (e.g. #todo on half
// the notes) say little about similarity and would make it quadratic again,
// so they're ignored. The result is cached until tags or links change.

const PER_ITEM = 2;
const MAX_TAG_SHARE = 0.15;   // ignore tags on more than 15% of items...
const MIN_TAG_CAP = 40;       // ...but never ignore a tag used by 40 or fewer

let cache = { key: "", links: [] };

export function similarityLinks(nodes, links) {
  const key = nodes.map(n => n.id + ":" + allTags(n).join(",")).join("|") + "#" + links.map(l => l.source + ">" + l.target).join("|");
  if (key === cache.key) return cache.links;

  const tagsOf = new Map(nodes.map(n => [n.id, allTags(n)]));
  const members = new Map();
  for (const [id, tags] of tagsOf) for (const t of tags) {
    if (!members.has(t)) members.set(t, []);
    members.get(t).push(id);
  }
  const cap = Math.max(MIN_TAG_CAP, Math.floor(nodes.length * MAX_TAG_SHARE));
  const has = new Set(links.map(l => [l.source, l.target].sort().join("|")));
  const out = [];

  for (const a of nodes) {
    const shared = new Map(); // other id -> number of shared tags
    for (const t of tagsOf.get(a.id)) {
      const m = members.get(t);
      if (m.length > cap) continue;
      for (const b of m) if (b !== a.id) shared.set(b, (shared.get(b) || 0) + 1);
    }
    const best = [...shared].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, PER_ITEM);
    for (const [b] of best) {
      const k = [a.id, b].sort().join("|");
      if (has.has(k)) continue;
      has.add(k);
      out.push({ source: a.id, target: b, kind: "similar" });
    }
  }
  cache = { key, links: out };
  return out;
}
