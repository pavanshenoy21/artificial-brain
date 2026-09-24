// The mock backend must behave like the Rust store (same API, same link rules).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockBackend } from "../src/mock/backend.js";

test("sample seed: items and wikilink-derived links", async () => {
  const api = createMockBackend();
  const g = await api.loadGraph();
  assert.equal(g.nodes.length, 72);
  assert.equal(g.links.length, 69);
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
