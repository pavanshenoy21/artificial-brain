// A sample canvas for "Import sample data": planning a college CTF on a board,
// mixing text cards, cards that show vault notes, a link, groups and arrows.

export const SAMPLE_CANVAS_TITLE = "CTF event plan";

// `pathOf(title)` gives the vault path of a sample item (null if missing).
export function sampleCanvas(pathOf) {
  const file = (id, title, x, y, w = 360, h = 220, extra = {}) =>
    pathOf(title) ? [{ id, type: "file", file: pathOf(title), x, y, width: w, height: h, ...extra }] : [];
  const nodes = [
    { id: "g-before", type: "group", label: "Before the event", x: -40, y: -60, width: 860, height: 620 },
    { id: "g-day", type: "group", label: "On the day", x: 900, y: -60, width: 560, height: 620, color: "4" },
    { id: "t-goal", type: "text", x: 0, y: 0, width: 360, height: 120,
      text: "## Goal\nRun a 24h CTF for ~40 teams with challenges that teach, not frustrate. #ctf" },
    ...file("f-check", "CTF challenge design checklist", 420, 0, 360, 220),
    ...file("f-rsa", "Crypto challenge ideas: small e RSA", 0, 180, 360, 200, { color: "6" }),
    { id: "t-todo", type: "text", x: 420, y: 280, width: 360, height: 220,
      text: "### To do\n- [ ] 3 web, 3 pwn, 2 crypto challenges\n- [ ] test every solve script\n- [ ] dry run with seniors\n\nSee [[Per-team challenge containers]]" },
    { id: "l-ctfd", type: "link", url: "https://ctfd.io", x: 0, y: 420, width: 360, height: 100 },
    ...file("f-deploy", "CTFd deployment notes", 940, 0, 480, 220),
    { id: "t-day", type: "text", x: 940, y: 280, width: 480, height: 220, color: "2",
      text: "### Checklist\n1. Back up the database\n2. Watch the scoreboard and container load\n3. Announce hints at the 12h mark" },
  ];
  const ids = new Set(nodes.map(n => n.id));
  const edges = [
    { id: "e1", fromNode: "t-goal", fromSide: "right", toNode: "f-check", toSide: "left", label: "every challenge" },
    { id: "e2", fromNode: "f-check", fromSide: "bottom", toNode: "t-todo", toSide: "top" },
    { id: "e3", fromNode: "f-rsa", fromSide: "right", toNode: "t-todo", toSide: "left" },
    { id: "e4", fromNode: "t-todo", fromSide: "right", toNode: "f-deploy", toSide: "left", label: "then deploy", color: "4" },
    { id: "e5", fromNode: "f-deploy", fromSide: "bottom", toNode: "t-day", toSide: "top" },
  ].filter(e => ids.has(e.fromNode) && ids.has(e.toNode));
  return { nodes, edges };
}

// Adds the sample canvas to a vault through the normal API (desktop import
// and the browser preview's seed both use this).
export async function importSampleCanvas(api) {
  const g = await api.loadGraph();
  if (g.nodes.some(n => n.type === "canvas" && n.title === SAMPLE_CANVAS_TITLE)) return null;
  const byTitle = new Map(g.nodes.map(n => [n.title, n.path]));
  const c = await api.createCanvas(SAMPLE_CANVAS_TITLE);
  return api.saveCanvas(c.id, sampleCanvas(t => byTitle.get(t) || null));
}
