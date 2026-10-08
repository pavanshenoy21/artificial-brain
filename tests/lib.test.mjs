// Unit tests for the pure frontend modules: `npm test` (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { wikilinks, renameWikilinks, fileStem, linkIndex, resolve } from "../src/lib/wikilinks.js";
import { fuzzy, blend } from "../src/lib/rank.js";
import { lobeCenters } from "../src/lib/lobes.js";
import { anchor, nearestSide, facingSide, edgePath, fitView, bounds, inside, drawOrder, normalize, colorOf } from "../src/canvas/model.js";

test("wikilinks: targets, aliases, headings, code is skipped", () => {
  const body = "See [[Foo]] and [[Bar|the bar]], ![[Baz#Part]].\n`[[Nope]]`\n```\n[[AlsoNope]]\n```\n[[Foo]]";
  assert.deepEqual(wikilinks(body), ["Foo", "Bar", "Baz"]);
});

test("renameWikilinks keeps alias and heading, matches case-insensitively", () => {
  const body = "[[old note]] and [[Old Note|alias]] and [[Old Note#h]] but not [[Other]] or `[[Old Note]]`";
  assert.equal(renameWikilinks(body, "Old Note", "New"), "[[New]] and [[New|alias]] and [[New#h]] but not [[Other]] or `[[Old Note]]`");
});

test("fileStem matches the Rust rules", () => {
  assert.equal(fileStem("Writeup: JWT none-alg bypass"), "Writeup JWT none-alg bypass");
  assert.equal(fileStem("HTML / CSS / JavaScript"), "HTML CSS JavaScript");
  assert.equal(fileStem("  ..  "), "Untitled");
});

test("link index resolves by title, file name and path", () => {
  const idx = linkIndex([
    { id: "a", title: "Writeup: JWT", path: "notes/Writeup JWT.md" },
    { id: "b", title: "B", path: "skills/B.md" },
  ]);
  assert.equal(resolve(idx, "writeup: jwt"), "a");
  assert.equal(resolve(idx, "Writeup JWT"), "a");
  assert.equal(resolve(idx, "skills/B"), "b");
  assert.equal(resolve(idx, "B.md"), "b");
  assert.equal(resolve(idx, "nope"), undefined);
  const withAlias = linkIndex([{ id: "g", title: "Git", path: "Commands/Git.md", aliases: ["git cheatsheet"] }, { id: "b", title: "B", path: "B.md", alias: "Git" }]);
  assert.equal(resolve(withAlias, "Git cheatsheet"), "g");
  assert.equal(resolve(withAlias, "git"), "g", "a real title beats another note's alias");
});

test("fuzzy: subsequence with word-start bonus", () => {
  assert.equal(fuzzy("Toggle 2D / 3D graph", "xyz"), null);
  const a = fuzzy("Toggle 2D / 3D graph", "tog 2d");
  const b = fuzzy("Show tags", "tog 2d");
  assert.ok(a && !b);
  assert.ok(fuzzy("New note", "nn").score > fuzzy("Clear graph focus", "nn")?.score || !fuzzy("Clear graph focus", "nn"));
});

test("blend: both signals beat one; weak semantic-only hits are dropped", () => {
  const out = blend(
    [{ id: "a", score: 10, snippet: "" }, { id: "b", score: 9, snippet: "" }],
    [{ id: "b", score: 0.9 }, { id: "c", score: 0.8 }, { id: "d", score: 0.1 }],
  );
  assert.deepEqual(out.map(x => x.id), ["b", "a", "c"]);
});

test("lobe centres fill a disc: biggest lobe in the middle, all distinct", () => {
  const lobes = Array.from({ length: 12 }, (_, i) => ({ id: `l${i}` }));
  const counts = new Map(lobes.map((l, i) => [l.id, i + 1]));
  const c = lobeCenters(lobes, counts);
  assert.deepEqual(c.get("l11").slice(0, 2), [0, 0], "largest at the centre");
  const r = id => Math.hypot(...c.get(id).slice(0, 2));
  assert.ok(r("l10") < r("l0"), "bigger lobes closer to the middle");
  const xy = [...c.values()].map(p => p.slice(0, 2).map(Math.round).join());
  assert.equal(new Set(xy).size, 13, "12 lobes + Unsorted, no overlaps");
  for (const a of c.values()) for (const b of c.values())
    if (a !== b) assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) > 30, "centres keep some room");
});

test("tag similarity stays fast on a big vault and skips pairs already linked", async () => {
  const { similarityLinks } = await import("../src/data/similar.js");
  const nodes = Array.from({ length: 3000 }, (_, i) => ({ id: `n${i}`, tags: [`t${i % 150}`, `t${(i * 7) % 150}`, "common"], inline_tags: [] }));
  const t0 = performance.now();
  const out = similarityLinks(nodes, [{ source: "n0", target: "n150" }]);
  assert.ok(performance.now() - t0 < 1500, `took ${performance.now() - t0}ms`);
  assert.ok(out.length > 0 && out.length <= 6000);
  assert.ok(!out.some(l => [l.source, l.target].sort().join() === "n0,n150"));
  assert.equal(similarityLinks(nodes, [{ source: "n0", target: "n150" }]), out, "cached when nothing changed");
});


test("canvas geometry: anchors, sides, edges, fitting", () => {
  const a = { x: 0, y: 0, width: 100, height: 50 }, b = { x: 300, y: 0, width: 100, height: 50 };
  assert.deepEqual(anchor(a, "right"), { x: 100, y: 25 });
  assert.deepEqual(anchor(a, "top"), { x: 50, y: 0 });
  assert.equal(nearestSide(b, { x: 290, y: 30 }), "left");
  assert.equal(facingSide(a, { x: 350, y: 25 }), "right");
  const g = edgePath(a, undefined, b, undefined);
  assert.ok(g.d.startsWith("M100,25 C"));
  assert.deepEqual(g.end, { x: 300, y: 25 });
  assert.ok(g.endDir.x > 0.99, "arrow points right, into b");
  assert.ok(Math.abs(g.mid.x - 200) < 1e-9);
  const r = bounds([a, b]);
  assert.deepEqual(r, { x: 0, y: 0, width: 400, height: 50 });
  const cam = fitView(r, 520, 400, 60);
  assert.equal(cam.z, 1); // fits at 100%, never zooms in past it
  assert.equal(cam.x, 260 - 200);
  assert.ok(fitView(r, 300, 400, 60).z < 1);
});

test("canvas model: groups, order, normalize, colours", () => {
  const g = { id: "g", type: "group", x: 0, y: 0, width: 500, height: 500 };
  const big = { id: "G", type: "group", x: -10, y: -10, width: 900, height: 900 };
  const t = { id: "t", type: "text", x: 10, y: 10, width: 100, height: 100 };
  assert.ok(inside(t, g) && !inside(g, t) && !inside(g, g));
  assert.deepEqual(drawOrder([t, g, big]).map(n => n.id), ["G", "g", "t"]);
  const d = normalize({ nodes: [{ id: "a", type: "text", x: "4.6", width: -1 }], edges: [{ id: "e", fromNode: "a", toNode: "gone" }], extra: 1 });
  assert.deepEqual(d.nodes[0], { id: "a", type: "text", x: 5, y: 0, width: 250, height: 60 });
  assert.deepEqual(d.edges, []);
  assert.equal(d.extra, 1);
  assert.equal(colorOf("4"), "#46a758");
  assert.equal(colorOf("#abc"), "#abc");
  assert.equal(colorOf("nope"), null);
});
