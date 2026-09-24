// Small bottom-right messages. Plain text, auto-hide.
const box = document.createElement("div");
box.className = "toasts";
box.setAttribute("role", "status");
document.body.appendChild(box);

export function toast(text, kind = "info", ms = kind === "error" ? 6000 : 2800) {
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
