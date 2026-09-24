// Search "travel": a plain card moves from the node's spot in the graph to the
// place the item opens. Short, flat and skippable (any key or click ends it).

export function travel({ from, to, html, layer, duration = 260 }) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return Promise.resolve();
  const card = document.createElement("div");
  card.className = "travel-card";
  card.innerHTML = html;
  layer.appendChild(card);
  const w = Math.min(260, to.width);
  const anim = card.animate(
    [
      { transform: `translate(${from.x - w / 2}px, ${from.y - 16}px)`, width: `${w}px`, opacity: 0.6 },
      { transform: `translate(${to.left}px, ${to.top}px)`, width: `${to.width}px`, opacity: 1 },
    ],
    { duration, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" }
  );
  const skip = () => anim.finish();
  window.addEventListener("keydown", skip, { once: true, capture: true });
  window.addEventListener("pointerdown", skip, { once: true, capture: true });
  return anim.finished.catch(() => {}).then(() => {
    window.removeEventListener("keydown", skip, { capture: true });
    window.removeEventListener("pointerdown", skip, { capture: true });
    card.remove();
  });
}
