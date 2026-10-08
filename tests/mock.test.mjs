// The mock backend must behave like the Rust store (same API, same link rules).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockBackend } from "../src/mock/backend.js";

test("sample seed: items and wikilink-derived links", async () => {
  const api = createMockBackend();
  const g = await api.loadGraph();
  assert.equal(g.nodes.length, 73);
  assert.equal(g.links.length, 73); // 69 between notes + 4 from the sample canvas to the notes on it
  assert.equal(g.nodes.filter(n => n.type === "canvas").length, 1);
  assert.equal(g.lobes.length, 6);
});

test("create / rename rewrites links / delete", async () => {
  const api = createMockBackend({ seed: false });
  const a = await api.createItem({ title: "Alpha", body: "See [[Beta]]" });
  const b = await api.createItem({ title: "Beta", type: "skill" });
  assert.equal(b.path, "skills/Beta.md");
  let g = await api.loadGraph();
  assert.deepEqual(g.links, [{ source: a.id, target: b.id, kind: "explicit" }]);
  await api.updateItem(b.id, { title: "Gamma: two" });
  assert.equal((await api.getItem(a.id)).body, "See [[Gamma two]]");
  await api.deleteItem(b.id);
  g = await api.loadGraph();
  assert.equal(g.links.length, 0);
  await assert.rejects(api.createItem({ title: " " }));
  await assert.rejects(api.createItem({ title: "x", type: "nope" }));
});

test("search: prefix AND match, title first, snippet markers", async () => {
  const api = createMockBackend();
  const hits = await api.search("jw wri");
  const g = await api.loadGraph();
  assert.equal(g.nodes.find(n => n.id === hits[0].id).title, "Writeup: JWT none-alg bypass");
  const body = await api.search("nginx");
  assert.ok(body[0].snippet.includes("\u0001nginx\u0002"));
  assert.deepEqual(await api.search("   "), []);
});

test("frontmatter [[links]] (used_in) become graph links and follow renames", async () => {
  const api = createMockBackend({ seed: false });
  const p = await api.createItem({ type: "project", title: "Brain" });
  const s = await api.createItem({ type: "skill", title: "Rust", used_in: ["[[Brain]]"] });
  let g = await api.loadGraph();
  assert.deepEqual(g.links, [{ source: s.id, target: p.id, kind: "explicit" }]);
  await api.updateItem(p.id, { title: "Artificial Brain" });
  assert.deepEqual((await api.getItem(s.id)).used_in, ["[[Artificial Brain]]"]);
  g = await api.loadGraph();
  assert.equal(g.links.length, 1);
});

test("canvases: create, save, rename keeps links and file cards in step", async () => {
  const api = createMockBackend({ seed: false });
  const note = await api.createItem({ title: "Docker", type: "skill" });
  const c = await api.createCanvas("Board");
  assert.equal(c.id, "canvases/Board.canvas");
  assert.deepEqual(await api.getCanvas(c.id), { nodes: [], edges: [] });
  await api.saveCanvas(c.id, {
    nodes: [
      { id: "a", type: "text", text: "see [[Docker]]", x: 0, y: 0, width: 10, height: 10 },
      { id: "b", type: "file", file: note.path, x: 0, y: 0, width: 10, height: 10 },
    ],
    edges: [{ id: "e", fromNode: "a", toNode: "b" }],
  });
  await assert.rejects(api.saveCanvas(c.id, { nodes: [{ id: "x" }] }), /id and a type/);
  await assert.rejects(api.saveCanvas(c.id, { nodes: [], edges: [{ fromNode: "a", toNode: "z" }] }), /fromNode and toNode/);
  await assert.rejects(api.updateItem(c.id, { tags: ["x"] }), /only its name/);
  const other = await api.createItem({ title: "Index", body: "[[Board.canvas]]" });
  let g = await api.loadGraph();
  assert.ok(g.links.some(l => l.source === c.id && l.target === note.id));
  assert.ok(g.links.some(l => l.source === other.id && l.target === c.id));

  await api.updateItem(note.id, { title: "Containers" });
  const d = await api.getCanvas(c.id);
  assert.equal(d.nodes[1].file, "skills/Containers.md");
  assert.equal(d.nodes[0].text, "see [[Containers]]");

  const r = await api.updateItem(c.id, { title: "Sprint board" });
  assert.equal(r.id, "canvases/Sprint board.canvas");
  assert.equal((await api.getItem(other.id)).body, "[[Sprint board.canvas]]");
  g = await api.loadGraph();
  assert.ok(g.links.some(l => l.source === other.id && l.target === r.id));
});
