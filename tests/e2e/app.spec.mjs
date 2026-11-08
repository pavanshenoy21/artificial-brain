// UI flows, end to end, against the browser build + mock backend (the sample
// vault in src/data/sample.js). Every test fails on any page error.
import { test, expect, openApp, byTitle, fileOf, active } from "./fixtures.mjs";

const HACK = "Coding Club/Hackathons/Hack Night 2026.md";
const CTFD = "Coding Club/CTF/CTFd setup.md";
const row = (page, path) => page.locator(`#left .file-row[data-id="${path}"]`);
const folder = (page, path) => page.locator(`#left .folder-row[data-folder="${path}"]`);
async function expand(page, ...paths) {
  for (const p of paths) if ((await folder(page, p).getAttribute("aria-expanded")) !== "true") await folder(page, p).click();
}

test.describe("shell", () => {
  test("loads the sample vault: explorer, graph, status bar", async ({ page, errors }) => {
    await openApp(page);
    const files = await page.evaluate(() => window.brain.app.items.size);
    await expect(page.locator(".st-counts")).toHaveText(new RegExp(`^${files} files · \\d+ links$`));
    await expect(page.locator(".pane-graph canvas")).toBeVisible();
    // top level: lobe folders first, then loose files
    await expect(page.locator("#left .explorer > .group > .folder-row .row-title")).toHaveText(["Coding Club", "College", "Learning", "Projects"]);
    await expect(page.locator("#left .explorer > .file-row")).toHaveText(["Welcome"]);
  });

  test("first run: empty state, then import the sample vault", async ({ page, errors }) => {
    await openApp(page, "?empty");
    await expect(page.getByText("This vault is empty.")).toBeVisible();
    await page.getByRole("button", { name: "Import sample data" }).click();
    await expect(folder(page, "Coding Club")).toBeVisible();
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
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(255, 255, 255)");
    await page.reload();
    await page.waitForFunction(() => window.brain?.app?.loaded);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});

test.describe("file explorer", () => {
  test("click opens a file; open folders are remembered", async ({ page, errors }) => {
    await openApp(page);
    await expand(page, "Coding Club", "Coding Club/Hackathons");
    await row(page, HACK).click();
    await expect(page.locator(".tab.on")).toContainText("Hack Night 2026");
    await expect(row(page, HACK)).toHaveClass(/active/);
    await page.reload();
    await page.waitForFunction(() => window.brain?.app?.loaded);
    await expect(row(page, HACK)).toBeVisible();
  });

  test("new note in the focused folder, named from its inline title", async ({ page, errors }) => {
    await openApp(page);
    await expand(page, "College");
    await folder(page, "College").focus();
    await page.locator('#left [data-act="new-note"]').click();
    const title = active(page).locator(".doc-title-input");
    await expect(title).toBeFocused();
    await expect(title).toHaveValue("Untitled");
    await page.keyboard.type("OS internal prep");
    await page.keyboard.press("Enter");
    await expect(row(page, "College/OS internal prep.md")).toBeVisible();
    await page.keyboard.type("Paging and [[Operating systems]]");
    await expect.poll(async () => (await fileOf(page, "College/OS internal prep.md"))?.body).toBe("Paging and [[Operating systems]]");
    expect(await fileOf(page, "College/Untitled.md")).toBeNull();
  });

  test("new folder: rename inline, then a note inside it from its menu", async ({ page, errors }) => {
    await openApp(page);
    await page.locator('#left [data-act="new-folder"]').click();
    const input = page.locator("#left .rename-input");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("Untitled");
    await page.keyboard.type("Events");
    await page.keyboard.press("Enter");
    await expect(folder(page, "Events")).toBeVisible();
    await folder(page, "Events").click({ button: "right" });
    await page.locator(".menu-item", { hasText: "New note" }).click();
    await expect(page.locator(".tab.on")).toContainText("Untitled");
    expect(await fileOf(page, "Events/Untitled.md")).not.toBeNull();
    await expect(folder(page, "Events")).toHaveAttribute("aria-expanded", "true");
  });

  test("drag a file into another folder: path-style links follow", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(() => window.brain.api.createItem({ title: "Uses path", body: "[[Coding Club/Hackathons/Hack Night 2026]]" }));
    await page.evaluate(() => window.brain.app.reload());
    await expand(page, "Coding Club", "Coding Club/Hackathons");
    await row(page, HACK).dragTo(folder(page, "Projects"));
    await expect.poll(async () => fileOf(page, "Projects/Hack Night 2026.md")).not.toBeNull();
    expect(await fileOf(page, HACK)).toBeNull();
    expect((await fileOf(page, "Uses path.md")).body).toBe("[[Projects/Hack Night 2026]]");
    // and onto the empty area: the vault root
    await expand(page, "Projects");
    await row(page, "Projects/Hack Night 2026.md").dragTo(row(page, "Welcome.md"));
    await expect.poll(async () => fileOf(page, "Hack Night 2026.md")).not.toBeNull();
  });

  test("rename a folder with F2: open tabs, links and colours follow", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(() => window.brain.api.setFolderColor("Coding Club/CTF", "#123456"));
    await expand(page, "Coding Club", "Coding Club/CTF");
    await row(page, CTFD).click();
    await folder(page, "Coding Club/CTF").focus();
    await page.keyboard.press("F2");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("Capture the flag");
    await page.keyboard.press("Enter");
    const moved = "Coding Club/Capture the flag/CTFd setup.md";
    await expect(row(page, moved)).toBeVisible();
    await expect(page.locator(".tab.on")).toContainText("CTFd setup");
    expect(await page.evaluate(() => window.brain.tabs.active.id)).toBe(moved);
    expect(await page.evaluate(() => window.brain.app.colors.folders["Coding Club/Capture the flag"])).toBe("#123456");
    // the canvas card that showed the note points at its new path
    const card = await page.evaluate(() => window.brain.api.getCanvas("Coding Club/Capture the flag/CTF event plan.canvas"));
    expect(card.nodes.find(n => n.id === "f-deploy").file).toBe(moved);
  });

  test("delete a folder asks first, then moves it out", async ({ page, errors }) => {
    await openApp(page);
    await folder(page, "Projects").click({ button: "right" });
    await page.locator(".menu-item", { hasText: "Delete" }).click();
    await expect(page.locator(".dialog-head")).toHaveText('Delete the folder "Projects"?');
    await page.keyboard.press("Escape");
    await expect(folder(page, "Projects")).toBeVisible();
    await folder(page, "Projects").click({ button: "right" });
    await page.locator(".menu-item", { hasText: "Delete" }).click();
    await page.locator('.dialog [data-act="ok"]').click();
    await expect(folder(page, "Projects")).toHaveCount(0);
    expect(await page.evaluate(() => [...window.brain.app.items.keys()].some(p => p.startsWith("Projects/")))).toBe(false);
  });

  test("folder colour from its menu: dot, notes and graph", async ({ page, errors }) => {
    await openApp(page);
    await expand(page, "Coding Club");
    await folder(page, "Coding Club/Workshops").click({ button: "right" });
    await page.locator(".menu-item", { hasText: "Colour" }).click();
    const pick = page.locator(".menu-item").nth(3);
    const color = (await pick.textContent()).trim();
    await pick.click();
    await expect(folder(page, "Coding Club/Workshops").locator(".folder-dot")).toHaveCSS("background-color", hex(color));
    expect(await page.evaluate(() => window.brain.app.colorOf(window.brain.app.items.get("Coding Club/Workshops/Git workshop.md")))).toBe(color);
    const s = await page.evaluate(() => window.brain.graph.structure);
    expect(s.folders.find(f => f.path === "Coding Club/Workshops").color).toBe(color);
  });

  test("move a file with the command palette's folder picker", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(id => window.brain.app.open(id), HACK);
    await page.keyboard.press("Control+p");
    await page.keyboard.type("move file");
    await page.keyboard.press("Enter");
    await page.keyboard.type("sem 3");
    await page.waitForTimeout(100);
    await page.keyboard.press("Enter");
    await expect.poll(async () => fileOf(page, "College/Sem 3/Hack Night 2026.md")).not.toBeNull();
    expect(await page.evaluate(() => window.brain.tabs.active.id)).toBe("College/Sem 3/Hack Night 2026.md");
  });
});

const hex = h => {
  const v = parseInt(h.slice(1), 16);
  return `rgb(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255})`;
};

test.describe("graph", () => {
  test("folders shape the graph: lobes are labels, subfolders are coloured hubs in a tree", async ({ page, errors }) => {
    await openApp(page);
    const s = await page.evaluate(() => window.brain.graph.structure);
    expect(s.lobes.map(l => l.name).sort()).toEqual(["Coding Club", "College", "Learning", "Projects"]);
    expect(s.folders.map(f => f.path)).toContain("Coding Club/CTF");
    const tree = new Map(s.tree);
    expect(tree.get(CTFD)).toBe("folder:Coding Club/CTF");
    expect(tree.get("folder:Coding Club/CTF")).toBe("lobe:Coding Club");
    expect(tree.get("Coding Club/Overview.md")).toBe("lobe:Coding Club");
    expect(tree.has("Welcome.md")).toBe(false);
    // groups in one lobe get different colours
    const colors = s.folders.filter(f => f.path.startsWith("Coding Club/")).map(f => f.color);
    expect(new Set(colors).size).toBe(colors.length);
    // focusing a lobe lights up all of its notes
    await page.evaluate(() => window.brain.graph.focusFolder("Coding Club"));
    const lit = await page.evaluate(() => [...window.brain.graph.state.levels].filter(([, l]) => l <= 1).map(([id]) => id));
    expect(lit).toContain(CTFD);
    expect(lit).toContain(HACK);
  });

  test("click-to-select focuses the node; Esc clears; Enter opens", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(id => window.brain.app.select(id, { source: "list" }), CTFD);
    expect(await page.evaluate(() => window.brain.graph.state.focus?.node?.title)).toBe("CTFd setup");
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("Enter");
    await expect(page.locator(".tab.on")).toContainText("CTFd setup");
    await page.keyboard.press("Control+g");
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => window.brain.graph.state.focus)).toBeNull();
  });

  test("V toggles 2D/3D and the choice is remembered; Folders hides the tree", async ({ page, errors }) => {
    await openApp(page);
    await page.keyboard.press("v");
    expect(await page.evaluate(() => window.brain.graph.state.flat)).toBe(true);
    await expect(page.locator('.graph-tools [data-mode="2d"]')).toHaveClass(/on/);
    await page.locator('[data-opt="tree"]').uncheck();
    expect(await page.evaluate(() => window.brain.graph.state.showTree)).toBe(false);
    await page.reload();
    await page.waitForFunction(() => window.brain?.app?.loaded);
    expect(await page.evaluate(() => [window.brain.graph.state.flat, window.brain.graph.state.showTree])).toEqual([true, false]);
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

  test("after the layout settles the whole graph is in view", async ({ page, errors }) => {
    await openApp(page);
    await expect.poll(() => page.evaluate(() => {
      const g = window.brain.graph;
      const pane = document.querySelector(".pane-graph").getBoundingClientRect();
      const pts = [...window.brain.app.items.values()].filter(n => n.type === "note").map(n => g.screenPos(n));
      const inside = pts.filter(p => p.x >= pane.left && p.x <= pane.right && p.y >= pane.top && p.y <= pane.bottom);
      return inside.length / pts.length;
    }), { timeout: 30_000 }).toBeGreaterThan(0.9);
  });
});

test.describe("editor", () => {
  test("new note: body with [[ autocomplete, autosave, outgoing link", async ({ page, errors }) => {
    await openApp(page);
    await page.keyboard.press("Control+n");
    await expect(page.locator(".tab.on")).toContainText("Untitled");
    await page.keyboard.type("Rust ownership");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Borrowing. See [[Dijk");
    await expect(page.locator(".cm-tooltip-autocomplete li").first()).toContainText("Dijkstra");
    await page.waitForTimeout(150); // CodeMirror ignores Enter for 75ms after the list opens
    await page.keyboard.press("Enter");
    await page.keyboard.type(" and #rust.");
    await expect.poll(async () => (await fileOf(page, "Rust ownership.md"))?.body).toBe("Borrowing. See [[Dijkstra]] and #rust.");
    await page.locator('#right-tabs .side-tab[title="Outgoing links"]').click();
    await expect(page.locator('[data-sec="out"] .file-row')).toHaveText([/Dijkstra/]);
  });

  test("renaming from the inline title rewrites links in other notes; the tab follows", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(() => window.brain.app.open("Learning/Linux/Docker.md"));
    const title = active(page).locator(".doc-title-input");
    await title.fill("Docker and Podman");
    await title.press("Enter");
    await expect(page.locator(".tab.on")).toContainText("Docker and Podman");
    expect(await page.evaluate(() => window.brain.tabs.active.id)).toBe("Learning/Linux/Docker and Podman.md");
    expect((await fileOf(page, CTFD)).body).toContain("[[Docker and Podman]]");
  });

  test("reading view: wikilinks open; missing ones are created in the root", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(() => window.brain.api.createItem({ title: "Links", body: "[[Dijkstra]] and [[Brand new idea]]" }));
    await page.evaluate(() => window.brain.app.reload());
    await page.evaluate(() => window.brain.app.open("Links.md", { mode: "read" }));
    await active(page).locator(".doc-reading a.wikilink", { hasText: "Dijkstra" }).click();
    await expect(page.locator(".tab.on")).toContainText("Dijkstra");
    await page.evaluate(() => window.brain.app.open("Links.md", { mode: "read" }));
    await active(page).locator(".doc-reading a.wikilink.unresolved").click();
    await expect(page.locator(".tab.on")).toContainText("Brand new idea");
    expect(await fileOf(page, "Brand new idea.md")).not.toBeNull();
  });

  test("Ctrl E toggles edit/reading; Ctrl W closes; tabs come back after reload", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(() => window.brain.app.open("Learning/CP/Dijkstra.md"));
    await page.evaluate(id => window.brain.app.open(id, { mode: "edit" }), HACK);
    await page.keyboard.press("Control+e");
    await expect(active(page).locator(".doc-reading")).toBeVisible();
    await page.keyboard.press("Control+e");
    await expect(active(page).locator(".doc-editor")).toBeVisible();
    await page.reload();
    await page.waitForFunction(() => window.brain?.app?.loaded);
    await expect(page.locator(".tab")).toHaveCount(3);
    await page.keyboard.press("Control+w");
    await expect(page.locator(".tab")).toHaveCount(2);
  });

  test("properties: edit, add, remove; tags too", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(id => window.brain.app.open(id), HACK);
    const props = active(page).locator(".props");
    await expect(props.locator(".prop-key")).toHaveText(["date", "role"]);
    await props.locator('.prop-value[data-key="role"]').fill("Team lead");
    await props.locator('.prop-value[data-key="role"]').press("Enter");
    await expect.poll(async () => (await fileOf(page, HACK)).props.role).toBe("Team lead");
    await props.locator('[data-act="add-prop"]').click();
    await page.keyboard.type("result");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Finalist");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await fileOf(page, HACK)).props.result).toBe("Finalist");
    await props.locator('.prop-row:has([data-key="date"]) .prop-del').click({ force: true });
    await expect.poll(async () => Object.keys((await fileOf(page, HACK)).props)).toEqual(["role", "result"]);
    await props.locator('[data-act="add-prop"]').click();
    await page.keyboard.type("tags");
    await page.keyboard.press("Enter");
    await page.keyboard.type("events, club");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await fileOf(page, HACK)).tags).toEqual(["events", "club"]);
    await props.locator('[data-untag="events"]').click();
    await expect.poll(async () => (await fileOf(page, HACK)).tags).toEqual(["club"]);
  });

  test("checkboxes in the reading view tick the task in the note", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(() => window.brain.app.open("College/Semester plan.md", { mode: "read" }));
    const boxes = active(page).locator(".doc-reading .task-box");
    await expect(boxes).toHaveCount(3);
    await boxes.nth(0).click();
    await expect.poll(async () => (await fileOf(page, "College/Semester plan.md")).body).toContain("- [x] Revise paging");
  });

  test("Ctrl Shift D opens today's daily note in the root, creating it once", async ({ page, errors }) => {
    await openApp(page);
    const day = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
    await page.keyboard.press("Control+Shift+D");
    await expect(page.locator(".tab.on")).toContainText(day);
    expect(await fileOf(page, `${day}.md`)).not.toBeNull();
    await page.locator(".tab.on .tab-close").click();
    await page.keyboard.press("Control+Shift+D");
    await expect(page.locator(".tab.on")).toContainText(day);
    expect(await page.evaluate(d => [...window.brain.app.items.values()].filter(n => n.title === d).length, day)).toBe(1);
  });
});

test.describe("right sidebar", () => {
  test("backlinks with context; unlinked mentions can be linked", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(() => window.brain.api.createItem({ title: "Lab setup", body: "Installed docker on the lab machines." }));
    await page.evaluate(() => window.brain.app.reload());
    await page.evaluate(() => window.brain.app.open("Learning/Linux/Docker.md"));
    const back = page.locator('[data-sec="back"]');
    await expect(back.locator(".file-row", { hasText: "CTFd setup" })).toBeVisible();
    await expect(back.locator(".row-ctx").first()).toContainText("Needs Docker");
    const mentions = page.locator('[data-sec="mentions"]');
    await expect(mentions.locator(".mention-row", { hasText: "Lab setup" })).toBeVisible();
    await mentions.locator(".mention-row", { hasText: "Lab setup" }).locator(".mention-link").click();
    await expect.poll(async () => (await fileOf(page, "Lab setup.md")).body).toBe("Installed [[Docker|docker]] on the lab machines.");
    await expect(back.locator(".file-row", { hasText: "Lab setup" })).toBeVisible();
  });

  test("outgoing links list notes that don't exist yet; clicking creates one", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(() => window.brain.api.createItem({ title: "Plans", body: "[[Dijkstra]] then [[Segment trees]]" }));
    await page.evaluate(() => window.brain.app.reload());
    await page.evaluate(() => window.brain.app.open("Plans.md"));
    await page.locator('#right-tabs .side-tab[title="Outgoing links"]').click();
    await expect(page.locator('[data-sec="out"] .file-row')).toHaveText([/Dijkstra/]);
    await page.locator('[data-sec="unresolved"] .unresolved-row').click();
    await expect(page.locator(".tab.on")).toContainText("Segment trees");
  });

  test("outline lists headings and jumps to them", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(() => window.brain.app.open("College/Sem 3/Operating systems.md"));
    await page.locator('#right-tabs .side-tab[title="Outline"]').click();
    await expect(page.locator(".outline-row")).toHaveText(["Memory", "Deadlock"]);
    await page.locator(".outline-row", { hasText: "Deadlock" }).click();
    await expect(active(page).locator(".cm-content")).toBeFocused();
    await expect(active(page).locator(".cm-activeLine")).toHaveText("## Deadlock");
  });
});

test.describe("palettes", () => {
  test("search by name and text; Enter in the graph focuses, Ctrl Enter opens", async ({ page, errors }) => {
    await openApp(page);
    await page.keyboard.press("Control+k");
    await page.keyboard.type("nginx");
    await expect(page.locator(".palette-results li").first()).toContainText("CTFd setup");
    await expect(page.locator(".palette-results li mark").first()).toHaveText(/nginx/i);
    await page.keyboard.press("Control+Enter");
    await expect(page.locator(".tab.on")).toContainText("CTFd setup");
    await page.keyboard.press("Control+g");
    await page.keyboard.press("/");
    await page.keyboard.type("jwt none");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => window.brain.app.selected), { timeout: 15_000 }).toBe("Coding Club/CTF/Writeup - JWT none alg.md");
  });

  test("command palette: fuzzy match, recent first", async ({ page, errors }) => {
    await openApp(page);
    await page.keyboard.press("Control+p");
    await page.keyboard.type("tog 2d");
    await expect(page.locator(".palette-results li").first()).toContainText("Toggle 2D / 3D graph");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.brain.graph.state.flat)).toBe(true);
    await page.keyboard.press("Control+p");
    await expect(page.locator(".palette-results li").first()).toContainText("Toggle 2D / 3D graph");
  });

  test("Enter right after typing picks the result for what was typed", async ({ page, errors }) => {
    await openApp(page);
    await page.keyboard.press("Control+k");
    await page.keyboard.type("dijkstra");
    await page.keyboard.press("Control+Enter");
    await expect(page.locator(".tab.on")).toContainText("Dijkstra");
  });
});

test.describe("regressions", () => {
  test("switching tabs never leaves keys typing into a hidden editor", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(id => window.brain.app.open(id, { mode: "edit" }), HACK);
    await active(page).locator(".cm-content").click();
    await page.keyboard.press("Control+g");
    await page.keyboard.type("vv");
    await page.waitForTimeout(700);
    expect((await fileOf(page, HACK)).body).not.toContain("vv");
  });

  test("[[ completion replaces auto-closed brackets", async ({ page, errors }) => {
    await openApp(page);
    await page.keyboard.press("Control+n");
    await page.keyboard.press("Enter");
    await page.keyboard.type("[[Two poi");
    await expect(page.locator(".cm-tooltip-autocomplete li").first()).toContainText("Two pointers");
    await page.waitForTimeout(150);
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await fileOf(page, "Untitled.md"))?.body).toBe("[[Two pointers]]");
  });

  test("hiding/closing the window flushes typing that hasn't autosaved yet", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(id => window.brain.app.open(id, { mode: "edit" }), HACK);
    await active(page).locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" LASTWORDS");
    await page.evaluate(() => dispatchEvent(new Event("pagehide")));
    await page.waitForTimeout(100); // well under the 500ms autosave
    expect((await fileOf(page, HACK)).body.endsWith(" LASTWORDS")).toBe(true);
  });
});

test.describe("canvas", () => {
  const BOARD = "Coding Club/CTF/CTF event plan.canvas";
  const stored = (page, id = BOARD) => page.evaluate(id => window.brain.api.getCanvas(id), id);
  const view = page => active(page).locator(".cv-view");
  async function openCanvas(page) {
    await openApp(page);
    await page.evaluate(id => window.brain.app.open(id), BOARD);
    await expect(active(page).locator(".cv-node")).toHaveCount(9);
  }

  test("the sample canvas shows cards, groups, arrows and links to its notes", async ({ page, errors }) => {
    await openCanvas(page);
    const pane = active(page);
    await expect(pane.locator(".cv-title")).toHaveValue("CTF event plan");
    await expect(pane.locator(".cv-group-label")).toHaveText(["Before the event", "On the day"]);
    await expect(pane.locator(".cv-edge")).toHaveCount(5);
    await expect(pane.locator(".cv-file .cv-head").first()).toContainText("Challenge design checklist");
    const back = await page.evaluate(() => window.brain.app.backlinks("Coding Club/CTF/Challenge design checklist.md").map(e => e.id));
    expect(back).toContain(BOARD);
  });

  test("double-click adds a card; typing, moving, undo and delete all save", async ({ page, errors }) => {
    await openCanvas(page);
    const box = await view(page).boundingBox();
    await page.mouse.dblclick(box.x + 120, box.y + box.height - 80);
    await expect(page.locator(".cv-edit")).toBeFocused();
    await page.keyboard.type("Remember the **flag format**");
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await stored(page)).nodes.length).toBe(10);
    const added = (await stored(page)).nodes.find(n => n.text?.includes("flag format"));
    const card = page.locator(`.cv-node[data-id="${added.id}"]`);
    const cb = await card.boundingBox();
    await page.mouse.move(cb.x + 20, cb.y + 20);
    await page.mouse.down();
    await page.mouse.move(cb.x + 70, cb.y + 20, { steps: 4 });
    await page.mouse.move(cb.x + 120, cb.y + 20, { steps: 4 });
    await page.mouse.up();
    const z = await page.evaluate(() => window.brain.tabs.active.view.camera.z);
    await expect.poll(async () => (await stored(page)).nodes.find(n => n.id === added.id).x).toBe(added.x + Math.round(100 / z));
    await view(page).press("Control+z");
    await expect.poll(async () => (await stored(page)).nodes.find(n => n.id === added.id).x).toBe(added.x);
    await card.click();
    await view(page).press("Delete");
    await expect(card).toHaveCount(0);
    await expect.poll(async () => (await stored(page)).nodes.length).toBe(9);
  });

  test("drag from a side dot to another card connects them; colours apply", async ({ page, errors }) => {
    await openCanvas(page);
    const from = page.locator('.cv-node[data-id="t-goal"]');
    const to = page.locator('.cv-node[data-id="l-ctfd"]');
    await from.hover();
    const pb = await from.locator('.cv-port[data-side="bottom"]').boundingBox();
    const tb = await to.boundingBox();
    await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + 5, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await stored(page)).edges.length).toBe(6);
    expect((await stored(page)).edges.at(-1)).toMatchObject({ fromNode: "t-goal", fromSide: "bottom", toNode: "l-ctfd", toSide: "top" });
    await from.click({ position: { x: 10, y: 10 } });
    await page.locator('.cv-swatches [data-color="5"]').click();
    await expect.poll(async () => (await stored(page)).nodes.find(n => n.id === "t-goal").color).toBe("5");
  });

  test("new canvas from the palette, add a note from search, rename", async ({ page, errors }) => {
    await openApp(page);
    await page.keyboard.press("Control+p");
    await page.keyboard.type("create new canvas");
    await page.keyboard.press("Enter");
    const title = active(page).locator(".cv-title");
    await expect(title).toBeFocused();
    await title.fill("Exam map");
    await title.press("Enter");
    await expect(page.locator(".tab.on")).toContainText("Exam map");
    expect(await page.evaluate(() => window.brain.tabs.active.id)).toBe("Exam map.canvas");
    await active(page).locator('[data-act="add-file"]').click();
    await page.keyboard.type("Dijkstra");
    await page.waitForTimeout(150);
    await page.keyboard.press("Enter");
    await expect(active(page).locator(".cv-file .cv-head")).toContainText("Dijkstra");
    await expect.poll(async () => (await stored(page, "Exam map.canvas")).nodes.map(n => n.file)).toEqual(["Learning/CP/Dijkstra.md"]);
  });

  test("a canvas opened in the background is fitted when it is first shown", async ({ page, errors }) => {
    await openApp(page);
    await page.evaluate(() => {
      const get = window.brain.api.getCanvas;
      window.brain.api.getCanvas = id => new Promise(r => setTimeout(r, 400)).then(() => get(id));
    });
    await page.evaluate(id => window.brain.tabs.openItem(id, { background: true }), BOARD);
    await page.waitForTimeout(300);
    await page.evaluate(id => window.brain.tabs.activate(`item:${id}`), BOARD);
    await expect.poll(() => page.evaluate(() => window.brain.tabs.active.view.camera?.z)).toBeLessThan(1);
  });

  test("dropping a file from the explorer adds it as a card", async ({ page, errors }) => {
    await openCanvas(page);
    const box = await view(page).boundingBox();
    await page.evaluate(({ x, y }) => {
      const dt = new DataTransfer();
      dt.setData("application/x-brain-item", "Learning/CP/Dijkstra.md");
      const el = document.querySelector(".pane:not([hidden]) .cv-view");
      el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    }, { x: box.x + 200, y: box.y + box.height - 100 });
    await expect.poll(async () => (await stored(page)).nodes.some(n => n.file === "Learning/CP/Dijkstra.md")).toBe(true);
  });
});
