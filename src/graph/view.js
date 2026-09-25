// The graph tab: 3d-force-graph with a flat look (solid lobe colours, plain
// lines), focus mode, semantic zoom, type filters, fly-to-lobe and a 2D/3D switch.

import ForceGraph3D from "3d-force-graph";
import * as THREE from "three";
import SpriteText from "three-spritetext";
import { app } from "../state.js";
import { GEOMETRIES, BASE_SIZE } from "./shapes.js";
import { lobeCenters, UNSORTED } from "../lib/lobes.js";
import { TYPES, TYPE } from "../lib/types.js";
import { typeIcon } from "../icons.js";
import { esc, reduceMotion } from "../util.js";
import { prefs } from "../lib/prefs.js";
import { itemMenu } from "../ai/actions.js";

const idOf = x => (x && typeof x === "object" ? x.id : x);
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function createGraphView(container) {
  container.innerHTML = `
    <div class="graph-canvas"></div>
    <div class="graph-bar">
      <div class="graph-focus" hidden><span class="graph-focus-label"></span><button type="button" class="btn-link" data-act="clear">Esc to clear</button></div>
      <div class="graph-tools">
        <div class="seg" role="group" aria-label="View" title="2D / 3D (V)">
          <button type="button" data-mode="2d">2D</button><button type="button" data-mode="3d">3D</button>
        </div>
        <label class="check"><input type="checkbox" data-opt="similar" /> Similar</label>
        <label class="check" data-orbit><input type="checkbox" data-opt="orbit" /> Orbit</label>
      </div>
    </div>
    <div class="graph-hint"><span data-hint-drag>drag to rotate</span> · scroll to zoom · click to focus · double-click to open</div>`;
  const el = container.querySelector(".graph-canvas");

  const state = {
    focus: null,           // { kind: "node", node } | { kind: "lobe", lobe }
    levels: new Map(),     // id -> 0 focus, 1 neighbour, 2 second ring, 3 background
    hover: null,
    types: new Set(prefs.get("graph.types", TYPES.map(t => t.id))),
    showSimilar: prefs.get("graph.similar", true),
    orbit: prefs.get("graph.orbit", false),
    flat: prefs.get("graph.view", "3d") === "2d",
  };
  const level = n => (state.focus ? state.levels.get(idOf(n)) ?? 3 : 0);
  let centers = new Map();
  let theme = {};

  function readTheme() {
    theme = {
      bg: cssVar("--graph-bg"), link: cssVar("--graph-link"), similar: cssVar("--graph-similar"),
      label: cssVar("--graph-label"), accent: cssVar("--accent"),
    };
  }
  readTheme();

  // ---------------------------------------------------------------- nodes
  // Geometry is shared per (type, size step); labels are created the first
  // time a node's label is shown. A vault of thousands of notes would
  // otherwise build thousands of geometries and label textures up front.
  const geoCache = new Map();
  function geometry(type, size) {
    const step = Math.round(size * 4) / 4;
    const key = `${type}:${step}`;
    if (!geoCache.has(key)) geoCache.set(key, (GEOMETRIES[type] || GEOMETRIES.note)(step));
    return geoCache.get(key);
  }

  function makeNode(n) {
    const size = (BASE_SIZE[n.type] || 3) * (1 + Math.min(n.degree || 0, 8) * 0.05);
    const mesh = new THREE.Mesh(geometry(n.type, size), new THREE.MeshLambertMaterial({ color: app.lobeOf(n).color }));
    const group = new THREE.Group();
    group.add(mesh);
    n.__v = { mesh, group, label: null, size };
    return group;
  }

  function ensureLabel(n) {
    const v = n.__v;
    if (v.label) return v.label;
    const label = new SpriteText(n.title, 2.1, theme.label);
    label.fontFace = cssVar("--font") || "system-ui, sans-serif";
    label.fontWeight = "500";
    label.position.y = -(v.size * 1.4 + 3);
    label.material.depthTest = false;
    label.material.depthWrite = false;
    label.renderOrder = 10;
    v.group.add(label);
    v.label = label;
    return label;
  }

  // One selection outline, moved to whichever node is focused: a slightly
  // larger back-face shell in the accent colour.
  const outline = new THREE.Mesh(undefined, new THREE.MeshBasicMaterial({ color: theme.accent, side: THREE.BackSide, transparent: true }));
  outline.scale.setScalar(1.28);

  // ---------------------------------------------------------------- links
  // All links are drawn as two merged batches (solid wikilinks, dashed
  // similar) with per-vertex colour + alpha, instead of one object per link:
  // thousands of separate lines made large vaults crawl.
  const linkMat = {
    explicit: new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }),
    similar: new THREE.LineDashedMaterial({ vertexColors: true, transparent: true, depthWrite: false, dashSize: 2, gapSize: 2.5 }),
  };
  const batches = {
    explicit: new THREE.LineSegments(new THREE.BufferGeometry(), linkMat.explicit),
    similar: new THREE.LineSegments(new THREE.BufferGeometry(), linkMat.similar),
  };
  for (const b of Object.values(batches)) { b.renderOrder = -1; b.frustumCulled = false; }
  let shown = { explicit: [], similar: [] }; // visible links per batch

  const isFocusEdge = l =>
    state.focus?.kind === "node" && (idOf(l.source) === state.focus.node.id || idOf(l.target) === state.focus.node.id);

  function linkStyle(l) {
    const explicit = l.kind === "explicit";
    let a;
    if (!state.focus) a = explicit ? 0.9 : 0.7;
    else {
      const worst = Math.max(level(l.source), level(l.target));
      if (isFocusEdge(l)) a = 1;
      else if (worst <= 1) a = explicit ? 0.7 : 0.4;
      else if (worst <= 2) a = 0.15;
      else a = 0.05;
    }
    return [isFocusEdge(l) && explicit ? theme.accent : explicit ? theme.link : theme.similar, a];
  }

  const linkVisible = l => {
    const s = app.items.get(idOf(l.source)), t = app.items.get(idOf(l.target));
    return !!s && !!t && (l.kind === "explicit" || state.showSimilar) && state.types.has(s.type) && state.types.has(t.type);
  };

  // Which links are drawn (after data, filter or similar-toggle changes).
  function rebuildLinks() {
    shown = { explicit: [], similar: [] };
    for (const l of graphLinks) if (linkVisible(l)) shown[l.kind === "explicit" ? "explicit" : "similar"].push(l);
    for (const k of ["explicit", "similar"]) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(shown[k].length * 6), 3));
      g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(shown[k].length * 8), 4));
      batches[k].geometry.dispose();
      batches[k].geometry = g;
    }
    positionLinks();
    colorLinks();
  }

  const nodeOf = x => (x && typeof x === "object" ? x : app.items.get(x));
  function positionLinks() {
    for (const k of ["explicit", "similar"]) {
      const pos = batches[k].geometry.attributes.position;
      if (!pos) continue;
      shown[k].forEach((l, i) => {
        const a = nodeOf(l.source), b = nodeOf(l.target);
        if (!a || !b) return;
        pos.setXYZ(i * 2, a.x || 0, a.y || 0, a.z || 0);
        pos.setXYZ(i * 2 + 1, b.x || 0, b.y || 0, b.z || 0);
      });
      pos.needsUpdate = true;
      if (k === "similar") batches[k].computeLineDistances();
    }
  }

  const tmpColor = new THREE.Color();
  function colorLinks() {
    for (const k of ["explicit", "similar"]) {
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
  const Graph = new ForceGraph3D(el, { controlType: "orbit" })
    .backgroundColor(theme.bg)
    .showNavInfo(false)
    .nodeThreeObject(makeNode)
    .nodeLabel(n => `<div class="tip">${typeIcon(n.type, app.lobeOf(n).color, 12)}<b>${esc(n.title)}</b><span>${esc(TYPE[n.type]?.one || "")}</span></div>`)
    .nodeVisibility(n => state.types.has(n.type))
    .linkVisibility(false) // drawn by the merged batches above
    .onNodeClick(onNodeClick)
    .onNodeRightClick((n, e) => itemMenu(n.id, { x: e.clientX, y: e.clientY }))
    .onNodeHover(n => { state.hover = n; el.style.cursor = n ? "pointer" : ""; })
    .onBackgroundClick(() => { if (state.focus) api.clearFocus(); })
    .onEngineTick(() => { engineRunning = true; updateLobes(); positionLinks(); })
    .onEngineStop(() => { engineRunning = false; positionLinks(); idleSoon(); })
    .warmupTicks(80)
    .cooldownTicks(220);

  let lastClick = { id: null, t: 0 };
  function onNodeClick(n) {
    const t = performance.now();
    if (lastClick.id === n.id && t - lastClick.t < 400) {
      lastClick = { id: null, t: 0 };
      app.open(n.id);
      return;
    }
    lastClick = { id: n.id, t };
    app.select(n.id, { source: "graph" });
  }

  // forces: keep each lobe together, weak pull across lobes
  function lobeForce(strength) {
    let nodes = [];
    const f = alpha => {
      for (const n of nodes) {
        const c = centers.get(n.lobe) || [0, 0, 0];
        n.vx += (c[0] - n.x) * strength * alpha;
        n.vy += (c[1] - n.y) * strength * alpha;
        if (state.flat) n.vz -= n.z * 0.2; // not scaled by alpha: keeps pulling until flat
        else n.vz += (c[2] - n.z) * strength * alpha;
      }
    };
    f.initialize = ns => { nodes = ns; };
    return f;
  }
  const crossLobe = l => app.items.get(idOf(l.source))?.lobe !== app.items.get(idOf(l.target))?.lobe;
  Graph.d3Force("center", null);
  Graph.d3Force("charge").strength(-42).distanceMax(170);
  Graph.d3Force("link")
    .distance(l => (l.kind === "explicit" ? 22 : 38))
    .strength(l => (l.kind === "explicit" ? (crossLobe(l) ? 0.03 : 0.35) : crossLobe(l) ? 0.005 : 0.05));
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

  // GPU driver crashes (e.g. Mesa/Zink "device lost") kill the WebGL context.
  // Keep the rest of the app working and say what happened instead of hanging.
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

  const scene = Graph.scene();
  scene.add(batches.explicit, batches.similar);

  // ---------------------------------------------------------------- lobe labels
  let lobeFx = [];
  function buildLobes() {
    for (const fx of lobeFx) scene.remove(fx.label);
    lobeFx = [...app.lobes, app.lobe.get(UNSORTED.id)].filter(Boolean).map(l => {
      const label = new SpriteText(l.name, 7, l.color);
      label.fontFace = cssVar("--font") || "system-ui, sans-serif";
      label.fontWeight = "600";
      label.material.depthTest = false;
      label.material.depthWrite = false;
      label.material.transparent = true;
      label.renderOrder = 5;
      scene.add(label);
      return { lobe: l, label, center: new THREE.Vector3(), radius: 30 };
    });
  }

  function updateLobes() {
    for (const fx of lobeFx) {
      const members = [...app.items.values()].filter(n => n.lobe === fx.lobe.id && state.types.has(n.type));
      fx.label.visible = members.length > 0;
      if (!members.length) continue;
      const c = new THREE.Vector3();
      for (const n of members) c.add(new THREE.Vector3(n.x, n.y, n.z));
      c.divideScalar(members.length);
      let r = 0;
      for (const n of members) r = Math.max(r, c.distanceTo(new THREE.Vector3(n.x, n.y, n.z)));
      fx.center.copy(c);
      fx.radius = r + 12;
      fx.label.position.set(c.x, c.y + fx.radius + 4, c.z);
    }
  }

  // ---------------------------------------------------------------- data
  let graphLinks = [];
  let lastShape = "";
  // What the layout depends on. Saving a note's text changes none of it, so the
  // graph shouldn't be rebuilt (and re-laid-out) on every autosave.
  const shapeOf = () => JSON.stringify([
    [...app.items.values()].map(n => [n.id, n.type, n.lobe, n.degree]),
    app.links.map(l => [l.source, l.target, l.kind]),
    app.lobes.map(l => [l.id, l.name, l.color]),
  ]);

  function setData() {
    const shape = shapeOf();
    if (shape === lastShape) {
      // same structure: refresh labels in place, keep the layout still
      for (const n of app.items.values()) if (n.__v?.label && n.__v.label.text !== n.title) n.__v.label.text = n.title;
      refocus();
      return;
    }
    lastShape = shape;
    centers = lobeCenters(app.lobes);
    for (const n of app.items.values()) {
      if (n.x !== undefined) continue;
      // new node: start near its lobe so the layout settles fast
      const c = centers.get(n.lobe) || [0, 0, 0];
      n.x = c[0] + (Math.random() - 0.5) * 30;
      n.y = c[1] + (Math.random() - 0.5) * 30;
      n.z = state.flat ? 0 : c[2] + (Math.random() - 0.5) * 30;
    }
    graphLinks = app.links.map(l => ({ ...l }));
    buildLobes();
    engineRunning = true;
    wake();
    Graph.graphData({ nodes: [...app.items.values()], links: graphLinks });
    rebuildLinks();
    refocus();
  }

  function refocus() {
    if (state.focus?.kind === "node") {
      const n = app.items.get(state.focus.node.id);
      if (n) { state.focus.node = n; state.levels = bfsLevels([n.id]); } else state.focus = null;
    } else if (state.focus?.kind === "set") {
      state.focus.ids = state.focus.ids.filter(id => app.items.has(id));
      if (state.focus.ids.length) state.levels = bfsLevels(state.focus.ids, 1); else state.focus = null;
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
          if (!lv.has(e.id) && (e.kind === "explicit" || state.showSimilar)) { lv.set(e.id, d); next.push(e.id); }
      frontier = next;
    }
    return lv;
  }

  const bar = container.querySelector(".graph-focus");
  function applyFocusVisuals() {
    wake(600);
    for (const n of app.items.values()) {
      const v = n.__v;
      if (!v) continue;
      const lv = level(n);
      v.mesh.material.opacity = [1, 1, 0.3, 0.08][lv];
      // blending + depth sorting only for faded nodes (cheaper with big vaults)
      const faded = lv >= 2;
      if (v.mesh.material.transparent !== faded) { v.mesh.material.transparent = faded; v.mesh.material.needsUpdate = true; }
      v.mesh.material.depthWrite = lv < 2;
    }
    colorLinks();
    // move the single outline onto the focused node
    outline.removeFromParent();
    const fv = state.focus?.kind === "node" ? state.focus.node.__v : null;
    if (fv) {
      outline.geometry = fv.mesh.geometry;
      outline.material.color.set(theme.accent);
      fv.group.add(outline);
    }
    bar.hidden = !state.focus;
    if (state.focus) {
      const f = state.focus;
      bar.querySelector(".graph-focus-label").innerHTML = f.kind === "node"
        ? `${typeIcon(f.node.type, app.lobeOf(f.node).color, 12)}<b>${esc(f.node.title)}</b>`
        : f.kind === "set" ? `<b>${esc(f.label || `${f.ids.length} items`)}</b>`
        : `<span class="dot" style="background:${f.lobe.color}"></span><b>${esc(f.lobe.name)}</b>`;
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
    if (!n) return;
    state.focus = { kind: "node", node: n };
    state.levels = bfsLevels([n.id]);
    applyFocusVisuals();
    pauseOrbit();
    if (fly) flyTo(n);
  }

  function focusLobe(lobe) {
    const fx = lobeFx.find(f => f.lobe.id === lobe.id);
    const ids = [...app.items.values()].filter(n => n.lobe === lobe.id).map(n => n.id);
    if (!fx || !ids.length) return;
    const lv = bfsLevels(ids, 1);
    for (const id of ids) lv.set(id, 1);
    state.focus = { kind: "lobe", lobe };
    state.levels = lv;
    applyFocusVisuals();
    pauseOrbit();
    const ms = reduceMotion() ? 0 : 800;
    if (state.flat) {
      const c = fx.center.clone().setZ(0);
      Graph.cameraPosition(c.clone().setZ(fx.radius * 3.2), c, ms);
      return;
    }
    const out = fx.center.clone().normalize();
    if (out.lengthSq() === 0) out.set(0, 0, 1);
    const pos = fx.center.clone().add(out.multiplyScalar(fx.radius * 3.2)).add(new THREE.Vector3(0, 20, 0));
    Graph.cameraPosition(pos, fx.center.clone(), ms);
  }

  // Light up a set of items (e.g. the notes an Ask answer cites) + their neighbours.
  function highlight(ids, label = "") {
    ids = ids.filter(id => app.items.has(id));
    if (!ids.length) return;
    const lv = bfsLevels(ids, 1);
    state.focus = { kind: "set", ids, label };
    state.levels = lv;
    applyFocusVisuals();
    pauseOrbit();
    // fly to the centre of the set, far enough to see all of it
    const nodes = ids.map(id => app.items.get(id));
    const c = new THREE.Vector3();
    for (const n of nodes) c.add(new THREE.Vector3(n.x, n.y, n.z));
    c.divideScalar(nodes.length);
    const r = Math.max(...nodes.map(n => c.distanceTo(new THREE.Vector3(n.x, n.y, n.z))));
    flyTo({ x: c.x, y: c.y, z: c.z }, 700, Math.max(110, r * 3));
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
  el.addEventListener("pointerdown", () => { pauseOrbit(); resumeOrbitSoon(); });
  el.addEventListener("wheel", () => { pauseOrbit(); resumeOrbitSoon(); }, { passive: true });

  // ---------------------------------------------------------------- per frame: semantic zoom
  const tmp = new THREE.Vector3();
  let raf;
  function frame() {
    raf = requestAnimationFrame(frame);
    if (!container.offsetParent || paused) return; // tab hidden or graph idle
    const cam = Graph.camera();
    const camDist = cam.position.distanceTo(controls.target);
    const far = camDist > 360; // far away = lobe names only
    const near = camDist < 200; // close up = node labels only
    for (const n of app.items.values()) {
      const v = n.__v;
      if (!v) continue;
      let show;
      if (state.focus) show = level(n) <= (state.focus.kind === "node" ? 1 : state.focus.kind === "set" ? 0 : far ? -1 : 1);
      else show = !far && tmp.set(n.x, n.y, n.z).distanceTo(cam.position) < 160;
      if (n === state.hover) show = true;
      show = show && state.types.has(n.type);
      if (show) ensureLabel(n).visible = true;
      else if (v.label) v.label.visible = false;
    }
    for (const fx of lobeFx) {
      const focused = state.focus?.kind === "lobe" && state.focus.lobe.id === fx.lobe.id;
      fx.label.material.opacity = focused ? 1 : state.focus ? 0.12 : far ? 1 : near ? 0 : 0.45;
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
    container.querySelector('[data-opt="similar"]').checked = state.showSimilar;
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
    for (const n of app.items.values()) {
      if (flat && instant) { n.z = 0; n.vz = 0; }
      // un-flattening: a little z jitter so charge can push nodes apart in depth again
      if (!flat) n.z += (Math.random() - 0.5) * 20;
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
  });
  container.querySelector(".graph-bar").addEventListener("change", e => {
    const opt = e.target.dataset.opt;
    if (opt === "similar") api.setShowSimilar(e.target.checked);
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
    const unsorted = app.lobe.get(UNSORTED.id);
    if (unsorted) unsorted.color = cssVar("--unsorted");
    for (const n of app.items.values()) {
      if (!n.__v) continue;
      if (n.__v.label) n.__v.label.color = theme.label;
      n.__v.mesh.material.color.set(app.lobeOf(n).color);
    }
    buildLobes();
    updateLobes();
    applyFocusVisuals();
  }

  // ---------------------------------------------------------------- public
  const api = {
    Graph,
    state,
    setData,
    focusNode,
    focusLobe,
    highlight,
    clearFocus,
    setViewMode,
    toggleView: () => setViewMode(!state.flat),
    applyTheme,
    setTypes(types) {
      state.types = new Set(types);
      prefs.set("graph.types", [...state.types]);
      if (state.focus?.kind === "node" && !state.types.has(state.focus.node.type)) clearFocus();
      Graph.nodeVisibility(n => state.types.has(n.type));
      rebuildLinks();
      updateLobes();
      app.emit("graph-filters");
    },
    setShowSimilar(on) {
      state.showSimilar = on;
      prefs.set("graph.similar", on);
      rebuildLinks();
      if (state.focus?.kind === "node") state.levels = bfsLevels([state.focus.node.id]);
      applyFocusVisuals();
      syncToolbar();
      app.emit("graph-filters");
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

