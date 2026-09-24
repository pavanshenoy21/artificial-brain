// Lucide icons, inlined as SVG strings (stroke 1.5, 16px by default).
import {
  Files, Tags, SlidersHorizontal, Search, Command, Waypoints, FileText, Link, Hexagon, Square, Circle, Diamond,
  Triangle, X, Plus, PanelLeft, PanelRight, Settings, Sun, Moon, RefreshCw, ChevronRight, ChevronDown, ExternalLink,
  ArrowUpRight, ArrowDownLeft, Network, Inbox, Pencil, BookOpen, Trash2, MessageSquare, Info, GitBranch, Zap, Check,
  FolderOpen, Download, History, Copy, CornerDownLeft,
} from "lucide";

const ICONS = {
  files: Files, tags: Tags, filters: SlidersHorizontal, search: Search, command: Command, graph: Waypoints,
  file: FileText, link: Link, x: X, plus: Plus, "panel-left": PanelLeft, "panel-right": PanelRight,
  settings: Settings, sun: Sun, moon: Moon, refresh: RefreshCw, "chevron-right": ChevronRight,
  "chevron-down": ChevronDown, external: ExternalLink, outgoing: ArrowUpRight, backlinks: ArrowDownLeft,
  suggested: Network, inbox: Inbox, edit: Pencil, read: BookOpen, trash: Trash2, ask: MessageSquare, info: Info,
  github: GitBranch, capture: Zap, check: Check, folder: FolderOpen, download: Download, history: History,
  copy: Copy, enter: CornerDownLeft,
  // shapes used for item types (same shape as in the graph)
  circle: Circle, diamond: Diamond, triangle: Triangle, hexagon: Hexagon, square: Square,
};

const attr = a => Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(" ");

export function icon(name, { size = 16, cls = "", fill = "none", color = "currentColor", stroke = 1.5 } = {}) {
  const node = ICONS[name];
  if (!node) return "";
  const inner = node.map(([tag, a]) => `<${tag} ${attr(a)}/>`).join("");
  return `<svg class="i ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

// Type = shape. Same mapping as the 3D geometries in graph/shapes.js.
export const TYPE_SHAPE = { note: "circle", link: "diamond", skill: "triangle", hackathon: "hexagon", project: "square" };

export function typeIcon(type, color = "currentColor", size = 14) {
  return icon(TYPE_SHAPE[type] || "circle", { size, fill: color, color, stroke: 1 });
}
