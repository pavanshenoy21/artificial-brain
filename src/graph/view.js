// The graph tab: 3d-force-graph with a flat look.
//
// Structure comes from folders:
//   lobe (top-level folder)   only its name, in the lobe's colour, at the root of a tree
//   group (subfolder)         a small hub in the group's colour; its notes hang off it
//   note                      a sphere in its group's colour
// Tree lines (note -> hub -> lobe name) show where things live; plain grey
// lines are your [[wikilinks]]. Focus mode, semantic zoom, fly-to-lobe and a
// 2D/3D switch work on top of that.

import ForceGraph3D from "3d-force-graph";
import * as THREE from "three";
import SpriteText from "three-spritetext";
import { app } from "../state.js";
import { folderOf, lobeOf, lobeCenters } from "../lib/folders.js";
import { esc, reduceMotion } from "../util.js";
import { prefs } from "../lib/prefs.js";
import { fileMenu, folderMenu } from "../sidebar/menus.js";

const idOf = x => (x && typeof x === "object" ? x.id : x);
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const depth = f => (f ? f.split("/").length : 0);

export function createGraphView(container) {
  container.innerHTML = `
    <div class="graph-canvas"></div>
    <div class="graph-bar">
      <div class="graph-focus" hidden><span class="graph-focus-label"></span><button type="button" class="btn-link" data-act="clear">Esc to clear</button></div>
      <div class="graph-tools">
        <div class="seg" role="group" aria-label="View" title="2D / 3D (V)">
          <button type="button" data-mode="2d">2D</button><button type="button" data-mode="3d">3D</button>
        </div>
        <button type="button" class="btn-link" data-act="fit" title="Fit the whole graph in view">Fit</button>
        <label class="check" title="Lines from notes to their folder and lobe"><input type="checkbox" data-opt="tree" /> Folders</label>
        <label class="check" data-orbit><input type="checkbox" data-opt="orbit" /> Orbit</label>
      </div>
    </div>
    <div class="graph-hint"><span data-hint-drag>drag to rotate</span> · scroll to zoom · click to focus · double-click to open</div>`;
  const el = container.querySelector(".graph-canvas");

  const state = {
    focus: null,           // { kind: "node", node } | { kind: "set", ids, label, color? }
    levels: new Map(),     // note id -> 0 focus, 1 neighbour, 2 second ring, 3 background
    hover: null,
    showTree: prefs.get("graph.tree", true),
    orbit: prefs.get("graph.orbit", false),
    flat: prefs.get("graph.view", "3d") === "2d",
  };
  const level = n => (state.focus ? state.levels.get(idOf(n)) ?? 3 : 0);
  let theme = {};
  function readTheme() {
    theme = { bg: cssVar("--graph-bg"), link: cssVar("--graph-link"), label: cssVar("--graph-label"), accent: cssVar("--accent") };
  }
  readTheme();

  // ---------------------------------------------------------------- nodes
  // Graph nodes: every note (from app.items), one hub per subfolder and one
  // label-only anchor per lobe. Hubs and anchors are kept across reloads so
  // the layout doesn't jump.
  const hubs = new Map();     // "folder:<path>" -> node
  const anchors = new Map();  // "lobe:<name>" -> node
  let nodes = [];             // what the force layout sees
  const notes = () => [...app.items.values()].filter(n => n.type === "note");
  const colorOf = n => (n.kind === "folder" ? app.scheme.folder(n.path) : n.kind === "lobe" ? app.scheme.lobe(n.name) : app.colorOf(n));

  const geoCache = new Map();
  const sphere = size => {
    const step = Math.round(size * 4) / 4;
    if (!geoCache.has(step)) geoCache.set(step, new THREE.SphereGeometry(step, 18, 12));
    return geoCache.get(step);
  };
  const font = () => cssVar("--font") || "system-ui, sans-serif";

  function makeNode(n) {
    const group = new THREE.Group();
    if (n.kind === "lobe") {
      // a lobe is only its name
      const label = new SpriteText(n.name, 7, colorOf(n));
      Object.assign(label, { fontFace: font(), fontWeight: "600", renderOrder: 5 });
      label.material.depthTest = false;
      label.material.depthWrite = false;
      label.material.transparent = true;
      group.add(label);
      n.__v = { group, label, mesh: null, size: 0 };
      return group;
    }
    const size = n.kind === "folder" ? 1.9 : 3 * (1 + Math.min(n.degree || 0, 8) * 0.05);
    const mesh = new THREE.Mesh(sphere(size), new THREE.MeshLambertMaterial({ color: colorOf(n) }));
    group.add(mesh);
    n.__v = { mesh, group, label: null, size };
    return group;
  }

  function ensureLabel(n) {
    const v = n.__v;
    if (v.label) return v.label;
    const hub = n.kind === "folder";
    const label = new SpriteText(hub ? n.name : n.title, hub ? 3 : 2.1, hub ? colorOf(n) : theme.label);
    Object.assign(label, { fontFace: font(), fontWeight: hub ? "600" : "500", renderOrder: 10 });
    label.position.y = -(v.size * 1.4 + 3);
    label.material.depthTest = false;
    label.material.depthWrite = false;
    v.group.add(label);
    v.label = label;
    return label;
  }

  // One selection outline, moved to whichever node is focused.
  const outline = new THREE.Mesh(undefined, new THREE.MeshBasicMaterial({ color: theme.accent, side: THREE.BackSide, transparent: true }));
  outline.scale.setScalar(1.28);

  // ---------------------------------------------------------------- links
  // Two merged line batches with per-vertex colour + alpha: wikilinks (grey)
  // and the folder tree (in the child's colour). One object per link made big
  // vaults crawl.
  const batches = {
    wiki: new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false })),
    tree: new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false })),
  };
  for (const b of Object.values(batches)) { b.renderOrder = -1; b.frustumCulled = false; }
  let graphLinks = [];
  let shown = { wiki: [], tree: [] };

  const nodeOf = x => (x && typeof x === "object" ? x : app.items.get(x) || hubs.get(x) || anchors.get(x));
  // a hub's or anchor's focus level: the closest of its notes
  const levelOf = n => (n.kind ? Math.min(3, ...[...n.members].map(id => level(id))) : level(n));
  const isFocusEdge = l => state.focus?.kind === "node" && (idOf(l.source) === state.focus.node.id || idOf(l.target) === state.focus.node.id);

  function linkStyle(l) {
    const a0 = levelOf(nodeOf(l.source)), b0 = levelOf(nodeOf(l.target));
    const worst = Math.max(a0, b0);
    if (l.kind === "tree") {
      const child = nodeOf(l.source);
      const a = !state.focus ? 0.4 : worst <= 1 ? 0.55 : worst <= 2 ? 0.12 : 0.04;
      return [colorOf(child), a];
    }
    let a;
    if (!state.focus) a = 0.85;
    else if (isFocusEdge(l)) a = 1;
    else if (worst <= 1) a = 0.6;
    else if (worst <= 2) a = 0.15;
    else a = 0.05;
    return [isFocusEdge(l) ? theme.accent : theme.link, a];
  }

  function rebuildLinks() {
    shown = { wiki: graphLinks.filter(l => l.kind === "wiki"), tree: state.showTree ? graphLinks.filter(l => l.kind === "tree") : [] };
    for (const k of ["wiki", "tree"]) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(shown[k].length * 6), 3));
      g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(shown[k].length * 8), 4));
      batches[k].geometry.dispose();
      batches[k].geometry = g;
    }
    positionLinks();
    colorLinks();
  }

  function positionLinks() {
    for (const k of ["wiki", "tree"]) {
      const pos = batches[k].geometry.attributes.position;
      if (!pos) continue;
      shown[k].forEach((l, i) => {
        const a = nodeOf(l.source), b = nodeOf(l.target);
        if (!a || !b) return;
        pos.setXYZ(i * 2, a.x || 0, a.y || 0, a.z || 0);
        pos.setXYZ(i * 2 + 1, b.x || 0, b.y || 0, b.z || 0);
      });
      pos.needsUpdate = true;
    }
  }

  const tmpColor = new THREE.Color();
  function colorLinks() {
    for (const k of ["wiki", "tree"]) {
      const col = batches[k].geometry.attributes.color;
      if (!col) continue;
      shown[k].forEach((l, i) => {
        const [c, a] = linkStyle(l);
        tmpColor.set(c);
        col.setXYZW(i * 2, tmpColor.r, tmpColor.g, tmpColor.b, a);
        col.setXYZW(i * 2 + 1, tmpColor.r, tmpColor.g, tmpColor.b, a);
      });
      col.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------- graph
  const tip = n => {
    if (n.kind === "lobe") return `<div class="tip"><span class="dot" style="background:${colorOf(n)}"></span><b>${esc(n.name)}</b><span>${n.members.size} notes</span></div>`;
    if (n.kind === "folder") return `<div class="tip"><span class="dot" style="background:${colorOf(n)}"></span><b>${esc(n.name)}</b><span>${esc(n.path)} · ${n.members.size} notes</span></div>`;
    return `<div class="tip"><span class="dot" style="background:${colorOf(n)}"></span><b>${esc(n.title)}</b><span>${esc(folderOf(n.path) || "vault root")}</span></div>`;
  };
  const Graph = new ForceGraph3D(el, { controlType: "orbit" })
    .backgroundColor(theme.bg)
    .showNavInfo(false)
    .nodeThreeObject(makeNode)
    .nodeLabel(tip)
    .linkVisibility(false) // drawn by the merged batches above
    .onNodeClick(onNodeClick)
    .onNodeRightClick((n, e) => {
      const at = { x: e.clientX, y: e.clientY };
      if (n.kind === "folder") folderMenu(n.path, at);
      else if (n.kind === "lobe") folderMenu(n.name, at);
      else fileMenu(n.id, at);
    })
    .onNodeHover(n => { state.hover = n; el.style.cursor = n ? "pointer" : ""; })
    .onBackgroundClick(() => { if (state.focus) api.clearFocus(); })
    .onEngineTick(() => { engineRunning = true; positionLinks(); })
    .onEngineStop(() => {
      engineRunning = false;
      positionLinks();
      if (!fitted && !userMoved && !state.focus) { fitted = true; fitAll(); }
      idleSoon();
    })
    .warmupTicks(80)
    .cooldownTicks(220);

  let lastClick = { id: null, t: 0 };
  function onNodeClick(n) {
    if (n.kind === "lobe") { focusFolder(n.name); return; }
    if (n.kind === "folder") { focusFolder(n.path); return; }
    const t = performance.now();
    if (lastClick.id === n.id && t - lastClick.t < 400) {
      lastClick = { id: null, t: 0 };
      app.open(n.id);
      return;
    }
    lastClick = { id: n.id, t };
    app.select(n.id, { source: "graph" });
  }

  // forces: each lobe gathers around its centre (anchors are pinned there),
  // the tree pulls notes to their folder, wikilinks across lobes pull weakly
  let centers = new Map();
  function lobeForce(strength) {
    let ns = [];
    const f = alpha => {
      for (const n of ns) {
        if (n.kind === "lobe") continue;
        const c = centers.get(n.lobe ?? "") || [0, 0, 0];
        n.vx += (c[0] - n.x) * strength * alpha;
        n.vy += (c[1] - n.y) * strength * alpha;
        if (state.flat) n.vz -= n.z * 0.2; // not scaled by alpha: keeps pulling until flat
        else n.vz += (c[2] - n.z) * strength * alpha;
      }
    };
    f.initialize = x => { ns = x; };
    return f;
  }
  const lobeKey = n => (n.kind === "lobe" ? n.name : n.kind === "folder" ? lobeOf(`${n.path}/x`) : lobeOf(n.path) ?? "");
  Graph.d3Force("center", null);
  Graph.d3Force("charge").strength(n => (n.kind === "lobe" ? -120 : n.kind === "folder" ? -70 : -40)).distanceMax(170);
  Graph.d3Force("link")
    .distance(l => (l.kind === "tree" ? (nodeOf(l.target)?.kind === "lobe" ? 30 : 16) : 24))
    .strength(l => (l.kind === "tree" ? 0.5 : lobeKey(nodeOf(l.source)) === lobeKey(nodeOf(l.target)) ? 0.25 : 0.008));
  Graph.d3Force("lobe", lobeForce(0.1));

  // ---------------------------------------------------------------- render on demand
  // 3d-force-graph redraws every frame forever. Once the layout has settled
  // and nothing moves, stop the loop (0% CPU when idle) and wake it on any
  // interaction, camera move, data change or theme change.
  let engineRunning = true;
  let paused = false;
  let awakeUntil = 0;
  let idleTimer2;
  function wake(ms = 1500) {
    awakeUntil = Math.max(awakeUntil, performance.now() + ms);
    if (paused) { paused = false; Graph.resumeAnimation(); }
    idleSoon();
  }
  function idleSoon() {
    clearTimeout(idleTimer2);
    idleTimer2 = setTimeout(() => {
      const busy = engineRunning || Graph.controls().autoRotate || performance.now() < awakeUntil;
      if (busy && container.offsetParent) return idleSoon();
      paused = true;
      Graph.pauseAnimation();
    }, Math.max(250, awakeUntil - performance.now() + 50));
  }
  const camera = Graph.cameraPosition.bind(Graph);
  Graph.cameraPosition = (...a) => {
    if (a.length) wake((a[2] || 0) + 500);
    return camera(...a);
  };
  for (const ev of ["pointerdown", "pointermove", "wheel", "keydown", "pointerup"])
    el.addEventListener(ev, () => wake(ev === "pointermove" ? 600 : 1500), { passive: true });
  const reheat = Graph.d3ReheatSimulation.bind(Graph);
  Graph.d3ReheatSimulation = () => { engineRunning = true; wake(); return reheat(); };

  // GPU driver crashes (e.g. "device lost") kill the WebGL context. Keep the
  // rest of the app working and say what happened instead of hanging.
  const canvas = Graph.renderer().domElement;
  const lost = document.createElement("div");
  lost.className = "empty-state graph-lost";
  lost.hidden = true;
  lost.innerHTML = `<p class="empty-title">The graph stopped: the GPU driver reset.</p>
    <p class="muted">Everything else keeps working. If this keeps happening, see "GPU crashes" in the README.</p>
    <div class="empty-actions"><button type="button" class="btn primary" data-act="reload-graph">Reload</button></div>`;
  container.appendChild(lost);
  lost.addEventListener("click", e => { if (e.target.closest('[data-act="reload-graph"]')) location.reload(); });
  canvas.addEventListener("webglcontextlost", e => {
    e.preventDefault();
    paused = true;
    Graph.pauseAnimation();
    lost.hidden = false;
    console.error("WebGL context lost (GPU driver reset)");
  });
  canvas.addEventListener("webglcontextrestored", () => { lost.hidden = true; wake(); });

  Graph.scene().add(batches.wiki, batches.tree);

  // Frame the whole graph once the first layout settles (unless the user has
  // already moved the camera), so any vault size starts fully in view.
  const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0; };
  let fitted = false;
  let userMoved = false;
  function fitAll(ms = 600) {
    const ns = nodes.filter(n => n.x !== undefined);
    if (!ns.length) return;
    const c = new THREE.Vector3();
    for (const n of ns) c.add(new THREE.Vector3(n.x, n.y, n.z));
    c.divideScalar(ns.length);
    const r = pct(ns.map(n => c.distanceTo(new THREE.Vector3(n.x, n.y, n.z))), 0.95) + 25;
    const cam = Graph.camera();
    const aspect = el.clientWidth / Math.max(1, el.clientHeight);
    const half = THREE.MathUtils.degToRad(cam.fov / 2);
    const dist = Math.max(120, r / Math.sin(Math.min(half, Math.atan(Math.tan(half) * aspect))));
    const dir = state.flat ? new THREE.Vector3(0, 0, 1) : cam.position.clone().sub(controls.target).normalize();
    Graph.cameraPosition(c.clone().add(dir.multiplyScalar(dist)), c, reduceMotion() ? 0 : ms);
  }

  // ---------------------------------------------------------------- data
  let lastShape = "";
  // What the layout depends on. Saving a note's text changes none of it, so
  // the graph isn't rebuilt (and re-laid-out) on every autosave.
  const shapeOf = () => JSON.stringify([
    notes().map(n => [n.id, n.degree]),
    app.links.map(l => [l.source, l.target]),
    app.colors,
  ]);

  function setData() {
    const shape = shapeOf();
    if (shape === lastShape) {
      for (const n of app.items.values()) if (n.__v?.label && n.__v.label.text !== n.title) n.__v.label.text = n.title;
      refocus();
      return;
    }
    lastShape = shape;
    const ns = notes();
    const ids = new Set(ns.map(n => n.id));

    // hubs for every subfolder that holds notes (at any depth), anchors for lobes
    const wantHubs = new Map(), wantLobes = new Map();
    const tree = [];
    const member = (map, key, make, id) => {
      if (!map.has(key)) map.set(key, make());
      map.get(key).add(id);
    };
    for (const n of ns) {
      let f = folderOf(n.path);
      if (!f) continue;
      const parentOf = f2 => (depth(f2) >= 2 ? `folder:${f2}` : `lobe:${f2}`);
      tree.push({ source: n.id, target: parentOf(f), kind: "tree" });
      for (; f; f = folderOf(f)) {
        if (depth(f) >= 2) member(wantHubs, f, () => new Set(), n.id);
        else member(wantLobes, f, () => new Set(), n.id);
      }
    }
    for (const [path, members] of wantHubs) {
      const key = `folder:${path}`;
      const p = folderOf(path);
      tree.push({ source: key, target: depth(p) >= 2 ? `folder:${p}` : `lobe:${p}`, kind: "tree" });
      const h = hubs.get(key) || { id: key, kind: "folder", path, name: path.split("/").pop() };
      h.members = members;
      h.lobe = lobeOf(`${path}/x`);
      hubs.set(key, h);
    }
    for (const k of [...hubs.keys()]) if (!wantHubs.has(k.slice(7))) hubs.delete(k);
    for (const [name, members] of wantLobes) {
      const key = `lobe:${name}`;
      const a = anchors.get(key) || { id: key, kind: "lobe", name };
      a.members = members;
      anchors.set(key, a);
    }
    for (const k of [...anchors.keys()]) if (!wantLobes.has(k.slice(5))) anchors.delete(k);

    // lobe centres: biggest lobe in the middle; anchors are pinned there
    const counts = new Map([...wantLobes].map(([k, v]) => [k, v.size]));
    counts.set("", ns.filter(n => !lobeOf(n.path)).length);
    centers = lobeCenters([...wantLobes.keys(), ""], counts);
    for (const a of anchors.values()) {
      const c = centers.get(a.name);
      [a.fx, a.fy, a.fz] = [c[0], c[1], state.flat ? 0 : c[2]];
      if (a.__v) a.__v.label.color = colorOf(a); // colours may have been picked
    }
    for (const n of [...ns, ...hubs.values()]) {
      n.lobe = lobeKey(n);
      if (n.__v) {
        n.__v.mesh.material.color.set(colorOf(n));
        if (n.kind === "folder" && n.__v.label) n.__v.label.color = colorOf(n);
      }
      if (n.x !== undefined) continue;
      // new node: start near its lobe so the layout settles fast
      const c = centers.get(n.lobe) || [0, 0, 0];
      n.x = c[0] + (Math.random() - 0.5) * 30;
      n.y = c[1] + (Math.random() - 0.5) * 30;
      n.z = state.flat ? 0 : c[2] + (Math.random() - 0.5) * 30;
    }
    nodes = [...ns, ...hubs.values(), ...anchors.values()];
    graphLinks = [
      ...app.links.filter(l => ids.has(l.source) && ids.has(l.target)).map(l => ({ source: l.source, target: l.target, kind: "wiki" })),
      ...tree,
    ];
    engineRunning = true;
    wake();
    Graph.graphData({ nodes, links: graphLinks });
    rebuildLinks();
    refocus();
  }

  function refocus() {
    if (state.focus?.kind === "node") {
      const n = app.items.get(state.focus.node.id);
      if (n) { state.focus.node = n; state.levels = bfsLevels([n.id]); } else state.focus = null;
    } else if (state.focus?.kind === "set") {
      state.focus.ids = state.focus.ids.filter(id => app.items.has(id));
      if (state.focus.ids.length) state.levels = setLevels(state.focus.ids); else state.focus = null;
    }
    applyFocusVisuals();
  }

  // ---------------------------------------------------------------- focus
  function bfsLevels(startIds, maxDepth = 2) {
    const lv = new Map(startIds.map(id => [id, 0]));
    let frontier = [...startIds];
    for (let d = 1; d <= maxDepth; d++) {
      const next = [];
      for (const id of frontier)
        for (const e of app.adj.get(id) || [])
          if (!lv.has(e.id)) { lv.set(e.id, d); next.push(e.id); }
      frontier = next;
    }
    return lv;
  }
  // a set (folder, lobe, …): its notes stay lit, their direct links half-lit
  function setLevels(ids) {
    const lv = bfsLevels(ids, 1);
    for (const id of ids) lv.set(id, 1);
    for (const [id, d] of lv) if (d === 1 && !ids.includes(id)) lv.set(id, 2);
    return lv;
  }

  const bar = container.querySelector(".graph-focus");
  function applyFocusVisuals() {
    wake(600);
    for (const n of nodes) {
      const v = n.__v;
      if (!v) continue;
      const lv = levelOf(n);
      if (v.mesh) {
        v.mesh.material.opacity = [1, 1, 0.3, 0.08][lv];
        const faded = lv >= 2;
        if (v.mesh.material.transparent !== faded) { v.mesh.material.transparent = faded; v.mesh.material.needsUpdate = true; }
        v.mesh.material.depthWrite = lv < 2;
      }
    }
    colorLinks();
    outline.removeFromParent();
    const fv = state.focus?.kind === "node" ? state.focus.node.__v : null;
    if (fv?.mesh) {
      outline.geometry = fv.mesh.geometry;
      outline.material.color.set(theme.accent);
      fv.group.add(outline);
    }
    bar.hidden = !state.focus;
    if (state.focus) {
      const f = state.focus;
      bar.querySelector(".graph-focus-label").innerHTML = f.kind === "node"
        ? `<span class="dot" style="background:${app.colorOf(f.node)}"></span><b>${esc(f.node.title)}</b>`
        : `${f.color ? `<span class="dot" style="background:${f.color}"></span>` : ""}<b>${esc(f.label || `${f.ids.length} notes`)}</b>`;
    }
  }

  function flyTo(n, ms = 700, dist = 140) {
    const target = new THREE.Vector3(n.x, n.y, n.z);
    const cam = Graph.camera();
    const dir = cam.position.clone().sub(Graph.controls().target).normalize();
    if (state.flat) dir.set(0, 0, 1);
    Graph.cameraPosition(target.clone().add(dir.multiplyScalar(dist)), target, reduceMotion() ? 0 : ms);
  }

  function focusNode(n, { fly = true } = {}) {
    if (!n || n.type !== "note") return;
    state.focus = { kind: "node", node: n };
    state.levels = bfsLevels([n.id]);
    applyFocusVisuals();
    pauseOrbit();
    if (fly) flyTo(n);
  }

  // Light up a set of notes and fly so all of it is in view.
  function focusSet(ids, label, color) {
    ids = ids.filter(id => app.items.get(id)?.type === "note");
    if (!ids.length) return;
    state.focus = { kind: "set", ids, label, color };
    state.levels = setLevels(ids);
    applyFocusVisuals();
    pauseOrbit();
    const ns = ids.map(id => app.items.get(id));
    const c = new THREE.Vector3();
    for (const n of ns) c.add(new THREE.Vector3(n.x, n.y, n.z));
    c.divideScalar(ns.length);
    const r = Math.max(...ns.map(n => c.distanceTo(new THREE.Vector3(n.x, n.y, n.z))));
    flyTo({ x: c.x, y: c.y, z: c.z }, 800, Math.max(110, r * 3));
  }

  // A folder or lobe: everything inside it.
  function focusFolder(path) {
    const ids = notes().filter(n => n.path.startsWith(`${path}/`)).map(n => n.id);
    focusSet(ids, path.split("/").pop(), app.scheme.folder(path));
  }

  function clearFocus() {
    if (!state.focus) return;
    state.focus = null;
    state.levels = new Map();
    applyFocusVisuals();
    resumeOrbitSoon(2500);
    app.emit("graph-focus-cleared");
  }

  // ---------------------------------------------------------------- idle orbit
  const controls = Graph.controls();
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.autoRotateSpeed = 0.3;
  let idleTimer;
  const canOrbit = () => state.orbit && !state.flat && !state.focus && !reduceMotion();
  function pauseOrbit() { controls.autoRotate = false; clearTimeout(idleTimer); }
  function resumeOrbitSoon(ms = 9000) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if ((controls.autoRotate = canOrbit())) wake(); }, ms);
  }
  el.addEventListener("pointerdown", () => { userMoved = true; pauseOrbit(); resumeOrbitSoon(); });
  el.addEventListener("wheel", () => { userMoved = true; pauseOrbit(); resumeOrbitSoon(); }, { passive: true });

  // ---------------------------------------------------------------- per frame: semantic zoom
  // Far away: lobe names. Middle: lobe and folder names. Close: note names.
  const tmp = new THREE.Vector3();
  let raf;
  function frame() {
    raf = requestAnimationFrame(frame);
    if (!container.offsetParent || paused) return; // tab hidden or graph idle
    const cam = Graph.camera();
    const camDist = cam.position.distanceTo(controls.target);
    const far = camDist > 380;
    for (const n of nodes) {
      const v = n.__v;
      if (!v) continue;
      if (n.kind === "lobe") {
        const lit = levelOf(n) <= 1;
        v.label.material.opacity = state.focus ? (lit ? 1 : 0.12) : far ? 1 : 0.8;
        continue;
      }
      let show;
      if (n.kind === "folder") show = state.focus ? levelOf(n) <= 1 : !far;
      else if (state.focus) show = level(n) <= 1;
      else show = !far && tmp.set(n.x, n.y, n.z).distanceTo(cam.position) < 160;
      if (n === state.hover) show = true;
      if (show) ensureLabel(n).visible = true;
      else if (v.label) v.label.visible = false;
    }
  }
  raf = requestAnimationFrame(frame);

  // ---------------------------------------------------------------- 2D / 3D
  // 2D reuses the 3D scene: a force flattens every node onto z = 0 and the
  // camera locks top-down (drag pans instead of rotating).
  const orbitBox = container.querySelector("[data-orbit] input");
  function syncToolbar() {
    controls.enableRotate = !state.flat;
    controls.mouseButtons.LEFT = state.flat ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    controls.touches.ONE = state.flat ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
    container.querySelector("[data-hint-drag]").textContent = state.flat ? "drag to pan" : "drag to rotate";
    for (const b of container.querySelectorAll("[data-mode]")) b.classList.toggle("on", (b.dataset.mode === "2d") === state.flat);
    container.querySelector('[data-opt="tree"]').checked = state.showTree;
    orbitBox.checked = state.orbit;
    orbitBox.disabled = state.flat;
    container.querySelector("[data-orbit]").classList.toggle("disabled", state.flat);
    if ((controls.autoRotate = canOrbit())) wake();
  }

  function setViewMode(flat) {
    if (flat === state.flat) return;
    state.flat = flat;
    prefs.set("graph.view", flat ? "2d" : "3d");
    const instant = reduceMotion();
    for (const a of anchors.values()) a.fz = flat ? 0 : centers.get(a.name)?.[2] ?? 0;
    for (const n of nodes) {
      if (flat && instant) { n.z = 0; n.vz = 0; }
      // un-flattening: a little z jitter so charge can push nodes apart in depth again
      if (!flat && !n.kind) n.z += (Math.random() - 0.5) * 20;
    }
    Graph.d3ReheatSimulation();
    pauseOrbit();
    syncToolbar();
    const t = controls.target.clone();
    const dist = Math.max(120, Graph.camera().position.distanceTo(t));
    if (flat) {
      t.z = 0;
      Graph.cameraPosition(t.clone().setZ(dist), t, instant ? 0 : 700);
    } else {
      const pos = t.clone().add(new THREE.Vector3(0.35, 0.3, 1).normalize().multiplyScalar(dist));
      Graph.cameraPosition(pos, t, instant ? 0 : 700);
      if (!state.focus) resumeOrbitSoon();
    }
    app.emit("graph-view", { flat });
  }

  container.querySelector(".graph-bar").addEventListener("click", e => {
    const b = e.target.closest("[data-mode]");
    if (b) setViewMode(b.dataset.mode === "2d");
    if (e.target.closest('[data-act="clear"]')) api.clearFocus();
    if (e.target.closest('[data-act="fit"]')) fitAll();
  });
  container.querySelector(".graph-bar").addEventListener("change", e => {
    const opt = e.target.dataset.opt;
    if (opt === "tree") {
      state.showTree = e.target.checked;
      prefs.set("graph.tree", state.showTree);
      rebuildLinks();
      wake();
    }
    if (opt === "orbit") {
      state.orbit = e.target.checked;
      prefs.set("graph.orbit", state.orbit);
      if ((controls.autoRotate = canOrbit())) wake();
    }
  });

  // ---------------------------------------------------------------- sizing + theme
  const ro = new ResizeObserver(() => {
    wake();
    if (el.clientWidth && el.clientHeight) Graph.width(el.clientWidth).height(el.clientHeight);
  });
  ro.observe(el);

  function applyTheme() {
    readTheme();
    Graph.backgroundColor(theme.bg);
    for (const n of nodes) {
      if (!n.__v) continue;
      if (n.__v.label && !n.kind) n.__v.label.color = theme.label;
      if (n.__v.mesh) n.__v.mesh.material.color.set(colorOf(n));
    }
    applyFocusVisuals();
  }

  // ---------------------------------------------------------------- public
  const api = {
    Graph,
    state,
    setData,
    focusNode,
    focusFolder,
    focusSet,
    clearFocus,
    setViewMode,
    toggleView: () => setViewMode(!state.flat),
    fitAll,
    applyTheme,
    // for tests and devtools: the structure the graph built from folders
    get structure() {
      return {
        lobes: [...anchors.values()].map(a => ({ name: a.name, color: colorOf(a), notes: a.members.size })),
        folders: [...hubs.values()].map(h => ({ path: h.path, color: colorOf(h), notes: h.members.size })),
        tree: graphLinks.filter(l => l.kind === "tree").map(l => [idOf(l.source), idOf(l.target)]),
      };
    },
    // Screen position (viewport px) of a node, for the travel animation.
    screenPos(n) {
      const p = Graph.graph2ScreenCoords(n.x, n.y, n.z);
      const r = el.getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    },
    flyTo,
    destroy() { cancelAnimationFrame(raf); ro.disconnect(); Graph._destructor?.(); },
  };

  syncToolbar();
  Graph.cameraPosition(state.flat ? { x: 0, y: 0, z: 560 } : { x: 0, y: 60, z: 560 }, { x: 0, y: 0, z: 0 });
  return api;
}
