import type { AdOverlaySettings, ZapRule, ZapStore } from "../shared/types";
import { matchesScope, originOf, computeScope } from "../shared/scope";
import {
  loadAdOverlaySettings,
  loadStore,
  saveAdOverlaySettings,
  saveDisabledOrigins,
  saveOrigin,
} from "../shared/storage";
import type { ZapRequest, ZapResponse, ZapTabMessage } from "../shared/messages";
import { ruleCSS } from "../shared/css";

/**
 * Owns the canonical rule store (PRD §6.3): a synchronous in-memory mirror
 * of chrome.storage, kept current on every write, so that
 * webNavigation.onCommitted can inject the hiding CSS before first paint
 * (§6.4) instead of racing an async storage read.
 *
 * MV3 service workers are ephemeral — this whole module re-runs from
 * scratch on every wake — so `storeReady` (not onStartup/onInstalled) is
 * what actually re-hydrates the cache each time, and every handler awaits
 * it before touching `store`.
 */

let store: ZapStore = { version: 1, rules: [], disabledOrigins: [] };
let adOverlaySettings: AdOverlaySettings = { version: 1, enabled: true, disabledOrigins: [] };
let storeReady: Promise<void> = hydrate();

async function hydrate(): Promise<void> {
  [store, adOverlaySettings] = await Promise.all([loadStore(), loadAdOverlaySettings()]);
}

function genId(): string {
  return `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isValidRule(r: unknown): r is ZapRule {
  if (typeof r !== "object" || r === null) return false;
  const rule = r as Partial<ZapRule>;
  return (
    typeof rule.id === "string" &&
    typeof rule.origin === "string" &&
    typeof rule.scope === "string" &&
    (rule.scopeLevel === "page" || rule.scopeLevel === "section" || rule.scopeLevel === "site") &&
    typeof rule.selector === "string" &&
    Array.isArray(rule.ladder) &&
    typeof rule.rungIndex === "number" &&
    (rule.shadowPath === null || Array.isArray(rule.shadowPath)) &&
    typeof rule.enabled === "boolean" &&
    typeof rule.label === "string" &&
    typeof rule.createdAt === "number"
  );
}

function matchingRulesFor(url: string): ZapRule[] {
  let origin: string;
  try {
    origin = originOf(url);
  } catch {
    return [];
  }
  if (store.disabledOrigins.includes(origin)) return [];
  return store.rules.filter(
    (r) => r.enabled && r.origin === origin && matchesScope(url, r.scope, r.scopeLevel),
  );
}

async function persistOrigin(origin: string): Promise<void> {
  const rules = store.rules.filter((r) => r.origin === origin);
  await saveOrigin(origin, rules);
}

async function broadcastStore(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  const msg: ZapTabMessage = { type: "STORE_UPDATED", store };
  await Promise.all(
    tabs
      .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id != null)
      .map((tab) => chrome.tabs.sendMessage(tab.id, msg).catch(() => undefined)),
  );
}

async function broadcastAdOverlaySettings(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  const msg: ZapTabMessage = { type: "AD_OVERLAY_SETTINGS_UPDATED", settings: adOverlaySettings };
  await Promise.all(
    tabs
      .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id != null)
      .map((tab) => chrome.tabs.sendMessage(tab.id, msg).catch(() => undefined)),
  );
}

async function ensureHostPermission(origin: string): Promise<boolean> {
  const pattern = `${origin}/*`;
  try {
    const already = await chrome.permissions.contains({ origins: [pattern] });
    if (already) return true;
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

async function activatePickerForTab(tabId: number, url: string): Promise<ZapResponse> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "unsupported page" };
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return { ok: false, error: "Zap can't run on this page." };
  }
  const granted = await ensureHostPermission(parsed.origin);
  if (!granted) {
    return { ok: false, error: "Permission to read and change this site was denied." };
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ACTIVATE_PICKER" } satisfies ZapTabMessage);
    return { ok: true };
  } catch {
    // Permission for this origin was likely just granted, so the declared
    // content script never ran on this already-open tab (G1: activation
    // must not require a reload). Inject it once, then retry.
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tabId, { type: "ACTIVATE_PICKER" } satisfies ZapTabMessage);
    return { ok: true };
  } catch {
    return { ok: false, error: "Zap isn't available on this page yet — try reloading it." };
  }
}

// R4.3/§6.4: apply light-DOM rules synchronously on navigation commit, before
// first paint. Shadow-scoped rules (shadowPath !== null) are handled by the
// content script instead, since insertCSS can't cross shadow boundaries.
chrome.webNavigation.onCommitted.addListener((details) => {
  void (async () => {
    await storeReady;
    const rules = matchingRulesFor(details.url).filter((r) => r.shadowPath === null);
    if (rules.length === 0) return;
    const css = rules.map(ruleCSS).join("\n");
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: details.tabId, frameIds: [details.frameId] },
        css,
      });
    } catch {
      // No host permission for this frame's origin, or the frame is already gone.
    }
  })();
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "activate-picker") return;
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null && tab.url) await activatePickerForTab(tab.id, tab.url);
  })();
});

async function handleMessage(message: ZapRequest): Promise<ZapResponse> {
  await storeReady;

  switch (message.type) {
    case "GET_STORE":
      return { ok: true, store };

    case "GET_AD_OVERLAY_SETTINGS":
      return { ok: true, adOverlaySettings };

    case "SET_AD_OVERLAY_ENABLED": {
      adOverlaySettings.enabled = message.enabled;
      await saveAdOverlaySettings(adOverlaySettings);
      await broadcastAdOverlaySettings();
      return { ok: true, adOverlaySettings };
    }

    case "SET_AD_OVERLAY_ORIGIN_DISABLED": {
      const set = new Set(adOverlaySettings.disabledOrigins);
      if (message.disabled) set.add(message.origin);
      else set.delete(message.origin);
      adOverlaySettings.disabledOrigins = Array.from(set);
      await saveAdOverlaySettings(adOverlaySettings);
      await broadcastAdOverlaySettings();
      return { ok: true, adOverlaySettings };
    }

    case "REQUEST_HOST_PERMISSION": {
      const granted = await ensureHostPermission(message.origin);
      return { ok: true, granted };
    }

    case "ACTIVATE_PICKER_FOR_ACTIVE_TAB": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id == null || !tab.url) return { ok: false, error: "No active tab." };
      return activatePickerForTab(tab.id, tab.url);
    }

    case "CREATE_RULE": {
      const rule: ZapRule = {
        id: genId(),
        origin: message.origin,
        scope: computeScope(message.pageUrl, message.scopeLevel),
        scopeLevel: message.scopeLevel,
        selector: message.ladder[message.rungIndex] ?? message.ladder[0],
        ladder: message.ladder,
        rungIndex: message.rungIndex,
        shadowPath: message.shadowPath,
        enabled: true,
        label: message.label,
        createdAt: Date.now(),
        lastMatchedAt: Date.now(),
        stale: false,
      };
      store.rules.push(rule);
      await persistOrigin(rule.origin);
      await chrome.storage.session.set({ lastRuleId: rule.id });
      await broadcastStore();
      return { ok: true, rule };
    }

    case "UPDATE_RULE": {
      const rule = store.rules.find((r) => r.id === message.id);
      if (!rule) return { ok: false, error: "Rule not found." };
      Object.assign(rule, message.patch);
      if (message.patch.selector) rule.stale = false;
      await persistOrigin(rule.origin);
      await broadcastStore();
      return { ok: true, rule };
    }

    case "DELETE_RULE": {
      const idx = store.rules.findIndex((r) => r.id === message.id);
      if (idx === -1) return { ok: false, error: "Rule not found." };
      const [removed] = store.rules.splice(idx, 1);
      await persistOrigin(removed.origin);
      await broadcastStore();
      return { ok: true };
    }

    case "UNDO_LAST": {
      const { lastRuleId } = await chrome.storage.session.get("lastRuleId");
      if (!lastRuleId) return { ok: false, error: "Nothing to undo." };
      const idx = store.rules.findIndex((r) => r.id === lastRuleId);
      if (idx === -1) return { ok: false, error: "That rule was already removed." };
      const [removed] = store.rules.splice(idx, 1);
      await persistOrigin(removed.origin);
      await chrome.storage.session.remove("lastRuleId");
      await broadcastStore();
      return { ok: true };
    }

    case "SET_ORIGIN_DISABLED": {
      const set = new Set(store.disabledOrigins);
      if (message.disabled) set.add(message.origin);
      else set.delete(message.origin);
      store.disabledOrigins = Array.from(set);
      await saveDisabledOrigins(store.disabledOrigins);
      await broadcastStore();
      return { ok: true };
    }

    case "REPORT_MATCH_COUNTS": {
      const affectedOrigins = new Set<string>();
      for (const { ruleId, matchCount } of message.counts) {
        const rule = store.rules.find((r) => r.id === ruleId);
        if (!rule) continue;
        if (matchCount > 0) {
          rule.lastMatchedAt = Date.now();
          rule.stale = false;
        } else if (rule.lastMatchedAt !== null) {
          rule.stale = true;
        }
        affectedOrigins.add(rule.origin);
      }
      for (const origin of affectedOrigins) await persistOrigin(origin);
      if (affectedOrigins.size > 0) await broadcastStore();
      return { ok: true };
    }

    case "IMPORT_STORE": {
      const incoming = message.data.rules.filter(isValidRule);
      if (incoming.length === 0 && message.data.rules.length > 0) {
        return { ok: false, error: "That file doesn't look like a Zap export." };
      }
      const affectedOrigins = new Set<string>();
      for (const rule of incoming) {
        const idx = store.rules.findIndex((r) => r.id === rule.id);
        if (idx === -1) store.rules.push(rule);
        else store.rules[idx] = rule;
        affectedOrigins.add(rule.origin);
      }
      store.disabledOrigins = Array.from(
        new Set([...store.disabledOrigins, ...(message.data.disabledOrigins ?? [])]),
      );
      for (const origin of affectedOrigins) await persistOrigin(origin);
      await saveDisabledOrigins(store.disabledOrigins);
      await broadcastStore();
      return { ok: true, store };
    }

    default:
      return { ok: false, error: "Unknown message." };
  }
}

chrome.runtime.onMessage.addListener((message: ZapRequest, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err: unknown) => sendResponse({ ok: false, error: String(err) }));
  return true;
});
