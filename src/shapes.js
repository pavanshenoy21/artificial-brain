import * as THREE from "three";

// One shape per node type (color = lobe, shape = type).
export const GEOMETRIES = {
  note:      s => new THREE.SphereGeometry(s, 20, 14),
  link:      s => new THREE.OctahedronGeometry(s * 1.15),
  skill:     s => new THREE.TetrahedronGeometry(s * 1.3),
  hackathon: s => new THREE.IcosahedronGeometry(s * 1.15, 0),
  project:   s => new THREE.BoxGeometry(s * 1.6, s * 1.6, s * 1.6),
};

export const BASE_SIZE = { note: 3, link: 2.6, skill: 2.8, hackathon: 3.6, project: 4.4 };

// Matching 2D icons for the UI (legend, search results, panel).
const ICON_PATHS = {
  note:      '<circle cx="8" cy="8" r="5.5"/>',
  link:      '<path d="M8 1.8 14.2 8 8 14.2 1.8 8Z"/>',
  skill:     '<path d="M8 2 14.5 13.5h-13Z"/>',
  hackathon: '<path d="M8 1.6 13.6 4.8v6.4L8 14.4 2.4 11.2V4.8Z"/>',
  project:   '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/>',
};

export function typeIcon(type, color = "currentColor", size = 14) {
  return `<svg class="ticon" width="${size}" height="${size}" viewBox="0 0 16 16" fill="${color}" aria-hidden="true">${ICON_PATHS[type]}</svg>`;
}

// Shared soft-glow texture for the halo sprite behind each node.
let glowTex;
export function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,0.9)");
  grd.addColorStop(0.25, "rgba(255,255,255,0.35)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}
