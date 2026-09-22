import type { ZapRule, ZapStore } from "../shared/types";
import { matchesScope, originOf } from "../shared/scope";
import { sendToBackground } from "../shared/messages";
import { ruleCSS } from "../shared/css";
import { getKnownShadowRoots, onEveryShadowRoot, setRulesCSSForRoot } from "./shadow";

let store: ZapStore = { version: 1, rules: [], disabledOrigins: [] };

function currentMatchingRules(): ZapRule[] {
  const origin = originOf(location.href);
  if (store.disabledOrigins.includes(origin)) return [];
  return store.rules.filter(
    (r) => r.enabled && r.origin === origin && matchesScope(location.href, r.scope, r.scopeLevel),
  );
}

function applyToDocument(rules: ZapRule[]): void {
  const css = rules
    .filter((r) => r.shadowPath === null)
    .map(ruleCSS)
    .join("\n");
  setRulesCSSForRoot(document, css);
}

function hostMatches(root: ShadowRoot, rule: ZapRule): boolean {
  const path = rule.shadowPath;
  if (path === null || path.length === 0) return false;
  try {
    return root.host.matches(path[path.length - 1]);
  } catch {
    // Detached host, or a stored selector the parser rejects. Either way this
    // rule doesn't apply here — and it must not take the whole pass down.
    return false;
  }
}

function applyToShadowRoot(root: ShadowRoot, rules: ZapRule[]): void {
  const css = rules
    .filter((r) => hostMatches(root, r))
    .map(ruleCSS)
    .join("\n");
  setRulesCSSForRoot(root, css);
}

/** Re-applies all currently-matching rules to the document and every known shadow root. */
export function reapply(): void {
  const rules = currentMatchingRules();
  applyToDocument(rules);

  // Walking every known shadow root costs real time on component-heavy sites,
  // and it's pure waste unless some rule is actually shadow-scoped.
  if (!rules.some((r) => r.shadowPath !== null)) return;
  for (const root of getKnownShadowRoots()) applyToShadowRoot(root, rules);
}

/**
 * Zapped elements were coming back mid-session, and only a disable/re-enable
 * (which broadcasts STORE_UPDATED -> setStore -> reapply) brought them back.
 * That's the tell: the CSS itself is fine, but the page can get out from under
 * it in ways a one-shot apply never notices —
 *
 *   1. a framework replacing `adoptedStyleSheets` wholesale, evicting our sheet
 *      (see shadow.ts);
 *   2. a shadow host that only gains the class/attribute our rule matches on
 *      *after* `attachShadow` ran, so the apply at registration time saw nothing.
 *
 * Re-running on a DOM-mutation tick covers both without having to enumerate the
 * ways a page can misbehave. Note that this is a *repair* pass, not the hiding
 * mechanism: `display: none !important` already applies to nodes added later
 * all by itself, so there's no need to run per mutation — we coalesce
 * aggressively and bail early when nothing changed.
 */
const REAPPLY_MIN_INTERVAL_MS = 100;
let observer: MutationObserver | null = null;
let reapplyScheduled = false;
let lastReapplyAt = 0;

export function scheduleReapply(): void {
  if (reapplyScheduled) return;
  reapplyScheduled = true;
  const wait = Math.max(0, REAPPLY_MIN_INTERVAL_MS - (Date.now() - lastReapplyAt));
  window.setTimeout(() => {
    reapplyScheduled = false;
    lastReapplyAt = Date.now();
    reapply();
  }, wait);
}

function observe(): void {
  const target = document.documentElement;
  if (!target || !observer) return;
  observer.observe(target, {
    childList: true,
    subtree: true,
    // Rules and shadow-host paths are selector-based, so a host picking up its
    // class late is as much a change as a node being inserted.
    attributes: true,
    attributeFilter: ["class", "id"],
  });
}

/** Starts the mutation-driven repair pass. Safe to call at document_start. */
export function initAutoReapply(): void {
  if (observer) return;
  observer = new MutationObserver(scheduleReapply);
  if (document.documentElement) observe();
  else document.addEventListener("DOMContentLoaded", observe, { once: true });
}

export function setStore(next: ZapStore): void {
  store = next;
  reapply();
}

export function getStore(): ZapStore {
  return store;
}

export function initRulesEngine(): void {
  // New shadow roots (created after our initial walk, e.g. by infinite
  // scroll or client-side routing) need today's rules applied immediately.
  onEveryShadowRoot((root) => applyToShadowRoot(root, currentMatchingRules()));
}

/** Live match count for one rule/selector on this page, including known open shadow roots. */
export function computeMatchCount(selector: string, shadowScoped: boolean): number {
  let matchCount = 0;
  try {
    matchCount = document.querySelectorAll(selector).length;
  } catch {
    matchCount = 0;
  }
  if (shadowScoped) {
    for (const root of getKnownShadowRoots()) {
      try {
        matchCount += root.querySelectorAll(selector).length;
      } catch {
        // ignore
      }
    }
  }
  return matchCount;
}

/** Healing (R6.1): report per-rule match counts on this page so the service worker can flag stale rules. */
export function reportMatchCounts(): void {
  const rules = currentMatchingRules();
  if (rules.length === 0) return;
  const counts = rules.map((r) => ({
    ruleId: r.id,
    matchCount: computeMatchCount(r.selector, r.shadowPath !== null),
  }));
  void sendToBackground({ type: "REPORT_MATCH_COUNTS", counts });
}

/** Popup (R5.1/R5.2/R6.2): live counts for arbitrary rule ids, including ones not matching the current scope. */
export function liveCountsFor(ruleIds: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const id of ruleIds) {
    const rule = store.rules.find((r) => r.id === id);
    if (!rule) continue;
    result[id] = computeMatchCount(rule.selector, rule.shadowPath !== null);
  }
  return result;
}

/** Live count for an arbitrary candidate selector (R6.2: previewing a fallback ladder rung). */
export function liveCountForSelector(selector: string, shadowScoped: boolean): number {
  return computeMatchCount(selector, shadowScoped);
}
