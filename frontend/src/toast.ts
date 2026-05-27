// Transient toast notifications. Stacked top-right, auto-dismissed.

export type ToastKind = "info" | "success" | "warning" | "error";

const HOST_ID = "toastHost";
const DEFAULT_DURATION_MS = 2800;

function ensureHost(): HTMLElement {
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.className = "toast-host";
    document.body.appendChild(host);
  }
  return host;
}

export function showToast(
  message: string,
  options: { kind?: ToastKind; durationMs?: number } = {},
): void {
  const { kind = "info", durationMs = DEFAULT_DURATION_MS } = options;
  const host = ensureHost();
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  host.appendChild(el);
  // Force layout so the enter transition runs.
  void el.offsetWidth;
  el.classList.add("toast--in");

  const dismiss = () => {
    el.classList.remove("toast--in");
    el.classList.add("toast--out");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
  };
  el.addEventListener("click", dismiss);
  window.setTimeout(dismiss, durationMs);
}
