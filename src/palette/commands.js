// Ctrl P command palette. Modules register commands; recently used ones
// float to the top.

import { openPalette } from "./palette.js";
import { icon } from "../icons.js";
import { esc } from "../util.js";
import { prefs } from "../lib/prefs.js";
import { toast } from "../shell/toast.js";
import { fuzzy } from "../lib/rank.js";

const commands = new Map();

/**
 * @param {{ id: string, title: string, run: () => any, keys?: string, iconName?: string,
 *           when?: () => boolean, disabled?: () => string|false }} cmd
 *   `when` hides the command; `disabled` returns a reason to show it greyed out.
 */
export function registerCommand(cmd) {
  commands.set(cmd.id, cmd);
}

export function runCommand(id) {
  const c = commands.get(id);
  if (!c) return;
  const reason = c.disabled?.();
  if (reason) { toast(reason); return; }
  const recent = prefs.get("commands.recent", []).filter(x => x !== id);
  prefs.set("commands.recent", [id, ...recent].slice(0, 8));
  return c.run();
}

function mark(text, hits) {
  const set = new Set(hits);
  return [...text].map((c, i) => (set.has(i) ? `<mark>${esc(c)}</mark>` : esc(c))).join("");
}

export function openCommands() {
  openPalette({
    id: "commands",
    iconName: "command",
    placeholder: "Type a command",
    empty: "No commands match",
    foot: `<span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span>`,
    source: async q => {
      const recent = prefs.get("commands.recent", []);
      const all = [...commands.values()].filter(c => !c.when || c.when());
      if (!q.trim()) {
        const rank = c => { const i = recent.indexOf(c.id); return i < 0 ? 99 : i; };
        return all.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title)).map(c => ({ c, hits: [] }));
      }
      return all
        .map(c => ({ c, m: fuzzy(c.title, q) }))
        .filter(x => x.m)
        .sort((a, b) => b.m.score - a.m.score + (recent.includes(b.c.id) ? 0.5 : 0) - (recent.includes(a.c.id) ? 0.5 : 0))
        .map(x => ({ c: x.c, hits: x.m.hits }));
    },
    render: ({ c, hits }) => {
      const reason = c.disabled?.();
      return `<span class="r-icon">${icon(c.iconName || "command", { size: 14 })}</span>
        <div class="r-main ${reason ? "r-disabled" : ""}"><div class="r-title">${mark(c.title, hits)}</div>${reason ? `<div class="r-meta">${esc(reason)}</div>` : ""}</div>
        ${c.keys ? `<span class="r-side"><kbd>${esc(c.keys)}</kbd></span>` : ""}`;
    },
    onPick: ({ c }) => runCommand(c.id),
  });
}
