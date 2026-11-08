// Folders give the graph its structure and colour:
//
//   Coding Club/                 lobe: only a coloured name in the graph (no node)
//   Coding Club/CTF/             group: its own colour; every note inside gets it
//   Coding Club/CTF/Writeup.md   a note, drawn in the CTF colour
//
// Colours can be picked per folder (.brain/colors.json, right-click a folder
// in the file explorer); folders without one get the next colour from a
// palette, so a new folder always looks different from its siblings.

// Lobe label colours (top-level folders) and group colours (subfolders).
export const LOBE_PALETTE = ["#e5c07b", "#61afef", "#c678dd", "#98c379", "#e06c75", "#56b6c2", "#d19a66", "#a3b8ef"];
export const GROUP_PALETTE = [
  "#e06c75", "#56b6c2", "#a98fe0", "#d6a64f", "#7fb77e", "#d98a5f", "#6c9be0", "#c678b6",
  "#8fb3a0", "#c9a26b", "#7a8bd6", "#b5705f", "#5fa8a0", "#b3b35f", "#9a7fb8", "#d07f8f",
];

export const folderOf = path => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const lobeOf = path => (path.includes("/") ? path.slice(0, path.indexOf("/")) : null);
// "Lobe/Group" for anything two or more folders deep
export function groupOf(path) {
  const parts = path.split("/");
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : null;
}

/**
 * Colour lookup for one vault state.
 * @param {string[]} folders  every folder path
 * @param {{folders?: Record<string,string>}} colors  picked colours
 * @param {string} neutral  colour for notes outside any folder
 */
export function colorScheme(folders, colors = {}, neutral = "#8a8a8a") {
  const picked = colors.folders || {};
  const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  const tops = folders.filter(f => !f.includes("/")).sort(byName);
  const auto = new Map();
  tops.forEach((t, i) => auto.set(t, LOBE_PALETTE[i % LOBE_PALETTE.length]));
  // groups: walk lobes in order, so siblings never share an automatic colour
  let g = 0;
  for (const t of tops)
    for (const f of folders.filter(f => folderOf(f) === t).sort(byName)) auto.set(f, GROUP_PALETTE[g++ % GROUP_PALETTE.length]);

  // a folder's own colour: picked, else automatic (deeper folders inherit their group's)
  function folder(f) {
    if (!f) return neutral;
    if (picked[f]) return picked[f];
    if (auto.has(f)) return auto.get(f);
    return folder(folderOf(f));
  }
  return {
    folder,
    lobe: name => folder(name),
    // a note: its folder's colour; notes loose in a lobe take the lobe's colour
    note: path => folder(folderOf(path)),
    picked: f => picked[f] || null,
  };
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/**
 * Where each lobe sits: a sunflower (golden-angle) spiral, biggest lobe in the
 * middle, so many lobes fill a disc instead of a ring with an empty centre.
 * @param {string[]} names  lobe names ("" = notes in the vault root)
 * @param {Map<string, number>} counts  notes per lobe
 */
export function lobeCenters(names, counts = new Map()) {
  const n = id => counts.get(id) || 0;
  const order = [...names].sort((a, b) => n(b) - n(a) || a.localeCompare(b));
  const used = order.filter(id => n(id) > 0).map(n).sort((a, b) => a - b);
  const typical = used.length ? used[Math.floor(used.length / 2)] : 8;
  const step = 70 + 9 * Math.sqrt(typical); // room for a typical cluster
  const out = new Map();
  order.forEach((id, i) => {
    const r = step * Math.sqrt(i);
    const a = i * GOLDEN;
    out.set(id, [Math.cos(a) * r, Math.sin(a) * r, (i % 2 ? -1 : 1) * Math.min(40, r * 0.25)]);
  });
  return out;
}
