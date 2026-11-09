// Graph layout quality on a vault shaped like a real one: lobes (top-level
// folders) with subfolders, plus many links across lobes into a busy lobe.
import { test, expect, openApp } from "./fixtures.mjs";
import { buildVault } from "./vaults.mjs";

// For every note: is its own lobe's label the nearest label? And how far is it, compared to the lobe spacing?
const measure = page => page.evaluate(() => {
  const g = window.brain.graph.Graph.graphData();
  const labels = g.nodes.filter(n => n.kind === "lobe");
  const notes = g.nodes.filter(n => !n.kind && n.path.includes("/"));
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  let nearestOwn = 0, own = [];
  for (const n of notes) {
    const lobe = n.path.split("/")[0];
    const mine = labels.find(l => l.name === lobe);
    const best = labels.reduce((a, b) => (d(n, a) <= d(n, b) ? a : b));
    if (best === mine) nearestOwn++;
    own.push(d(n, mine));
  }
  own.sort((a, b) => a - b);
  return { nearestOwn: nearestOwn / notes.length, medianToOwnLabel: own[Math.floor(own.length / 2)] };
});

test("notes settle around their own lobe's name, also after reloads that change nothing", async ({ page, errors }) => {
  await openApp(page, "?empty");
  await buildVault(page);
  // a reload with the same structure (what every autosave does) used to drop
  // each note's lobe, and every note drifted to one shared centre
  await page.evaluate(async () => { await window.brain.app.reload(); await window.brain.app.reload(); });
  await page.evaluate(() => window.brain.graph.Graph.d3ReheatSimulation());
  await page.waitForTimeout(9000); // let the layout settle
  const m = await measure(page);
  expect(m.nearestOwn).toBeGreaterThan(0.95);
  expect(m.medianToOwnLabel).toBeLessThan(70);
});
