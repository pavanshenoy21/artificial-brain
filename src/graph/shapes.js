import * as THREE from "three";

// One shape per item type (colour = lobe, shape = type). Matches icons.js TYPE_SHAPE.
export const GEOMETRIES = {
  note:      s => new THREE.SphereGeometry(s, 18, 12),
  link:      s => new THREE.OctahedronGeometry(s * 1.15),
  skill:     s => new THREE.TetrahedronGeometry(s * 1.3),
  hackathon: s => new THREE.CylinderGeometry(s * 1.1, s * 1.1, s * 0.9, 6),
  project:   s => new THREE.BoxGeometry(s * 1.6, s * 1.6, s * 1.6),
};

export const BASE_SIZE = { note: 3, link: 2.6, skill: 2.8, hackathon: 3.4, project: 3.8 };
