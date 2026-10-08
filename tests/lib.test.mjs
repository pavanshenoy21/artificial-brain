// Unit tests for the pure frontend modules: `npm test` (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { wikilinks, renameWikilinks, fileStem, linkIndex, resolve } from "../src/lib/wikilinks.js";
import { fuzzy, blend } from "../src/lib/rank.js";
import { lobeCenters } from "../src/lib/lobes.js";
import { parseTasks, toggleTask, dueBucket, addDays, openTasks } from "../src/lib/tasks.js";
import { parseCards, cardKey, schedule, queue, allCards, spanLabel } from "../src/lib/srs.js";
import { unlinkedMentions, linkMention, namesOf } from "../src/lib/mentions.js";
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

test("tasks: parse, due dates, toggle only the checkbox", () => {
  const body = "Intro\n- [ ] OS assignment 📅 2026-10-10\n  * [x] read ch. 3\n1. [ ] lab record due: 2026-10-08\n```\n- [ ] not a task\n```\n- [ ]\n- [ ] call @2026-11-01 mom";
  const t = parseTasks(body);
  assert.deepEqual(t.map(x => [x.line, x.done, x.text, x.due]), [
    [1, false, "OS assignment", "2026-10-10"],
    [2, true, "read ch. 3", null],
    [3, false, "lab record", "2026-10-08"],
    [8, false, "call mom", "2026-11-01"],
  ]);
  const flipped = toggleTask(body, 1);
  assert.equal(flipped.split("\n")[1], "- [x] OS assignment 📅 2026-10-10");
  assert.equal(toggleTask(flipped, 1), body);
  assert.equal(toggleTask(body, 0), body, "non-task lines are left alone");
  assert.equal(toggleTask("- [ ] a\r\n- [ ] b", 0), "- [x] a\r\n- [ ] b", "CRLF kept");
  assert.equal(dueBucket("2026-10-07", "2026-10-08"), "overdue");
  assert.equal(dueBucket("2026-10-08", "2026-10-08"), "today");
  assert.equal(dueBucket("2026-10-15", "2026-10-08"), "soon");
  assert.equal(dueBucket("2026-12-01", "2026-10-08"), "later");
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
  const open = openTasks([{ id: "a", type: "note", body }, { id: "c", type: "canvas", body: "- [ ] x" }]);
  assert.deepEqual(open.map(x => x.text), ["lab record", "OS assignment", "call mom"]);
});

test("flashcards: parse, keys, SM-2 schedule, queue", () => {
  const body = "# OS\n- What is a page fault? :: access to a page not in RAM\nplain line\n`a :: b` in code\n```\nx :: y\n```\nEmpty :: \nTCP vs UDP? :: reliable stream vs datagrams";
  const cards = parseCards(body);
  assert.deepEqual(cards.map(c => [c.line, c.q, c.a]), [[1, "What is a page fault?", "access to a page not in RAM"], [8, "TCP vs UDP?", "reliable stream vs datagrams"]]);
  assert.equal(cardKey("n1", "TCP vs UDP?"), cardKey("n1", "  tcp  vs udp? "));
  assert.notEqual(cardKey("n1", "TCP vs UDP?"), cardKey("n2", "TCP vs UDP?"));

  const now = "2026-10-08";
  let s = schedule(undefined, 3, now);
  assert.deepEqual([s.interval, s.due, s.reps], [1, "2026-10-09", 1]);
  s = schedule(s, 3, "2026-10-09");
  assert.equal(s.interval, 3);
  s = schedule(s, 3, "2026-10-12");
  assert.equal(s.interval, 8); // 3 * 2.5 rounded
  const lapse = schedule(s, 1, "2026-10-20");
  assert.deepEqual([lapse.interval, lapse.reps, lapse.lapses], [1, 0, 1]);
  assert.ok(lapse.ease < s.ease);
  assert.equal(schedule(undefined, 4, now).interval, 4);
  assert.ok(schedule(s, 4, now).interval > schedule(s, 3, now).interval);
  assert.ok(schedule(s, 2, now).interval < schedule(s, 3, now).interval);
  assert.equal(spanLabel(3), "3d");
  assert.equal(spanLabel(30), "4w");
  assert.equal(spanLabel(400), "1.1y");

  const all = allCards([{ id: "n", type: "note", body }]);
  const st = { cards: { [all[0].key]: { due: "2026-10-01" } } };
  assert.deepEqual(queue(all, st, now).map(c => c.q), ["What is a page fault?", "TCP vs UDP?"]);
  assert.deepEqual(queue(all, { cards: { [all[0].key]: { due: "2026-10-30" } }, newDay: now, newCount: 20 }, now), []);
});

test("unlinked mentions: whole words, not in links or code; linking keeps the text", () => {
  const target = { id: "d", title: "Docker", path: "skills/Docker.md", aliases: ["containers"] };
  const items = [
    target,
    { id: "a", body: "We ran docker compose and Docker again." },
    { id: "b", body: "Already [[Docker]] linked, docker." },
    { id: "c", body: "dockerfile and `docker ps` and https://docker.com/x and [x](https://docker.io)" },
    { id: "e", body: "Spin up containers per team." },
  ];
  const out = unlinkedMentions(target, items, id => id === "b");
  assert.deepEqual(out.map(m => [m.id, m.text, m.count]), [["a", "docker", 2], ["e", "containers", 1]]);
  const a = out[0];
  assert.equal(linkMention(items[1].body, a.index, a.length, "Docker"), "We ran [[Docker|docker]] compose and Docker again.");
  assert.equal(linkMention("Use Docker.", 4, 6, "Docker"), "Use [[Docker]].");
  assert.deepEqual(namesOf({ title: "Go", path: "notes/Go.md" }), []);
});
