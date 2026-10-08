// UI flows, end to end, against the browser build + mock backend.
import { test, expect, openApp, byTitle, idOf, aiOn } from "./fixtures.mjs";

test.describe("shell", () => {
  test("loads the sample vault into graph, files and status bar", async ({ page, errors }) => {
    await openApp(page);
    await expect(page.locator(".st-counts")).toHaveText("73 items · 73 links");
    await expect(page.locator(".pane-graph canvas")).toBeVisible();
    await expect(page.locator("#left .group-head.folder")).toHaveCount(6); // canvases hackathons links notes projects skills
    await expect(page.locator(".st-ai")).toHaveText("AI off");
  });

  test("first run: empty state, then import sample", async ({ page, errors }) => {
    await openApp(page, "?empty");
    await expect(page.getByText("This vault is empty.")).toBeVisible();
    await page.getByRole("button", { name: "Import sample data" }).click();
    await expect(page.locator(".st-counts")).toHaveText("73 items · 73 links");
    await expect(page.getByText("This vault is empty.")).toBeHidden();
  });

  test("sidebars collapse and stay collapsed after reload", async ({ page, errors }) => {
    await openApp(page);
    await page.getByTitle("Toggle left sidebar").click();
    await expect(page.locator("#left")).toBeHidden();
    await page.reload();
    await page.waitForFunction(() => window.brain?.app?.loaded);
    await expect(page.locator("#left")).toBeHidden();
    await page.getByTitle("Toggle left sidebar").click();
    await expect(page.locator("#left")).toBeVisible();
  });

  test("theme toggle switches and persists", async ({ page, errors }) => {
    await openApp(page);
    await page.getByTitle("Toggle theme").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(255, 255, 255)");
    await page.reload();
    await page.waitForFunction(() => window.brain?.app?.loaded);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});

test.describe("graph", () => {
  test("click-to-select via list focuses the node; Esc clears; Enter opens", async ({ page, errors }) => {
    await openApp(page);
    await page.locator("#left .group-head.folder", { hasText: "notes" }).click();
    await page.locator("#left .item-row", { hasText: "Dijkstra notes" }).click();
    await expect(page.locator(".item-title")).toHaveText("Dijkstra notes");
    expect(await page.evaluate(() => window.brain.graph.state.focus?.node?.title)).toBe("Dijkstra notes");
    await page.locator(".pane-graph canvas").focus().catch(() => {});
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("Enter");
    await expect(page.locator(".tab.on")).toContainText("Dijkstra notes");
    await page.keyboard.press("Control+g");
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => window.brain.graph.state.focus)).toBeNull();
  });

  test("V toggles 2D/3D and the choice is remembered", async ({ page, errors }) => {
    await openApp(page);
    await page.keyboard.press("v");
    expect(await page.evaluate(() => window.brain.graph.state.flat)).toBe(true);
    await expect(page.locator('.graph-tools [data-mode="2d"]')).toHaveClass(/on/);
    await page.reload();
    await page.waitForFunction(() => window.brain?.app?.loaded);
    expect(await page.evaluate(() => window.brain.graph.state.flat)).toBe(true);
  });

  test("type filter hides nodes; similar toggle hides dashed links", async ({ page, errors }) => {
    await openApp(page);
    await page.getByTitle("Graph filters").click();
    await page.locator('#left [data-type="link"]').uncheck();
    expect(await page.evaluate(() => window.brain.graph.state.types.has("link"))).toBe(false);
    await page.locator("#left [data-similar]").uncheck();
    expect(await page.evaluate(() => window.brain.graph.state.showSimilar)).toBe(false);
  });

  test("renders only while something moves", async ({ page, errors }) => {
    await openApp(page);
    const frames = ms => page.evaluate(ms => new Promise(r => {
      const R = window.brain.graph.Graph.renderer();
      const c = R.info.render.frame;
      setTimeout(() => r(R.info.render.frame - c), ms);
    }), ms);
    await expect.poll(() => frames(800), { timeout: 30_000 }).toBe(0);
    await page.mouse.move(700, 400);
    await page.mouse.wheel(0, -120);
    expect(await frames(500)).toBeGreaterThan(0);
  });

  test("a lost GPU context shows a reload message and the app keeps working", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(() => window.brain.graph.Graph.renderer().getContext().getExtension("WEBGL_lose_context").loseContext());
    await expect(page.getByText("The graph stopped: the GPU driver reset.")).toBeVisible();
    await page.keyboard.press("Control+k");
    await page.keyboard.type("docker");
    await expect(page.locator(".palette-results li").first()).toBeVisible();
  });
});

test.describe("palettes", () => {
  test("search finds by title and body, Enter selects, Ctrl Enter opens a tab", async ({ page, errors }) => {
    await openApp(page);
    await page.keyboard.press("Control+k");
    await page.keyboard.type("nginx");
    await expect(page.locator(".palette-results li").first()).toContainText("CTFd deployment notes");
    await expect(page.locator(".palette-results li mark").first()).toHaveText(/nginx/i);
    await page.keyboard.press("Control+Enter");
    await expect(page.locator(".tab.on")).toContainText("CTFd deployment notes");

    await page.keyboard.press("Control+g");
    await page.keyboard.press("/");
    await page.keyboard.type("jwt");
    await page.keyboard.press("Enter");
    await expect(page.locator(".item-title")).toHaveText("Writeup: JWT none-alg bypass", { timeout: 15_000 });
  });

  test("command palette: fuzzy match, recent first, disabled with reason", async ({ page, errors }) => {
    await openApp(page);
    await page.keyboard.press("Control+p");
    await page.keyboard.type("tog 2d");
    await expect(page.locator(".palette-results li").first()).toContainText("Toggle 2D / 3D graph");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.brain.graph.state.flat)).toBe(true);
    await page.keyboard.press("Control+p");
    await expect(page.locator(".palette-results li").first()).toContainText("Toggle 2D / 3D graph");
    await page.keyboard.type("sync github");
    await expect(page.locator(".palette-results li").first()).toContainText("Add a GitHub token in Settings");
  });
});

test.describe("editing", () => {
  test("new note: title, body with [[ autocomplete, autosave, outgoing link", async ({ page, errors }) => {
    await openApp(page);
    await page.keyboard.press("Control+n");
    await expect(page.locator(".tab.on")).toContainText("Untitled");
    await page.keyboard.type("Rust ownership");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Borrowing. See [[Linux (Fe");
    await expect(page.locator(".cm-tooltip-autocomplete li").first()).toContainText("Linux (Fedora)");
    await page.waitForTimeout(150); // CodeMirror ignores Enter for 75ms after the list opens
    await page.keyboard.press("Enter");
    await page.keyboard.type(" and #rust.");
    await expect.poll(async () => (await byTitle(page, "Rust ownership"))?.body, { timeout: 5_000 })
      .toBe("Borrowing. See [[Linux (Fedora)]] and #rust.");
    const n = await byTitle(page, "Rust ownership");
    expect(n.path).toBe("notes/Rust ownership.md");
    expect(n.inline_tags).toEqual(["rust"]);
    await expect(page.locator('[data-sec="out"] .item-row')).toHaveText(["Linux (Fedora)"]);
  });

  test("rename rewrites links in other notes", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(id => window.brain.app.open(id), await idOf(page, "Docker"));
    const title = page.locator(".pane:not([hidden]) .doc-title-input");
    await title.fill("Docker and Podman");
    await title.press("Enter");
    await expect.poll(async () => (await byTitle(page, "Per-team challenge containers"))?.body).toContain("[[Docker and Podman]]");
    expect((await byTitle(page, "Docker and Podman")).path).toBe("skills/Docker and Podman.md");
    await expect(page.locator('[data-sec="back"] .count')).not.toHaveText("0");
  });

  test("reading view renders wikilinks that open their note; missing ones get created", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(async () => {
      const it = await window.brain.api.createItem({ title: "Hub", body: "Go to [[Docker]] or [[Brand new]]." });
      await window.brain.app.reload();
      window.brain.app.open(it.id, { mode: "read" });
    });
    const reading = page.locator(".pane:not([hidden]) .doc-reading");
    await expect(reading.locator("a.wikilink")).toHaveCount(2);
    await expect(reading.locator("a.wikilink.unresolved")).toHaveText("Brand new");
    await reading.locator("a.wikilink", { hasText: "Docker" }).click();
    await expect(page.locator(".tab.on")).toContainText("Docker");
    await page.locator(".tab", { hasText: "Hub" }).click();
    await page.locator(".pane:not([hidden]) a.wikilink.unresolved").click();
    await expect(page.locator(".tab.on")).toContainText("Brand new");
    expect(await byTitle(page, "Brand new")).not.toBeNull();
  });

  test("Ctrl E toggles edit/reading; Ctrl W closes; tabs come back after reload", async ({ page, errors }) => {
    await openApp(page);
    for (const t of ["Docker", "Bash one-liners"]) await page.evaluate(id => window.brain.app.open(id), await idOf(page, t));
    await page.keyboard.press("Control+e");
    await expect(page.locator(".pane:not([hidden]) .doc-reading")).toBeVisible();
    await page.keyboard.press("Control+e");
    await expect(page.locator(".pane:not([hidden]) .doc-editor")).toBeVisible();
    await page.reload();
    await page.waitForFunction(() => window.brain?.app?.loaded);
    await expect(page.locator(".tab")).toHaveCount(3);
    await page.locator(".tab", { hasText: "Docker" }).click();
    await page.keyboard.press("Control+w");
    await expect(page.locator(".tab")).toHaveCount(2);
  });
});

test.describe("organising", () => {
  test("properties: add and remove tags, change lobe and type", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(id => window.brain.app.select(id, { source: "list" }), await idOf(page, "Bash one-liners"));
    await page.locator("[data-tag-input]").fill("cli");
    await page.locator("[data-tag-input]").press("Enter");
    await expect.poll(async () => (await byTitle(page, "Bash one-liners")).tags).toEqual(["linux", "shell", "cli"]);
    await page.locator('[data-untag="shell"]').click();
    await expect.poll(async () => (await byTitle(page, "Bash one-liners")).tags).toEqual(["linux", "cli"]);
    await page.locator('[data-prop="lobe"]').selectOption("web");
    await expect.poll(async () => (await byTitle(page, "Bash one-liners")).lobe).toBe("web");
    await page.locator('[data-prop="type"]').selectOption("skill");
    await expect.poll(async () => (await byTitle(page, "Bash one-liners")).type).toBe("skill");
    await expect(page.locator('[data-field="level"]')).toBeVisible();
  });

  test("inbox lists untagged items; inline #tags count as tags", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(async () => {
      await window.brain.api.createItem({ title: "Loose thought", body: "no tags" });
      await window.brain.api.createItem({ title: "Tagged inline", body: "about #rust/async" });
      await window.brain.app.reload();
    });
    await page.getByTitle("Inbox (untagged)").click();
    await expect(page.locator('#left [data-view="inbox"] .item-row')).toHaveText(["Loose thought"]);
    await expect(page.getByTitle("Inbox (untagged)")).toHaveAttribute("data-badge", "1");
    await page.getByTitle("Tags", { exact: true }).click();
    await page.locator('#left [data-tag="rust/async"]').click();
    await expect(page.locator('#left [data-view="tags"] .item-row')).toHaveText(["Tagged inline"]);
  });

  test("files: folders/types switch, expand, filter", async ({ page, errors }) => {
    await openApp(page);
    await page.locator("#left .group-head.folder", { hasText: "skills" }).click();
    await expect(page.locator("#left .item-row", { hasText: "Docker" })).toBeVisible();
    await page.locator('#left [data-mode="types"]').click();
    await expect(page.locator("#left .group-head")).toContainText(["Notes", "Links", "Skills", "Hackathons", "Projects"]);
    await page.locator("#left .side-filter").fill("ctf");
    const rows = await page.locator("#left .item-row").count();
    expect(rows).toBeGreaterThan(3);
    expect(rows).toBeLessThan(30);
  });

  test("new skill dialog: form fields and a used_in link that shows in the graph", async ({ page, errors }) => {
    await openApp(page);
    await page.keyboard.press("Control+p");
    await page.keyboard.type("new skill");
    await page.keyboard.press("Enter");
    await page.locator('[data-f="title"]').fill("Rust");
    await page.locator('[data-f="tags"]').fill("rust, systems");
    await page.locator('[data-field="level"]').selectOption("beginner");
    await page.locator('[data-link-input="used_in"]').fill("Hackemon");
    await page.locator('[data-link-input="used_in"]').press("Enter");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.locator(".tab.on")).toContainText("Rust");
    const n = await byTitle(page, "Rust");
    expect(n).toMatchObject({ type: "skill", level: "beginner", tags: ["rust", "systems"], used_in: ["[[Hackemon]]"] });
    const out = await page.evaluate(id => window.brain.app.outgoing(id).map(e => window.brain.app.items.get(e.id).title), n.id);
    expect(out).toEqual(["Hackemon"]);
  });

  test("delete needs a confirm click and removes the item", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(id => window.brain.app.select(id, { source: "list" }), await idOf(page, "Reading list"));
    await page.locator('[data-act="delete"]').click();
    await expect(page.locator('[data-act="delete"]')).toHaveText("Confirm");
    await page.locator('[data-act="delete"]').click();
    await expect.poll(() => byTitle(page, "Reading list")).toBeNull();
    await expect(page.locator(".st-counts")).toContainText("72 items");
  });

  test("settings: add a lobe, save, it appears in the filters", async ({ page, errors }) => {
    await openApp(page);
    await page.getByTitle("Settings", { exact: true }).click();
    await page.getByRole("button", { name: "Add lobe" }).click();
    await page.keyboard.type("Robotics");
    await page.getByRole("button", { name: "Save lobes" }).click();
    await expect.poll(() => page.evaluate(() => window.brain.app.lobes.map(l => l.name))).toContain("Robotics");
    expect(await page.evaluate(() => window.brain.app.lobes.find(l => l.name === "Robotics").id)).toBe("robotics");
  });
});

test.describe("AI (browser preview fake)", () => {
  test("AI off: actions are disabled with a reason", async ({ page, errors }) => {
    await openApp(page);
    await page.locator("#left .group-head.folder", { hasText: "notes" }).click();
    await page.locator("#left .item-row", { hasText: "Bash one-liners" }).click({ button: "right" });
    await expect(page.locator(".menu-item", { hasText: "Polish" })).toHaveAttribute("title", /AI provider/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".menu")).toHaveCount(0);
  });

  test("polish shows a diff and Ctrl Enter applies it", async ({ page, errors }) => {
    await openApp(page);
    await aiOn(page);
    const id = await page.evaluate(async () => (await window.brain.api.createItem({ title: "Sloppy", body: "teh  cache is slow.  we should fix it." })).id);
    await page.evaluate(async id => { await window.brain.app.reload(); window.brain.app.open(id); }, id);
    await page.locator(".pane:not([hidden]) .cm-content").click({ button: "right" });
    await page.locator(".menu-item", { hasText: "Polish whole note" }).click();
    await expect(page.locator(".review ins").first()).toBeVisible();
    await page.keyboard.press("Control+Enter");
    await expect.poll(async () => (await byTitle(page, "Sloppy")).body).toBe("The cache is slow. We should fix it.");
  });

  test("tag suggestions for inbox items; Ctrl Enter accepts", async ({ page, errors }) => {
    await openApp(page);
    await aiOn(page);
    const id = await page.evaluate(async () => (await window.brain.api.createItem({ title: "Container notes", body: "docker volumes and linux cgroups" })).id);
    await page.evaluate(async id => { await window.brain.app.reload(); window.brain.app.select(id, { source: "list" }); }, id);
    await expect(page.locator(".tag.sugg").first()).toBeVisible();
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("Control+Enter");
    await expect.poll(async () => (await byTitle(page, "Container notes")).tags.length).toBeGreaterThan(0);
  });

  test("Ask answers with citations and lights them up in the graph", async ({ page, errors }) => {
    await openApp(page);
    await aiOn(page);
    await page.getByTitle("Ask", { exact: true }).click();
    await page.locator(".ask-form textarea").fill("How do I isolate team containers?");
    await page.keyboard.press("Enter");
    await expect(page.locator(".ask-answer a.wikilink").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".ask-sources .item-row.cited").first()).toBeVisible();
    expect(await page.evaluate(() => window.brain.graph.state.focus?.kind)).toBe("set");
  });

  test("Ask without AI lists matching notes", async ({ page, errors }) => {
    await openApp(page);
    await page.getByTitle("Ask", { exact: true }).click();
    await page.locator(".ask-form textarea").fill("containers");
    await page.keyboard.press("Enter");
    await expect(page.getByText("AI is off. Notes that match:")).toBeVisible();
    await expect(page.locator(".ask-sources .item-row").first()).toBeVisible();
  });
});

test.describe("quick capture page", () => {
  test("URL becomes a link, duplicates are caught, text becomes a note", async ({ page, errors }) => {
    await page.goto("/capture.html");
    const input = page.locator("#text");
    await input.fill("docs.rs/tokio");
    await input.press("Enter");
    await expect(page.locator("#status")).toHaveText("Saved, fetching the page");
    await expect(input).toHaveValue("", { timeout: 3_000 });
    await input.fill("https://docs.rs/tokio");
    await input.press("Enter");
    await expect(page.locator("#status")).toHaveText("Already saved");
    await input.fill("remember to try zellij");
    await input.press("Enter");
    await expect(page.locator("#status")).toHaveText("Saved to Inbox");
  });
});

test.describe("regressions", () => {
  test("switching tabs never leaves keys typing into a hidden editor", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(id => window.brain.app.open(id), await idOf(page, "Docker"));
    await page.locator(".pane:not([hidden]) .cm-content").click();
    const before = (await byTitle(page, "Docker")).body;
    await page.keyboard.press("Control+g");
    await page.keyboard.type("/abc");
    await expect(page.locator(".palette-input input")).toHaveValue("abc");
    await page.waitForTimeout(800);
    expect((await byTitle(page, "Docker")).body).toBe(before);
  });

  test("[[ completion replaces auto-closed brackets", async ({ page, errors }) => {
    await openApp(page);
    await page.keyboard.press("Control+n");
    await page.keyboard.press("Enter");
    await page.keyboard.type("See [[Linux (Fe");
    await expect(page.locator(".cm-tooltip-autocomplete li").first()).toContainText("Linux (Fedora)");
    await page.waitForTimeout(150);
    await page.keyboard.press("Enter");
    await page.keyboard.type(" done");
    await expect.poll(async () => page.evaluate(() => window.brain.tabs.active.pane.querySelector(".cm-content").innerText))
      .toBe("See [[Linux (Fedora)]] done");
  });

  test("Enter right after typing picks the result for what was typed", async ({ page, errors }) => {
    await openApp(page);
    await page.keyboard.press("Control+k");
    await page.keyboard.type("dijkstra");
    await page.keyboard.press("Control+Enter");
    await expect(page.locator(".tab.on")).toContainText("Dijkstra notes");
  });
});

test.describe("save safety", () => {
  test("hiding/closing the window flushes typing that hasn't autosaved yet", async ({ page, errors }) => {
    await openApp(page);
    const id = await idOf(page, "Docker");
    await page.evaluate(id => window.brain.app.open(id, { mode: "edit" }), id);
    await page.locator(".pane:not([hidden]) .cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" LASTWORDS");
    await page.evaluate(() => dispatchEvent(new Event("pagehide")));
    await page.waitForTimeout(100); // well under the 500ms autosave
    const body = await page.evaluate(id => window.brain.api.getItem(id).then(n => n.body), id);
    expect(body.endsWith(" LASTWORDS")).toBe(true);
  });

  test("rename saves other open notes first, so the link rewrite sticks", async ({ page, errors }) => {
    await openApp(page);
    const other = await idOf(page, "Per-team challenge containers");
    await page.evaluate(id => window.brain.app.open(id, { mode: "edit" }), other);
    await page.locator(".pane:not([hidden]) .cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" typed");
    await page.evaluate(id => window.brain.app.open(id), await idOf(page, "Docker"));
    const title = page.locator(".pane:not([hidden]) .doc-title-input");
    await title.fill("Docker and Podman");
    await title.press("Enter");
    await page.waitForTimeout(800); // let any pending autosave fire
    const body = await page.evaluate(id => window.brain.api.getItem(id).then(n => n.body), other);
    expect(body).toContain("[[Docker and Podman]]");
    expect(body).toContain(" typed");
  });
});

test.describe("graph framing", () => {
  test("after the layout settles the whole graph is in view, lobe labels near their clusters", async ({ page, errors }) => {
    await openApp(page);
    // wait for the first layout to finish (graph goes idle) and the fit animation
    await page.waitForFunction(() => {
      const R = window.brain.graph.Graph.renderer();
      const f = R.info.render.frame;
      return new Promise(r => setTimeout(() => r(R.info.render.frame === f), 700));
    }, null, { timeout: 40_000, polling: 1000 });
    const r = await page.evaluate(() => {
      const G = window.brain.graph.Graph;
      const w = G.width(), h = G.height();
      const nodes = [...window.brain.app.items.values()];
      const inside = nodes.filter(n => { const p = G.graph2ScreenCoords(n.x, n.y, n.z); return p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h; }).length;
      return { inside, total: nodes.length };
    });
    expect(r.inside / r.total).toBeGreaterThan(0.95);
  });
});

test.describe("canvas", () => {
  const canvasId = page => page.evaluate(() => [...window.brain.app.items.values()].find(n => n.type === "canvas")?.id);
  const stored = (page, id) => page.evaluate(id => window.brain.api.getCanvas(id), id);
  const view = page => page.locator(".pane:not([hidden]) .cv-view");
  async function openCanvas(page) {
    await openApp(page);
    const id = await canvasId(page);
    await page.evaluate(id => window.brain.app.open(id), id);
    await expect(page.locator(".pane:not([hidden]) .cv-node")).toHaveCount(9);
    return id;
  }

  test("the sample canvas shows cards, groups, arrows and links to its notes", async ({ page, errors }) => {
    const id = await openCanvas(page);
    const pane = page.locator(".pane:not([hidden])");
    await expect(pane.locator(".cv-title")).toHaveValue("CTF event plan");
    await expect(pane.locator(".cv-group-label")).toHaveText(["Before the event", "On the day"]);
    await expect(pane.locator(".cv-edge")).toHaveCount(5);
    await expect(pane.locator(".cv-edge-label")).toHaveText(["every challenge", "then deploy"]);
    // file cards show the note itself
    await expect(pane.locator(".cv-file .cv-head").first()).toContainText("CTF challenge design checklist");
    await expect(pane.locator(".cv-file .cv-content").first()).toContainText("intended path");
    // the canvas links to the notes on it, so they list it as a backlink
    const checklist = await idOf(page, "CTF challenge design checklist");
    const back = await page.evaluate(id => window.brain.app.backlinks(id).map(e => e.id), checklist);
    expect(back).toContain(id);
    // and search finds text on the board
    const hits = await page.evaluate(() => window.brain.api.search("scoreboard"));
    expect(hits.map(h => h.id)).toContain(id);
  });

  test("double-click adds a card; typing, moving, undo and delete all save", async ({ page, errors }) => {
    const id = await openCanvas(page);
    const v = view(page);
    const box = await v.boundingBox();
    // empty spot near the bottom left
    await page.mouse.dblclick(box.x + 120, box.y + box.height - 80);
    const ta = page.locator(".cv-edit");
    await expect(ta).toBeFocused();
    await page.keyboard.type("Remember the **flag format**");
    await page.keyboard.press("Escape");
    await expect(page.locator(".cv-node.sel .cv-content")).toContainText("Remember the flag format");
    await expect.poll(async () => (await stored(page, id)).nodes.length).toBe(10);
    const added = (await stored(page, id)).nodes.find(n => n.text?.includes("flag format"));
    expect(added).toMatchObject({ type: "text", width: 250, height: 60 });

    // drag it 100px right
    const card = page.locator(`.cv-node[data-id="${added.id}"]`);
    const cb = await card.boundingBox();
    await page.mouse.move(cb.x + 20, cb.y + 20);
    await page.mouse.down();
    await page.mouse.move(cb.x + 70, cb.y + 20, { steps: 4 });
    await page.mouse.move(cb.x + 120, cb.y + 20, { steps: 4 });
    await page.mouse.up();
    const z = await page.evaluate(() => window.brain.tabs.active.view.camera.z);
    await expect.poll(async () => (await stored(page, id)).nodes.find(n => n.id === added.id).x).toBe(added.x + Math.round(100 / z));

    // undo the move, then delete the card
    await v.press("Control+z");
    await expect.poll(async () => (await stored(page, id)).nodes.find(n => n.id === added.id).x).toBe(added.x);
    await card.click();
    await v.press("Delete");
    await expect(card).toHaveCount(0);
    await expect.poll(async () => (await stored(page, id)).nodes.length).toBe(9);
    // redo is gone after a new change; undo brings the card back
    await v.press("Control+z");
    await expect(card).toHaveCount(1);
  });

  test("drag from a side dot to another card connects them; colours and arrows apply to the selection", async ({ page, errors }) => {
    const id = await openCanvas(page);
    const from = page.locator('.cv-node[data-id="t-goal"]');
    const to = page.locator('.cv-node[data-id="l-ctfd"]');
    await from.hover();
    const port = from.locator('.cv-port[data-side="bottom"]');
    const pb = await port.boundingBox();
    const tb = await to.boundingBox();
    await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + 5, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await stored(page, id)).edges.length).toBe(6);
    const e = (await stored(page, id)).edges.at(-1);
    expect(e).toMatchObject({ fromNode: "t-goal", fromSide: "bottom", toNode: "l-ctfd", toSide: "top" });

    // colour a card
    await from.click({ position: { x: 10, y: 10 } });
    await page.locator('.cv-swatches [data-color="5"]').click();
    await expect.poll(async () => (await stored(page, id)).nodes.find(n => n.id === "t-goal").color).toBe("5");
    await expect(from).toHaveClass(/colored/);
    // unknown keys in the file survive edits
    await page.evaluate(async id => {
      const d = await window.brain.api.getCanvas(id);
      d["x-other-plugin"] = { keep: 1 };
      await window.brain.api.saveCanvas(id, d);
      await window.brain.app.reload();
    }, id);
    await from.click({ position: { x: 10, y: 10 } });
    await page.locator('.cv-swatches [data-color=""]').click();
    await expect.poll(async () => (await stored(page, id)).nodes.find(n => n.id === "t-goal").color).toBeUndefined();
    expect((await stored(page, id))["x-other-plugin"]).toEqual({ keep: 1 });
  });

  test("new canvas from the palette, add a note from search, rename", async ({ page, errors }) => {
    await openApp(page);
    await page.keyboard.press("Control+p");
    await page.keyboard.type("new canvas");
    await page.keyboard.press("Enter");
    const title = page.locator(".pane:not([hidden]) .cv-title");
    await expect(title).toBeFocused();
    await title.fill("Exam map");
    await title.press("Enter");
    await expect(page.locator(".tab.on")).toContainText("Exam map");
    const id = await page.evaluate(() => [...window.brain.app.items.values()].find(n => n.title === "Exam map")?.id);
    expect(id).toBe("canvases/Exam map.canvas");
    await page.locator('.pane:not([hidden]) [data-act="add-file"]').click();
    await page.keyboard.type("Docker");
    await page.waitForTimeout(150);
    await page.keyboard.press("Enter");
    await expect(page.locator(".pane:not([hidden]) .cv-file .cv-head")).toContainText("Docker");
    await expect.poll(async () => (await stored(page, id)).nodes.map(n => n.file)).toEqual(["skills/Docker.md"]);
    // renaming the note updates the card's path
    await page.evaluate(async did => { await window.brain.api.updateItem(did, { title: "Docker and Podman" }); await window.brain.app.reload(); }, await idOf(page, "Docker"));
    await expect.poll(async () => (await stored(page, id)).nodes.map(n => n.file)).toEqual(["skills/Docker and Podman.md"]);
    await expect(page.locator(".pane:not([hidden]) .cv-file .cv-head")).toContainText("Docker and Podman");
  });

  test("dropping a file from the sidebar adds it as a card", async ({ page, errors }) => {
    const id = await openCanvas(page);
    const nid = await idOf(page, "GTFOBins");
    const v = view(page);
    const box = await v.boundingBox();
    await page.evaluate(({ nid, x, y }) => {
      const dt = new DataTransfer();
      dt.setData("application/x-brain-item", nid);
      const el = document.querySelector(".pane:not([hidden]) .cv-view");
      el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    }, { nid, x: box.x + 200, y: box.y + box.height - 100 });
    await expect.poll(async () => (await stored(page, id)).nodes.some(n => n.file === "links/GTFOBins.md")).toBe(true);
  });
});

test.describe("brain features", () => {
  const leftTab = (page, title) => page.locator(`#left-tabs .side-tab[title^="${title}"]`);

  test("tasks pane lists open tasks by due date; ticking one writes the note", async ({ page, errors }) => {
    await openApp(page);
    await leftTab(page, "Tasks").click();
    const rows = page.locator(".task-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("Submit the DSA lab record");
    await rows.first().locator(".task-check").click();
    await expect(rows).toHaveCount(1);
    const body = (await byTitle(page, "Semester plan")).body;
    expect(body).toContain("- [x] Submit the DSA lab record due: 2026-10-14");
    expect(body).toContain("- [ ] Revise paging");
  });

  test("checkboxes in the reading view tick the task in the note", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(id => window.brain.app.open(id, { mode: "read" }), await idOf(page, "Semester plan"));
    const boxes = page.locator(".pane:not([hidden]) .doc-reading .task-box");
    await expect(boxes).toHaveCount(3);
    await boxes.nth(0).click();
    await expect.poll(async () => (await byTitle(page, "Semester plan")).body).toContain("- [x] Revise paging");
    await expect(page.locator(".pane:not([hidden]) .doc-reading .card-sep")).toHaveCount(3);
  });

  test("Ctrl Shift D opens today's daily note, creating it once", async ({ page, errors }) => {
    await openApp(page);
    const day = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
    await page.keyboard.press("Control+Shift+D");
    await expect(page.locator(".tab.on")).toContainText(day);
    const n = await byTitle(page, day);
    expect(n.path).toBe(`daily/${day}.md`);
    expect(n.tags).toEqual(["daily"]);
    await page.locator(".tab.on .tab-close").click();
    await page.keyboard.press("Control+Shift+D");
    await expect(page.locator(".tab.on")).toContainText(day);
    expect(await page.evaluate(d => [...window.brain.app.items.values()].filter(n => n.title === d).length, day)).toBe(1);
  });

  test("review: flashcards from notes, graded with keys, schedule saved", async ({ page, errors }) => {
    await openApp(page);
    await expect(page.locator(".st-review")).toHaveText("3 to review");
    await page.locator(".st-review").click();
    const card = page.locator(".review-card");
    await expect(card.locator(".review-q")).toHaveText("What is a page fault?");
    await expect(card.locator(".review-a")).toHaveCount(0);
    await page.keyboard.press("Space");
    await expect(card.locator(".review-a")).toContainText("isn't in RAM");
    await page.keyboard.press("3");
    await expect(card.locator(".review-q")).toHaveText("What is thrashing?");
    await page.keyboard.press("Space");
    await page.keyboard.press("1"); // again: comes back this session
    await expect(card.locator(".review-q")).toHaveText("Four conditions for deadlock?");
    await page.keyboard.press("Space");
    await page.keyboard.press("4");
    await expect(card.locator(".review-q")).toHaveText("What is thrashing?");
    await page.keyboard.press("Space");
    await page.keyboard.press("3");
    await expect(page.locator(".review-empty")).toContainText("Nothing to review");
    await expect(page.locator(".st-review")).toHaveCount(0);
    const st = await page.evaluate(() => window.brain.api.getState("review"));
    const ivals = Object.values(st.cards).map(c => c.interval).sort();
    expect(ivals).toEqual([1, 1, 4]);
    expect(st.newCount).toBe(3);
  });

  test("unlinked mentions: Link turns the first mention into a link", async ({ page, errors }) => {
    await openApp(page);
    const src = await page.evaluate(() => window.brain.api.createItem({ title: "Lab setup", body: "Installed docker on the lab machines. Docker needs sudo." }));
    await page.evaluate(() => window.brain.app.reload());
    await page.evaluate(id => window.brain.app.select(id, { source: "list" }), await idOf(page, "Docker"));
    const sec = page.locator('[data-sec="mentions"]');
    await expect(sec.locator(".mention-row")).toHaveCount(1);
    await expect(sec.locator(".mention-row")).toContainText("Lab setup");
    await expect(sec.locator("mark")).toHaveText("docker");
    await sec.locator(".mention-link").click();
    await expect.poll(async () => (await byTitle(page, "Lab setup")).body).toBe("Installed [[Docker|docker]] on the lab machines. Docker needs sudo.");
    await expect(sec.locator(".mention-row")).toHaveCount(0);
    await expect(page.locator('[data-sec="back"] .item-row', { hasText: "Lab setup" })).toHaveCount(1);
    expect(src.id).toBeTruthy();
  });
});
