import ForceGraph3D from "3d-force-graph";
import * as THREE from "three";
import SpriteText from "three-spritetext";
import { LOBES, TYPES, buildSampleGraph } from "./data/sample.js";
import { GEOMETRIES, BASE_SIZE, typeIcon, glowTexture } from "./shapes.js";
import { createSearch } from "./search.js";
import { createPanel } from "./panel.js";
import { travel } from "./travel.js";
import { esc, hexToRgb, idOf, reduceMotion } from "./util.js";

const LOBE = Object.fromEntries(LOBES.map(l => [l.id, l]));
const TYPE = Object.fromEntries(TYPES.map(t => [t.id, t]));
const FALLBACK_LOBE = { id: "?", name: "Unsorted", color: "#9aa3b5", center: [0, 0, 0] };
const lobeOf = n => LOBE[n.lobe] || FALLBACK_LOBE;

// ------------------------------------------------------------------ data
function loadViewMode() {
  try { return localStorage.getItem("brain.view"); } catch { return null; }
}
async function loadGraph() {
  // Inside the desktop app, ask the Rust side for the user's graph.json first.
  if (window.__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const raw = await invoke("load_graph");
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.warn("load_graph failed, falling back to sample data", e);
    }
  }
  return buildSampleGraph();
}

// ------------------------------------------------------------------ state
const state = {
  focus: null,          // { kind: "node", node } | { kind: "lobe", lobe }
  levels: new Map(),    // node id -> 0 focus, 1 neighbour, 2 second ring, 3 background
  hover: null,
  types: new Set(TYPES.map(t => t.id)),
  showSimilar: true,
  orbit: true,
  flat: loadViewMode() === "2d", // 2D view: same graph squashed onto z = 0, seen top-down
};
const level = n => (state.focus ? state.levels.get(idOf(n)) ?? 3 : 0);

const data = await loadGraph();
const byId = new Map(data.nodes.map(n => [n.id, n]));
const adj = new Map(data.nodes.map(n => [n.id, []]));
data.links = data.links.filter(l => byId.has(idOf(l.source)) && byId.has(idOf(l.target)));
for (const l of data.links) {
  adj.get(idOf(l.source)).push({ id: idOf(l.target), kind: l.kind });
  adj.get(idOf(l.target)).push({ id: idOf(l.source), kind: l.kind });
}
for (const n of data.nodes) {
  n.degree = adj.get(n.id).filter(e => e.kind === "explicit").length;
  // start every node near its lobe so the layout settles fast
  const c = lobeOf(n).center;
  n.x = c[0] + (Math.random() - 0.5) * 30;
  n.y = c[1] + (Math.random() - 0.5) * 30;
  n.z = state.flat ? 0 : c[2] + (Math.random() - 0.5) * 30;
}

// ------------------------------------------------------------------ node objects
function makeNode(n) {
  const color = new THREE.Color(lobeOf(n).color);
  const size = (BASE_SIZE[n.type] || 3) * (1 + Math.min(n.degree, 8) * 0.06);
  const mat = new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: 0.45, roughness: 0.35, metalness: 0.15, transparent: true,
  });
  const mesh = new THREE.Mesh((GEOMETRIES[n.type] || GEOMETRIES.note)(size), mat);
  mesh.rotation.set(Math.random() * 3, Math.random() * 3, 0);

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  glow.scale.setScalar(size * 5.5);

  const label = new SpriteText(n.title, 2, "#e8ecf5");
  label.fontFace = "Inter, system-ui, sans-serif";
  label.fontWeight = "500";
  label.backgroundColor = "rgba(8,10,16,0.62)";
  label.padding = [2.5, 1.3];
  label.borderRadius = 1.6;
  label.position.y = size * 1.5 + 3.8;
  label.material.depthTest = false;
  label.material.depthWrite = false;
  label.renderOrder = 10;
  label.visible = false;

  const group = new THREE.Group();
  group.add(glow, mesh, label);
  n.__v = { mesh, glow, label, size, spin: (Math.random() - 0.5) * 0.008, pulse: 0 };
  return group;
}

// ------------------------------------------------------------------ links
const isFocusEdge = l =>
  state.focus?.kind === "node" && (idOf(l.source) === state.focus.node.id || idOf(l.target) === state.focus.node.id);

function linkColor(l) {
  const explicit = l.kind === "explicit";
  let a;
  if (!state.focus) a = explicit ? 0.4 : 0.1;
  else {
    const worst = Math.max(level(l.source), level(l.target));
    if (isFocusEdge(l)) a = explicit ? 0.95 : 0.55;
    else if (worst <= 1) a = explicit ? 0.5 : 0.18;
    else if (worst <= 2) a = explicit ? 0.1 : 0.04;
    else a = 0.015;
  }
  const rgb = explicit ? "215,224,245" : hexToRgb(lobeOf(byId.get(idOf(l.source))).color);
  return `rgba(${rgb},${a})`;
}
const linkVisible = l =>
  (l.kind === "explicit" || state.showSimilar) &&
  state.types.has(byId.get(idOf(l.source)).type) &&
  state.types.has(byId.get(idOf(l.target)).type);

// ------------------------------------------------------------------ graph
const el = document.getElementById("graph");
const Graph = new ForceGraph3D(el, { controlType: "orbit" })
  .backgroundColor("#07080d")
  .showNavInfo(false)
  .nodeThreeObject(makeNode)
  .nodeLabel(n => `<div class="tip">${typeIcon(n.type, lobeOf(n).color, 12)}<b>${esc(n.title)}</b><span class="muted">${esc(TYPE[n.type]?.name.replace(/s$/, "") || "")}</span></div>`)
  .nodeVisibility(n => state.types.has(n.type))
  .linkOpacity(1)
  .linkResolution(4)
  .onNodeClick(n => focusNode(n))
  .onNodeHover(n => { state.hover = n; el.style.cursor = n ? "pointer" : ""; })
  .onBackgroundClick(() => { if (state.focus) clearFocus(); })
  .onEngineTick(updateLobes)
  .warmupTicks(80)
  .cooldownTicks(220)
  .graphData(data);

function refreshLinks() {
  Graph
    .linkVisibility(l => linkVisible(l))
    .linkColor(l => linkColor(l))
    .linkWidth(l => (l.kind === "explicit" ? (isFocusEdge(l) ? 0.9 : 0.4) : 0))
    .linkDirectionalParticles(l => (l.kind === "explicit" && isFocusEdge(l) ? 3 : 0))
    .linkDirectionalParticleWidth(1.3)
    .linkDirectionalParticleSpeed(0.007)
    .linkDirectionalParticleColor(l => lobeOf(byId.get(idOf(l.source))).color);
}
refreshLinks();

// forces: keep each lobe together, weak pull across lobes
function lobeForce(strength) {
  let nodes = [];
  const f = alpha => {
    for (const n of nodes) {
      const c = lobeOf(n).center;
      n.vx += (c[0] - n.x) * strength * alpha;
      n.vy += (c[1] - n.y) * strength * alpha;
      if (state.flat) n.vz -= n.z * 0.2; // not scaled by alpha: keeps pulling until everything is flat
      else n.vz += (c[2] - n.z) * strength * alpha;
    }
  };
  f.initialize = ns => { nodes = ns; };
  return f;
}
const crossLobe = l => byId.get(idOf(l.source)).lobe !== byId.get(idOf(l.target)).lobe;
Graph.d3Force("center", null);
Graph.d3Force("charge").strength(-42).distanceMax(170);
Graph.d3Force("link")
  .distance(l => (l.kind === "explicit" ? 22 : 38))
  .strength(l => (l.kind === "explicit" ? (crossLobe(l) ? 0.03 : 0.35) : crossLobe(l) ? 0.005 : 0.05));
Graph.d3Force("lobe", lobeForce(0.1));

// lights: softer ambient + a cool rim light
const scene = Graph.scene();
scene.add(new THREE.PointLight(0x8ab4ff, 0.6, 0, 0).translateZ(-400));

// ------------------------------------------------------------------ lobes (halo + label)
const lobeFx = LOBES.map(l => {
  const label = new SpriteText(l.name.toUpperCase(), 6.5, l.color);
  label.fontFace = "Inter, system-ui, sans-serif";
  label.fontWeight = "700";
  label.material.depthTest = false;
  label.material.depthWrite = false;
  label.material.transparent = true;
  label.renderOrder = 5;
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(1, 40, 28),
    new THREE.MeshBasicMaterial({ color: l.color, transparent: true, opacity: 0.035, depthWrite: false, blending: THREE.AdditiveBlending })
  );
  scene.add(label, halo);
  return { lobe: l, label, halo, center: new THREE.Vector3(...l.center), radius: 30 };
});

function updateLobes() {
  for (const fx of lobeFx) {
    const members = data.nodes.filter(n => n.lobe === fx.lobe.id && state.types.has(n.type));
    fx.halo.visible = fx.label.visible = members.length > 0;
    if (!members.length) continue;
    const c = new THREE.Vector3();
    for (const n of members) c.add(new THREE.Vector3(n.x, n.y, n.z));
    c.divideScalar(members.length);
    let r = 0;
    for (const n of members) r = Math.max(r, c.distanceTo(new THREE.Vector3(n.x, n.y, n.z)));
    fx.center.copy(c);
    fx.radius = r + 12;
    fx.halo.position.copy(c);
    fx.halo.scale.setScalar(fx.radius);
    fx.label.position.set(c.x, c.y + fx.radius + 4, c.z);
  }
}

// ------------------------------------------------------------------ focus
function bfsLevels(startIds, maxDepth = 2) {
  const lv = new Map(startIds.map(id => [id, 0]));
  let frontier = [...startIds];
  for (let d = 1; d <= maxDepth; d++) {
    const next = [];
    for (const id of frontier)
      for (const e of adj.get(id))
        if (!lv.has(e.id) && (e.kind === "explicit" || state.showSimilar)) { lv.set(e.id, d); next.push(e.id); }
    frontier = next;
  }
  return lv;
}

function applyFocusVisuals() {
  for (const n of data.nodes) {
    const v = n.__v;
    if (!v) continue;
    const lv = level(n);
    const op = [1, 1, 0.28, 0.06][lv];
    v.mesh.material.opacity = op;
    v.mesh.material.emissiveIntensity = lv === 0 && state.focus?.kind === "node" ? 0.9 : 0.45;
    v.glow.material.opacity = [state.focus?.kind === "node" ? 0.95 : 0.5, 0.55, 0.12, 0.015][lv];
    v.glow.scale.setScalar(v.size * (lv === 0 && state.focus?.kind === "node" ? 8 : 5.5));
  }
  refreshLinks();
  const bar = document.getElementById("focus-bar");
  bar.hidden = !state.focus;
  if (state.focus) {
    const f = state.focus;
    const color = f.kind === "node" ? lobeOf(f.node).color : f.lobe.color;
    document.getElementById("focus-label").innerHTML = f.kind === "node"
      ? `${typeIcon(f.node.type, color, 12)} Focus: <b>${esc(f.node.title)}</b>`
      : `<span class="dot" style="background:${color};display:inline-block"></span> Lobe: <b>${esc(f.lobe.name)}</b>`;
  }
}

function camRight() {
  return new THREE.Vector3().setFromMatrixColumn(Graph.camera().matrixWorld, 0).normalize();
}

// Fly so the node sits a bit left of center (the panel covers the right side).
function flyTo(n, ms = 1000, dist = 150) {
  const target = new THREE.Vector3(n.x, n.y, n.z);
  const cam = Graph.camera();
  const dir = cam.position.clone().sub(Graph.controls().target).normalize();
  const shifted = target.clone().add(camRight().multiplyScalar(dist * 0.28));
  const pos = shifted.clone().add(dir.multiplyScalar(dist));
  Graph.cameraPosition(pos, shifted, reduceMotion() ? 0 : ms);
}

function focusNode(n, { fly = true, openPanel = true } = {}) {
  if (!n) return;
  state.focus = { kind: "node", node: n };
  state.levels = bfsLevels([n.id]);
  applyFocusVisuals();
  pauseOrbit();
  if (fly) flyTo(n);
  if (openPanel) panel.open(n);
}

function focusLobe(lobe) {
  const fx = lobeFx.find(f => f.lobe.id === lobe.id);
  const ids = data.nodes.filter(n => n.lobe === lobe.id).map(n => n.id);
  const lv = bfsLevels(ids, 1);
  for (const id of ids) lv.set(id, 1);
  state.focus = { kind: "lobe", lobe };
  state.levels = lv;
  applyFocusVisuals();
  pauseOrbit();
  panel.close();
  if (state.flat) {
    const c = fx.center.clone().setZ(0);
    Graph.cameraPosition(c.clone().setZ(fx.radius * 3.2), c, reduceMotion() ? 0 : 1100);
    return;
  }
  const out = fx.center.clone().normalize();
  if (out.lengthSq() === 0) out.set(0, 0, 1);
  const pos = fx.center.clone().add(out.multiplyScalar(fx.radius * 3.2)).add(new THREE.Vector3(0, 20, 0));
  Graph.cameraPosition(pos, fx.center.clone(), reduceMotion() ? 0 : 1100);
}

function clearFocus() {
  state.focus = null;
  state.levels = new Map();
  applyFocusVisuals();
  panel.close();
  resumeOrbitSoon(2500);
}

// ------------------------------------------------------------------ idle orbit
const controls = Graph.controls();
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.autoRotateSpeed = 0.35;
controls.autoRotate = state.orbit && !state.flat;
let idleTimer;
function pauseOrbit() { controls.autoRotate = false; clearTimeout(idleTimer); }
function resumeOrbitSoon(ms = 9000) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (state.orbit && !state.flat && !state.focus && !search.isOpen) controls.autoRotate = true; }, ms);
}
el.addEventListener("pointerdown", () => { pauseOrbit(); resumeOrbitSoon(); });
el.addEventListener("wheel", () => { pauseOrbit(); resumeOrbitSoon(); }, { passive: true });

// ------------------------------------------------------------------ per-frame: labels, pulses, spin
const tmp = new THREE.Vector3();
function frame() {
  const cam = Graph.camera();
  const camDist = cam.position.distanceTo(controls.target);
  const far = camDist > 360; // semantic zoom: far away = lobe names only
  for (const n of data.nodes) {
    const v = n.__v;
    if (!v) continue;
    v.mesh.rotation.y += v.spin;
    v.mesh.rotation.x += v.spin * 0.6;
    if (v.pulse > 0) {
      v.pulse = Math.max(0, v.pulse - 0.012);
      const k = 1 + Math.sin((1 - v.pulse) * Math.PI * 4) * v.pulse * 0.45;
      v.mesh.scale.setScalar(k);
    }
    let show;
    if (state.focus) show = level(n) <= (state.focus.kind === "node" ? 1 : far ? -1 : 1);
    else show = !far && tmp.set(n.x, n.y, n.z).distanceTo(cam.position) < 150;
    if (n === state.hover) show = true;
    v.label.visible = show && state.types.has(n.type);
  }
  for (const fx of lobeFx) {
    const focused = state.focus?.kind === "lobe" && state.focus.lobe.id === fx.lobe.id;
    const target = state.focus ? (focused ? 0.9 : 0.05) : far ? 0.95 : 0.4;
    fx.label.material.opacity += (target - fx.label.material.opacity) * 0.1;
    fx.halo.material.opacity += ((state.focus && !focused ? 0.012 : focused ? 0.06 : 0.035) - fx.halo.material.opacity) * 0.1;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------ panel + search
const panel = createPanel({
  lobes: new Proxy(LOBE, { get: (t, k) => t[k] || FALLBACK_LOBE }),
  types: TYPE,
  byId,
  adj,
  onSelect: n => focusNode(n),
  onClose: () => clearFocus(),
});

let travelling = false;
async function openFromSearch(n) {
  if (travelling) return;
  travelling = true;
  panel.close();
  state.focus = { kind: "node", node: n };
  state.levels = bfsLevels([n.id]);
  applyFocusVisuals();
  pauseOrbit();

  const flyMs = reduceMotion() ? 0 : 900;
  flyTo(n, flyMs);
  await new Promise(r => setTimeout(r, flyMs + 60));

  if (reduceMotion()) { panel.open(n); travelling = false; return; }

  n.__v.pulse = 1;
  await new Promise(r => setTimeout(r, 180));
  const p = Graph.graph2ScreenCoords(n.x, n.y, n.z);
  const color = lobeOf(n).color;
  const dissolve = await travel({
    from: { x: p.x, y: p.y },
    to: panel.rect(),
    color,
    html: `${typeIcon(n.type, color, 18)}<span style="overflow:hidden;text-overflow:ellipsis">${esc(n.title)}</span>`,
    layer: document.getElementById("fx-layer"),
  });
  panel.open(n);
  dissolve();
  travelling = false;
}

const search = createSearch({
  nodes: data.nodes,
  lobes: new Proxy(LOBE, { get: (t, k) => t[k] || FALLBACK_LOBE }),
  types: TYPE,
  onPick: openFromSearch,
  onOpen: pauseOrbit,
});
document.getElementById("search-open").addEventListener("click", () => search.open());
document.getElementById("focus-clear").addEventListener("click", clearFocus);

// ------------------------------------------------------------------ legend / filters / toggles
function renderLegend() {
  const typeList = document.getElementById("type-list");
  typeList.innerHTML = TYPES.map(t => {
    const count = data.nodes.filter(n => n.type === t.id).length;
    return `<button class="legend-item ${state.types.has(t.id) ? "" : "off"}" data-type="${t.id}" type="button" title="Show / hide">
      ${typeIcon(t.id, "#cfd6e6", 13)}<span>${t.name}</span><span class="count">${count}</span></button>`;
  }).join("");
  const lobeList = document.getElementById("lobe-list");
  lobeList.innerHTML = LOBES.map(l => {
    const count = data.nodes.filter(n => n.lobe === l.id).length;
    return `<button class="legend-item" data-lobe="${l.id}" type="button" title="Fly to lobe">
      <span class="dot" style="background:${l.color};box-shadow:0 0 8px ${l.color}"></span><span>${esc(l.name)}</span><span class="count">${count}</span></button>`;
  }).join("");
}
renderLegend();

document.querySelector(".legend").addEventListener("click", e => {
  const t = e.target.closest("[data-type]");
  if (t) {
    const id = t.dataset.type;
    state.types.has(id) ? state.types.delete(id) : state.types.add(id);
    if (state.focus?.kind === "node" && !state.types.has(state.focus.node.type)) clearFocus();
    Graph.nodeVisibility(n => state.types.has(n.type));
    refreshLinks();
    updateLobes();
    renderLegend();
    return;
  }
  const l = e.target.closest("[data-lobe]");
  if (l) focusLobe(LOBE[l.dataset.lobe]);
});

document.getElementById("t-similar").addEventListener("change", e => {
  state.showSimilar = e.target.checked;
  if (state.focus?.kind === "node") state.levels = bfsLevels([state.focus.node.id]);
  applyFocusVisuals();
});
document.getElementById("t-rotate").addEventListener("change", e => {
  state.orbit = e.target.checked;
  controls.autoRotate = state.orbit && !state.flat && !state.focus;
});

// ------------------------------------------------------------------ 2D / 3D view
// 2D reuses the 3D scene: a force flattens every node onto z = 0 and the camera
// locks top-down (drag pans instead of rotating). Focus, search and travel keep working.
function applyControlsMode() {
  controls.enableRotate = !state.flat;
  controls.mouseButtons.LEFT = state.flat ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
  controls.touches.ONE = state.flat ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
  document.getElementById("rotate-switch").classList.toggle("disabled", state.flat);
  document.getElementById("hint-drag").textContent = state.flat ? "drag to pan" : "drag to rotate";
  for (const b of document.querySelectorAll("#view-mode [data-mode]"))
    b.classList.toggle("on", (b.dataset.mode === "2d") === state.flat);
}

function setViewMode(flat) {
  if (flat === state.flat) return;
  state.flat = flat;
  try { localStorage.setItem("brain.view", flat ? "2d" : "3d"); } catch {}
  const instant = reduceMotion();
  for (const n of data.nodes) {
    if (flat && instant) { n.z = 0; n.vz = 0; }
    // un-flattening: a little z jitter so charge can push nodes apart in depth again
    if (!flat) n.z += (Math.random() - 0.5) * 20;
  }
  Graph.d3ReheatSimulation();
  pauseOrbit();
  applyControlsMode();

  const t = controls.target.clone();
  const dist = Math.max(120, Graph.camera().position.distanceTo(t));
  if (flat) {
    t.z = 0;
    Graph.cameraPosition(t.clone().setZ(dist), t, instant ? 0 : 1000);
  } else {
    const pos = t.clone().add(new THREE.Vector3(0.35, 0.3, 1).normalize().multiplyScalar(dist));
    Graph.cameraPosition(pos, t, instant ? 0 : 1000);
    if (!state.focus) resumeOrbitSoon();
  }
}

document.getElementById("view-mode").addEventListener("click", e => {
  const b = e.target.closest("[data-mode]");
  if (b) setViewMode(b.dataset.mode === "2d");
});
applyControlsMode();

const explicitCount = data.links.filter(l => l.kind === "explicit").length;
document.getElementById("stats").textContent =
  `${data.nodes.length} nodes · ${explicitCount} links · ${data.links.length - explicitCount} similar`;
document.getElementById("sample-chip").hidden = !data.sample;

// ------------------------------------------------------------------ keyboard + resize
window.addEventListener("keydown", e => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
  if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
    e.preventDefault();
    search.isOpen ? search.close() : search.open();
  } else if ((e.key === "v" || e.key === "V") && !typing && !search.isOpen && !e.ctrlKey && !e.metaKey && !e.altKey) {
    setViewMode(!state.flat);
  } else if (e.key === "Escape" && !search.isOpen) {
    if (state.focus || panel.current) clearFocus();
  }
});

function resize() { Graph.width(window.innerWidth).height(window.innerHeight); }
window.addEventListener("resize", resize);
resize();
Graph.cameraPosition(state.flat ? { x: 0, y: 0, z: 540 } : { x: 0, y: 40, z: 540 }, { x: 0, y: 0, z: 0 });

// handy for poking around in devtools
window.brain = { Graph, data, focusNode, focusLobe, clearFocus, openFromSearch, search, setViewMode };
