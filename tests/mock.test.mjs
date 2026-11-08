// The browser preview's mock backend must behave like the Rust store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockBackend } from "../src/mock/backend.js";

test("sample vault: folders, notes, a canvas and wikilink-derived links", async () => {
  const api = createMockBackend();
  const g = await api.loadGraph();
  assert.equal(g.nodes.filter(n => n.type === "canvas").length, 1);
  assert.ok(g.nodes.length > 30);
  assert.ok(g.folders.includes("Coding Club") && g.folders.includes("Coding Club/CTF"));
  assert.ok(g.links.some(l => l.source === "Coding Club/CTF/CTFd setup.md" && l.target === "Learning/Linux/Docker.md"));
  const hack = g.nodes.find(n => n.id === "Coding Club/Hackathons/Hack Night 2026.md");
  assert.deepEqual(hack.props, { date: "2026-03-14", role: "Builder" });
  assert.deepEqual(hack.inline_tags, ["hackathon"]);
});

test("notes: Untitled names, folders, rename rewrites links", async () => {
  const api = createMockBackend({ seed: false });
  const a = await api.createItem({});
  const b = await api.createItem({});
  assert.deepEqual([a.id, b.id], ["Untitled.md", "Untitled 1.md"]);
  const docker = await api.createItem({ title: "Docker", folder: "Tools" });
  const n = await api.createItem({ title: "A", body: "[[Docker]] [[Docker#Volumes|vols]] [[Tools/Docker]]" });
  await assert.rejects(api.createItem({ folder: "../x" }), /bad path/);
  const r = await api.updateItem(docker.id, { title: "Containers" });
  assert.equal(r.id, "Tools/Containers.md");
  assert.equal((await api.getItem(n.id)).body, "[[Containers]] [[Containers#Volumes|vols]] [[Tools/Containers]]");
  const g = await api.loadGraph();
  assert.deepEqual(g.links, [{ source: "A.md", target: "Tools/Containers.md" }]);
  await api.updateItem(n.id, { tags: ["x"], props: { status: "draft" } });
  assert.deepEqual((await api.getItem(n.id)).props, { status: "draft" });
  await api.updateItem(n.id, { props: { status: null } });
  assert.deepEqual((await api.getItem(n.id)).props, {});
  await assert.rejects(api.updateItem(n.id, { status: "x" }), /props/);
  await api.deleteItem(n.id);
  assert.equal(await api.getItem(n.id), null);
});

test("folders: create, rename/move with links and colours, move files, delete", async () => {
  const api = createMockBackend({ seed: false });
  await api.createFolder("Uni/Empty");
  await assert.rejects(api.createFolder("Uni/Empty"), /exists/);
  const os = await api.createItem({ title: "OS", folder: "Uni/Sem 3" });
  const idx = await api.createItem({ title: "Index", body: "[[Uni/Sem 3/OS]] and [[OS]]" });
  await api.setFolderColor("Uni/Sem 3", "#E06C75");
  assert.deepEqual((await api.loadGraph()).folders, ["Uni", "Uni/Empty", "Uni/Sem 3"]);
  const moved = await api.renameFolder("Uni/Sem 3", "College/Sem 3");
  assert.deepEqual(moved, [[os.id, "College/Sem 3/OS.md"]]);
  assert.equal((await api.getItem(idx.id)).body, "[[College/Sem 3/OS]] and [[OS]]");
  assert.equal((await api.loadGraph()).colors.folders["College/Sem 3"], "#e06c75");
  await assert.rejects(api.renameFolder("College", "College/in"), /itself/);
  assert.deepEqual(await api.moveItem("College/Sem 3/OS.md", ""), [["College/Sem 3/OS.md", "OS.md"]]);
  assert.equal((await api.getItem(idx.id)).body, "[[OS]] and [[OS]]");
  await api.deleteFolder("Uni");
  assert.ok(!(await api.loadGraph()).folders.some(f => f.startsWith("Uni")));
  await assert.rejects(api.setFolderColor("College", "red"), /not a colour/);
});

test("search: prefix AND match, file name first, snippet markers", async () => {
  const api = createMockBackend();
  const hits = await api.search("chall des");
  assert.equal(hits[0].id, "Coding Club/CTF/Challenge design checklist.md");
  assert.ok((await api.search("volume"))[0].snippet.includes("\u0001"));
  assert.deepEqual(await api.search("   "), []);
});

test("canvases: create in a folder, save, rename keeps links and file cards in step", async () => {
  const api = createMockBackend({ seed: false });
  const note = await api.createItem({ title: "Docker" });
  const c = await api.createCanvas("Board", "Plans");
  assert.equal(c.id, "Plans/Board.canvas");
  assert.deepEqual(await api.getCanvas(c.id), { nodes: [], edges: [] });
  await api.saveCanvas(c.id, {
    nodes: [
      { id: "a", type: "text", text: "see [[Docker]]", x: 0, y: 0, width: 10, height: 10 },
      { id: "b", type: "file", file: note.path, x: 0, y: 0, width: 10, height: 10 },
    ],
    edges: [{ id: "e", fromNode: "a", toNode: "b" }],
  });
  await assert.rejects(api.saveCanvas(c.id, { nodes: [{ id: "x" }] }), /id and a type/);
  await assert.rejects(api.updateItem(c.id, { tags: ["x"] }), /only its name/);
  const other = await api.createItem({ title: "Index", body: "[[Board.canvas]]" });
  let g = await api.loadGraph();
  assert.ok(g.links.some(l => l.source === c.id && l.target === note.id));
  assert.ok(g.links.some(l => l.source === other.id && l.target === c.id));
  await api.updateItem(note.id, { title: "Containers" });
  const d = await api.getCanvas(c.id);
  assert.equal(d.nodes[1].file, "Containers.md");
  assert.equal(d.nodes[0].text, "see [[Containers]]");
  const r = await api.updateItem(c.id, { title: "Sprint" });
  assert.equal(r.id, "Plans/Sprint.canvas");
  assert.equal((await api.getItem(other.id)).body, "[[Sprint.canvas]]");
});
