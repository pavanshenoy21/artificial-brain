// Lucide icons, inlined as SVG strings (stroke 1.5, 16px by default).
import {
  Files, Tags, Search, Command, Waypoints, FileText, Link, X, Plus, PanelLeft, PanelRight, Settings, Sun, Moon,
  RefreshCw, ChevronRight, ChevronDown, ChevronLeft, ExternalLink, ArrowUpRight, ArrowDownLeft, Pencil, BookOpen,
  Trash2, Info, Check, Folder, FolderOpen, FolderPlus, SquarePen, Download, Copy, StickyNote, SquareDashed, Undo2,
  Redo2, ZoomIn, ZoomOut, LayoutDashboard, CalendarDays, Palette, ArrowUpDown, ChevronsDownUp, ListTree,
} from "lucide";

const ICONS = {
  files: Files, tags: Tags, search: Search, command: Command, graph: Waypoints, file: FileText, link: Link, x: X,
  plus: Plus, "panel-left": PanelLeft, "panel-right": PanelRight, settings: Settings, sun: Sun, moon: Moon,
  refresh: RefreshCw, "chevron-right": ChevronRight, "chevron-down": ChevronDown, "chevron-left": ChevronLeft,
  external: ExternalLink, outgoing: ArrowUpRight, backlinks: ArrowDownLeft, edit: Pencil, read: BookOpen,
  trash: Trash2, info: Info, check: Check, folder: Folder, "folder-open": FolderOpen, "folder-plus": FolderPlus,
  "new-note": SquarePen, download: Download, copy: Copy, note: StickyNote, group: SquareDashed, undo: Undo2,
  redo: Redo2, "zoom-in": ZoomIn, "zoom-out": ZoomOut, canvas: LayoutDashboard, calendar: CalendarDays,
  palette: Palette, sort: ArrowUpDown, "collapse-all": ChevronsDownUp, outline: ListTree,
};

const attr = a => Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(" ");

export function icon(name, { size = 16, cls = "", fill = "none", color = "currentColor", stroke = 1.5 } = {}) {
  const node = ICONS[name];
  if (!node) return "";
  const inner = node.map(([tag, a]) => `<${tag} ${attr(a)}/>`).join("");
  return `<svg class="i ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

// Icon for a note or canvas in lists: a dot in the note's folder colour, or the canvas icon.
export function itemIcon(n, color = "currentColor", size = 12) {
  if (n?.type === "canvas") return icon("canvas", { size: size + 2, color });
  return `<span class="dot" style="background:${color}"></span>`;
}
