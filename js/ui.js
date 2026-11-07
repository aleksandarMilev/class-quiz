export const COLORS = ["#e2364b", "#2f6fe0", "#e8a417", "#1f9e5a"];
export const SHAPE_NAMES = ["triangle", "diamond", "circle", "square"];
export const SHAPE_LABELS = [
  "Червен триъгълник",
  "Син ромб",
  "Жълт кръг",
  "Зелен квадрат",
];

const SHAPE_PATHS = [
  '<path d="M50 10 L92 86 H8 Z"/>',
  '<path d="M50 6 L94 50 L50 94 L6 50 Z"/>',
  '<circle cx="50" cy="50" r="42"/>',
  '<rect x="12" y="12" width="76" height="76" rx="6"/>',
];

export function shapeSvg(i, className = "shape") {
  return `<svg class="${className}" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><g fill="currentColor">${SHAPE_PATHS[i]}</g></svg>`;
}

const ICON_PATHS = {
  check: '<path d="M5 13l5 5L20 7"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};

/** Simple stroke icon (check, cross, clock). */
export function iconSvg(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`;
}

const ESC = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
/** HTML-escapes any value for safe interpolation into innerHTML. */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Shows the element with data-screen="<name>" and hides the others. */
export function showScreen(name) {
  for (const el of $$("[data-screen]")) {
    const active = el.dataset.screen === name;
    el.hidden = !active;
    el.classList.toggle("is-active", active);
  }
  document.body.dataset.current = name;
}

/** Bulgarian masculine ordinal with numeral: 1-ви, 2-ри, 3-ти, 4-ти, 5-и, 7-ми, 11-и, 21-ви … */
export function ordinal(n) {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 19) return `${n}-и`;
  const suffix =
    { 1: "ви", 2: "ри", 3: "ти", 4: "ти", 7: "ми", 8: "ми" }[n % 10] ?? "и";
  return `${n}-${suffix}`;
}

/** 12345 → "12 345" (Bulgarian thousands separator). */
export function fmt(n) {
  return String(Math.round(Number(n) || 0)).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    " ",
  );
}

/** Shows/hides the "Няма връзка…" banner. Waits a moment so the first connect doesn't flash it. */
export function connectionBanner(connected) {
  const el = $("#offline-banner");
  if (!el) return;
  clearTimeout(connectionBanner.timer);
  if (connected) {
    el.hidden = true;
    connectionBanner.seen = true;
  } else {
    connectionBanner.timer = setTimeout(
      () => (el.hidden = false),
      connectionBanner.seen ? 600 : 2500,
    );
  }
}

export const prefersReducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Maps a Firebase error to a short Bulgarian message. */
export function errorText(err) {
  const code = String(err?.code || err?.message || "");
  if (code.includes("unauthorized-domain"))
    return "Този адрес не е разрешен във Firebase (Authorized domains).";
  if (
    code.includes("operation-not-allowed") ||
    code.includes("admin-restricted")
  )
    return "Анонимният вход не е включен във Firebase.";
  if (code.includes("api-key") || code.includes("invalid-api-key"))
    return "Невалиден ключ във js/firebase-config.js.";
  if (code.includes("network")) return "Няма връзка с интернет.";
  if (code.toLowerCase().includes("permission"))
    return "Нямаш права за това действие.";
  return "Нещо се обърка. Опитай пак.";
}
