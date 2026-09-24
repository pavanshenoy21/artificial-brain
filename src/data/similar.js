// Stand-in for embedding similarity until step 3: nodes that share tags get a
// faint "similar" link (top 2 per node), skipping pairs already linked.
export function similarityLinks(nodes, links) {
  const has = new Set(links.map(l => [l.source, l.target].sort().join("|")));
  const out = [];
  for (const a of nodes) {
    const scored = nodes
      .filter(b => b !== a)
      .map(b => ({ b, s: b.tags.filter(t => a.tags.includes(t)).length }))
      .filter(x => x.s > 0)
      .sort((x, y) => y.s - x.s || x.b.id.localeCompare(y.b.id))
      .slice(0, 2);
    for (const { b } of scored) {
      const key = [a.id, b.id].sort().join("|");
      if (has.has(key)) continue;
      has.add(key);
      out.push({ source: a.id, target: b.id, kind: "similar" });
    }
  }
  return out;
}
