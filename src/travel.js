// The "file travels from its resting place into the UI" effect.
// A card is born at the node's screen position, arcs across the screen along a
// glowing trail and lands on the detail panel, which then fades in underneath it.

const CARD_W = 260;
const CARD_H = 58;
const NS = "http://www.w3.org/2000/svg";

function quad(p0, c, p1, t) {
  const u = 1 - t;
  return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y };
}

/**
 * @param {object} o
 * @param {{x:number,y:number}} o.from  screen point of the node
 * @param {DOMRect} o.to                rect of the panel it lands on
 * @param {string} o.color              lobe color
 * @param {string} o.html               card contents
 * @param {HTMLElement} o.layer         overlay element
 * @param {number} [o.duration]
 * @returns {Promise<() => void>} resolves when the card lands; call the returned fn to dissolve it
 */
export function travel({ from, to, color, html, layer, duration = 780 }) {
  const land = { x: to.left, y: to.top };
  // control point: lift the arc above both ends
  const ctrl = { x: (from.x + land.x) / 2, y: Math.min(from.y, land.y) - 140 };

  // --- ping ring at the origin
  const ping = document.createElement("div");
  ping.className = "ping";
  ping.style.setProperty("--c", color);
  ping.style.left = `${from.x}px`;
  ping.style.top = `${from.y}px`;
  layer.appendChild(ping);
  ping.animate(
    [{ transform: "scale(.4)", opacity: 1 }, { transform: "scale(4.5)", opacity: 0 }],
    { duration: 650, easing: "cubic-bezier(.2,.7,.3,1)" }
  ).finished.then(() => ping.remove());

  // --- trail
  const svg = document.createElementNS(NS, "svg");
  const defs = document.createElementNS(NS, "defs");
  defs.innerHTML = `<filter id="trail-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>`;
  svg.appendChild(defs);
  const d = `M${from.x},${from.y} Q${ctrl.x},${ctrl.y} ${land.x + 24},${land.y + CARD_H / 2}`;
  const glow = document.createElementNS(NS, "path");
  const path = document.createElementNS(NS, "path");
  for (const [p, w, f] of [[glow, 6, "url(#trail-glow)"], [path, 1.6, ""]]) {
    p.setAttribute("d", d);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", color);
    p.setAttribute("stroke-width", w);
    p.setAttribute("stroke-linecap", "round");
    if (f) p.setAttribute("filter", f);
    svg.appendChild(p);
  }
  layer.appendChild(svg);
  const len = path.getTotalLength();
  for (const p of [glow, path]) {
    p.style.strokeDasharray = `${len}`;
    p.animate(
      [
        { strokeDashoffset: len, opacity: 0.9 },
        { strokeDashoffset: 0, opacity: 0.9, offset: 0.85 },
        { strokeDashoffset: 0, opacity: 0 },
      ],
      { duration: duration + 350, easing: "cubic-bezier(.65,0,.25,1)", fill: "forwards" }
    );
  }
  setTimeout(() => svg.remove(), duration + 400);

  // --- the card
  const card = document.createElement("div");
  card.className = "travel-card";
  card.style.setProperty("--c", color);
  card.innerHTML = html;
  layer.appendChild(card);

  const frames = [];
  const start = { x: from.x - CARD_W / 2, y: from.y - CARD_H / 2 };
  frames.push({ transform: `translate(${start.x}px,${start.y}px) scale(.12)`, opacity: 0, width: `${CARD_W}px`, offset: 0 });
  frames.push({ transform: `translate(${start.x}px,${start.y - 16}px) scale(1)`, opacity: 1, width: `${CARD_W}px`, offset: 0.2 });
  // sample the arc so the card follows the same curve as the trail
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const p = quad({ x: from.x, y: from.y - 16 }, ctrl, { x: land.x + CARD_W / 2, y: land.y + CARD_H / 2 }, t);
    const w = CARD_W + (to.width - CARD_W) * t * t;
    frames.push({
      transform: `translate(${p.x - CARD_W / 2}px,${p.y - CARD_H / 2}px) scale(1)`,
      opacity: 1,
      width: `${w}px`,
      offset: 0.2 + 0.8 * t,
    });
  }
  // last frame sits exactly on the panel's corner
  frames[frames.length - 1].transform = `translate(${land.x}px,${land.y}px) scale(1)`;

  const anim = card.animate(frames, { duration, easing: "cubic-bezier(.55,0,.2,1)", fill: "forwards" });

  return anim.finished.then(() => () => {
    card.animate([{ opacity: 1, filter: "blur(0)" }, { opacity: 0, filter: "blur(6px)" }], { duration: 260, fill: "forwards" })
      .finished.then(() => card.remove());
  });
}
