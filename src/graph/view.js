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
  function makeNode(n) {
    const color = new THREE.Color(app.lobeOf(n).color);
    const size = (BASE_SIZE[n.type] || 3) * (1 + Math.min(n.degree || 0, 8) * 0.05);
    const mesh = new THREE.Mesh(
      (GEOMETRIES[n.type] || GEOMETRIES.note)(size),
      new THREE.MeshLambertMaterial({ color, transparent: true })
    );
    // selection outline: a slightly larger back-face shell in the accent colour
    const outline = new THREE.Mesh(
      mesh.geometry,
      new THREE.MeshBasicMaterial({ color: theme.accent, side: THREE.BackSide, transparent: true })
    );
    outline.scale.setScalar(1.28);
    outline.visible = false;

    const label = new SpriteText(n.title, 2.1, theme.label);
    label.fontFace = cssVar("--font") || "system-ui, sans-serif";
    label.fontWeight = "500";
    label.position.y = -(size * 1.4 + 3);
    label.material.depthTest = false;
    label.material.depthWrite = false;
    label.renderOrder = 10;
    label.visible = false;

    const group = new THREE.Group();
    group.add(outline, mesh, label);
    n.__v = { mesh, outline, label, size };
    return group;
  }

  // ---------------------------------------------------------------- links
  // Each link is its own THREE.Line so focus can fade it without a rebuild.
  function makeLink(l) {
    const geo = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    const mat = l.kind === "explicit"
      ? new THREE.LineBasicMaterial({ color: theme.link, transparent: true })
      : new THREE.LineDashedMaterial({ color: theme.similar, dashSize: 2, gapSize: 2.5, transparent: true });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = -1;
    l.__line = line;
    styleLink(l);
    return line;
  }
  function updateLink(line, { start, end }, l) {
    const p = line.geometry.attributes.position;
    p.setXYZ(0, start.x, start.y, start.z || 0);
    p.setXYZ(1, end.x, end.y, end.z || 0);
    p.needsUpdate = true;
    line.geometry.computeBoundingSphere();
    if (l.kind !== "explicit") line.computeLineDistances();
    return true;
  }
  const isFocusEdge = l =>
    state.focus?.kind === "node" && (idOf(l.source) === state.focus.node.id || idOf(l.target) === state.focus.node.id);

  function styleLink(l) {
    const m = l.__line?.material;
    if (!m) return;
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
    m.opacity = a;
    m.color.set(isFocusEdge(l) && explicit ? theme.accent : explicit ? theme.link : theme.similar);
  }

  const linkVisible = l => {
    const s = app.items.get(idOf(l.source)), t = app.items.get(idOf(l.target));
    return !!s && !!t && (l.kind === "explicit" || state.showSimilar) && state.types.has(s.type) && state.types.has(t.type);
  };

  // ---------------------------------------------------------------- graph
  const Graph = new ForceGraph3D(el, { controlType: "orbit" })
    .backgroundColor(theme.bg)
    .showNavInfo(false)
    .nodeThreeObject(makeNode)
    .nodeLabel(n => `<div class="tip">${typeIcon(n.type, app.lobeOf(n).color, 12)}<b>${esc(n.title)}</b><span>${esc(TYPE[n.type]?.one || "")}</span></div>`)
    .nodeVisibility(n => state.types.has(n.type))
    .linkThreeObject(makeLink)
    .linkPositionUpdate(updateLink)
    .linkVisibility(linkVisible)
    .onNodeClick(onNodeClick)
    .onNodeRightClick((n, e) => itemMenu(n.id, { x: e.clientX, y: e.clientY }))
    .onNodeHover(n => { state.hover = n; el.style.cursor = n ? "pointer" : ""; })
    .onBackgroundClick(() => { if (state.focus) api.clearFocus(); })
    .onEngineTick(updateLobes)
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

  const scene = Graph.scene();

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
  function setData() {
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
    Graph.graphData({ nodes: [...app.items.values()], links: graphLinks });
    if (state.focus?.kind === "node") {
      const n = app.items.get(state.focus.node.id);
      if (n) { state.focus.node = n; state.levels = bfsLevels([n.id]); } else state.focus = null;
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
    for (const n of app.items.values()) {
      const v = n.__v;
      if (!v) continue;
      const lv = level(n);
      v.mesh.material.opacity = [1, 1, 0.3, 0.08][lv];
      v.mesh.material.depthWrite = lv < 2;
      v.outline.visible = state.focus?.kind === "node" && state.focus.node.id === n.id;
      v.outline.material.color.set(theme.accent);
    }
    for (const l of graphLinks) styleLink(l);
    bar.hidden = !state.focus;
    if (state.focus) {
      const f = state.focus;
      bar.querySelector(".graph-focus-label").innerHTML = f.kind === "node"
        ? `${typeIcon(f.node.type, app.lobeOf(f.node).color, 12)}<b>${esc(f.node.title)}</b>`
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
    idleTimer = setTimeout(() => { controls.autoRotate = canOrbit(); }, ms);
  }
  el.addEventListener("pointerdown", () => { pauseOrbit(); resumeOrbitSoon(); });
  el.addEventListener("wheel", () => { pauseOrbit(); resumeOrbitSoon(); }, { passive: true });

  // ---------------------------------------------------------------- per frame: semantic zoom
  const tmp = new THREE.Vector3();
  let raf;
  function frame() {
    raf = requestAnimationFrame(frame);
    if (!container.offsetParent) return; // tab hidden
    const cam = Graph.camera();
    const camDist = cam.position.distanceTo(controls.target);
    const far = camDist > 360; // far away = lobe names only
    const near = camDist < 200; // close up = node labels only
    for (const n of app.items.values()) {
      const v = n.__v;
      if (!v) continue;
      let show;
      if (state.focus) show = level(n) <= (state.focus.kind === "node" ? 1 : far ? -1 : 1);
      else show = !far && tmp.set(n.x, n.y, n.z).distanceTo(cam.position) < 160;
      if (n === state.hover) show = true;
      v.label.visible = show && state.types.has(n.type);
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
    controls.autoRotate = canOrbit();
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
      controls.autoRotate = canOrbit();
    }
  });

  // ---------------------------------------------------------------- sizing + theme
  const ro = new ResizeObserver(() => {
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
      n.__v.label.color = theme.label;
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
    clearFocus,
    setViewMode,
    toggleView: () => setViewMode(!state.flat),
    applyTheme,
    setTypes(types) {
      state.types = new Set(types);
      prefs.set("graph.types", [...state.types]);
      if (state.focus?.kind === "node" && !state.types.has(state.focus.node.type)) clearFocus();
      Graph.nodeVisibility(n => state.types.has(n.type)).linkVisibility(linkVisible);
      updateLobes();
      app.emit("graph-filters");
    },
    setShowSimilar(on) {
      state.showSimilar = on;
      prefs.set("graph.similar", on);
      Graph.linkVisibility(linkVisible);
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

