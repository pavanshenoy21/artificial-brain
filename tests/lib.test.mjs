// Unit tests for the pure frontend modules: `npm test` (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { wikilinks, renameWikilinks, fileStem, linkIndex, resolve } from "../src/lib/wikilinks.js";
import { fuzzy } from "../src/lib/rank.js";
import { colorScheme, lobeCenters, lobeOf, groupOf, folderOf, LOBE_PALETTE, GROUP_PALETTE } from "../src/lib/folders.js";
import { toggleTask, addDays, today } from "../src/lib/tasks.js";
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

test("link index resolves like Obsidian: file name, path, aliases; shallowest wins", () => {
  const n = (path, props) => ({ id: path, path, title: path.split("/").pop().replace(/\.md$/, ""), props });
  const idx = linkIndex([n("CTF/Writeup JWT.md"), n("Skills/B.md"), n("Commands/Git.md", { aliases: ["git cheatsheet"] }), n("B2.md", { alias: "Git" })]);
  assert.equal(resolve(idx, "Writeup JWT"), "CTF/Writeup JWT.md");
  assert.equal(resolve(idx, "skills/b"), "Skills/B.md");
  assert.equal(resolve(idx, "B.md"), "Skills/B.md");
  assert.equal(resolve(idx, "nope"), undefined);
  assert.equal(resolve(idx, "Git cheatsheet"), "Commands/Git.md");
  assert.equal(resolve(idx, "git"), "Commands/Git.md", "a real file name beats another note's alias");
  const dup = linkIndex([n("X/Y/Dup.md"), n("X/Dup.md")]);
  assert.equal(resolve(dup, "Dup"), "X/Dup.md");
  assert.equal(resolve(dup, "X/Y/Dup"), "X/Y/Dup.md");
});

test("folders: lobes, groups and colours (picked or from the palettes)", () => {
  assert.equal(lobeOf("Coding Club/CTF/Writeup.md"), "Coding Club");
  assert.equal(lobeOf("Root.md"), null);
  assert.equal(groupOf("Coding Club/CTF/2026/Writeup.md"), "Coding Club/CTF");
  assert.equal(groupOf("Coding Club/Overview.md"), null);
  assert.equal(folderOf("A/B/c.md"), "A/B");
  const folders = ["Coding Club", "Coding Club/CTF", "Coding Club/CTF/2026", "Coding Club/Hackathons", "College", "College/Sem 3"];
  const c = colorScheme(folders, { folders: { "Coding Club/Hackathons": "#123456" } }, "#888");
  assert.equal(c.lobe("Coding Club"), LOBE_PALETTE[0]);
  assert.equal(c.lobe("College"), LOBE_PALETTE[1]);
  assert.equal(c.note("Coding Club/CTF/Writeup.md"), GROUP_PALETTE[0]);
  assert.equal(c.note("Coding Club/CTF/2026/Deep.md"), GROUP_PALETTE[0], "deeper folders inherit their group's colour");
  assert.equal(c.note("Coding Club/Hackathons/Hack night.md"), "#123456", "picked colours win");
  assert.notEqual(c.note("College/Sem 3/OS.md"), c.note("Coding Club/CTF/x.md"), "groups never share an automatic colour");
  assert.equal(c.note("Coding Club/Overview.md"), LOBE_PALETTE[0], "loose notes in a lobe take its colour");
  assert.equal(c.note("Root.md"), "#888");
  assert.equal(c.picked("Coding Club/Hackathons"), "#123456");
  assert.equal(c.picked("College"), null);
});

test("lobe centres fill a disc: biggest lobe in the middle, all distinct", () => {
  const counts = new Map([["Big", 30], ["Mid", 10], ["Small", 2], ["", 1]]);
  const c = lobeCenters(["Small", "Big", "Mid", ""], counts);
  assert.deepEqual(c.get("Big").slice(0, 2), [0, 0]);
  const keys = [...c.values()].map(v => v.slice(0, 2).map(x => x.toFixed(1)).join(","));
  assert.equal(new Set(keys).size, 4);
  const r = id => Math.hypot(c.get(id)[0], c.get(id)[1]);
  assert.ok(r("Mid") < r("Small"));
});

test("tasks: toggling flips only the checkbox", () => {
  const body = "Intro\n- [ ] OS assignment\n  * [x] read ch. 3\n1. [ ] lab record";
  assert.equal(toggleTask(body, 1).split("\n")[1], "- [x] OS assignment");
  assert.equal(toggleTask(toggleTask(body, 1), 1), body);
  assert.equal(toggleTask(body, 2).split("\n")[2], "  * [ ] read ch. 3");
  assert.equal(toggleTask(body, 0), body, "non-task lines are left alone");
  assert.equal(toggleTask("- [ ] a\r\n- [ ] b", 0), "- [x] a\r\n- [ ] b", "CRLF kept");
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
});

test("fuzzy: subsequence with word-start bonus", () => {
  assert.equal(fuzzy("Toggle 2D / 3D graph", "xyz"), null);
  const a = fuzzy("Toggle 2D / 3D graph", "tog 2d");
  const b = fuzzy("Show tags", "tog 2d");
  assert.ok(a && !b);
  assert.ok(fuzzy("New note", "nn").score > fuzzy("Clear graph focus", "nn")?.score || !fuzzy("Clear graph focus", "nn"));
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

test("unlinked mentions: whole words, not in links or code; linking keeps the text", () => {
  const target = { id: "d", title: "Docker", path: "skills/Docker.md", props: { aliases: ["containers"] } };
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
