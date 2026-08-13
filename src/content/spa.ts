/**
 * SPA navigation support (PRD §6.6, R4.4, U4). client-side routers change
 * `location.href` via pushState/replaceState without a real navigation, so
 * `chrome.webNavigation.onCommitted` never fires and the service worker
 * never gets a chance to re-inject CSS. We watch for it here instead and
 * re-evaluate which rules apply to the new URL.
 */

let lastUrl = location.href;
let onNavigate: (() => void) | null = null;

function handleChange(): void {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  onNavigate?.();
}

export function initSpaSupport(cb: () => void): void {
  onNavigate = cb;

  const originalPushState = history.pushState;
  history.pushState = function (this: History, ...args: Parameters<History["pushState"]>) {
    const result = originalPushState.apply(this, args);
    handleChange();
    return result;
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function (this: History, ...args: Parameters<History["replaceState"]>) {
    const result = originalReplaceState.apply(this, args);
    handleChange();
    return result;
  };

  window.addEventListener("popstate", handleChange);
}
