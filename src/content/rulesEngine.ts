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

function applyToShadowRoot(root: ShadowRoot, rules: ZapRule[]): void {
  const hostSelector = safeHostSelector(root);
  const css = rules
    .filter((r) => r.shadowPath !== null && r.shadowPath.length > 0 && hostSelector && root.host.matches(r.shadowPath[r.shadowPath.length - 1]))
    .map(ruleCSS)
    .join("\n");
  setRulesCSSForRoot(root, css);
}

function safeHostSelector(root: ShadowRoot): boolean {
  try {
    return typeof root.host.matches === "function";
  } catch {
    return false;
  }
}

/** Re-applies all currently-matching rules to the document and every known shadow root. */
export function reapply(): void {
  const rules = currentMatchingRules();
  applyToDocument(rules);
  for (const root of getKnownShadowRoots()) applyToShadowRoot(root, rules);
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
