// Unit tests for the pure frontend modules: `npm test` (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { wikilinks, renameWikilinks, fileStem, linkIndex, resolve } from "../src/lib/wikilinks.js";
import { fuzzy, blend } from "../src/lib/rank.js";
import { lobeCenters } from "../src/lib/lobes.js";

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

test("lobe centres are distinct and unsorted sits in the middle", () => {
  const c = lobeCenters([{ id: "x" }, { id: "y" }, { id: "z" }]);
  assert.deepEqual(c.get("unsorted"), [0, 0, 0]);
  const xy = ["x", "y", "z"].map(id => c.get(id).slice(0, 2).map(v => Math.round(v)).join());
  assert.equal(new Set(xy).size, 3);
});
