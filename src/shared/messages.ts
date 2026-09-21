import type { AdOverlaySettings, ScopeLevel, ZapRule, ZapStore } from "./types";

/** Requests sent to the service worker (from popup, options, or content scripts). */
export type ZapRequest =
  | { type: "GET_STORE" }
  | { type: "REQUEST_HOST_PERMISSION"; origin: string }
  | { type: "GET_AD_OVERLAY_SETTINGS" }
  | { type: "SET_AD_OVERLAY_ENABLED"; enabled: boolean }
  | { type: "SET_AD_OVERLAY_ORIGIN_DISABLED"; origin: string; disabled: boolean }
  | {
      type: "CREATE_RULE";
      origin: string;
      scopeLevel: ScopeLevel;
      pageUrl: string;
      ladder: string[];
      rungIndex: number;
      shadowPath: string[] | null;
      label: string;
    }
  | { type: "UPDATE_RULE"; id: string; patch: Partial<Pick<ZapRule, "enabled" | "scope" | "scopeLevel" | "selector" | "rungIndex" | "label">> }
  | { type: "DELETE_RULE"; id: string }
  | { type: "UNDO_LAST" }
  | { type: "SET_ORIGIN_DISABLED"; origin: string; disabled: boolean }
  | { type: "REPORT_MATCH_COUNTS"; counts: Array<{ ruleId: string; matchCount: number }> }
  | { type: "ACTIVATE_PICKER_FOR_ACTIVE_TAB" }
  | { type: "IMPORT_STORE"; data: ZapStore };

export type ZapResponse =
  | { ok: true; store?: ZapStore; rule?: ZapRule; granted?: boolean; adOverlaySettings?: AdOverlaySettings }
  | { ok: false; error: string };

/**
 * Messages sent down to a content script/tab — by the service worker
 * (STORE_UPDATED, ACTIVATE_PICKER) or directly by the popup, which talks to
 * the active tab's content script for anything that needs live DOM access
 * (match counts, hover highlighting).
 */
export type ZapTabMessage =
  | { type: "STORE_UPDATED"; store: ZapStore }
  | { type: "ACTIVATE_PICKER" }
  | { type: "HIGHLIGHT_RULE"; ruleId: string | null }
  | { type: "GET_LIVE_COUNTS"; ruleIds: string[] }
  | { type: "PREVIEW_SELECTOR_COUNT"; selector: string; shadowScoped: boolean }
  | { type: "AD_OVERLAY_SETTINGS_UPDATED"; settings: AdOverlaySettings };

export type ZapTabResponse =
  | { ok: true }
  | { ok: true; counts: Record<string, number> }
  | { ok: true; count: number }
  | { ok: false; error: string };

export function sendToBackground(msg: ZapRequest): Promise<ZapResponse> {
  return chrome.runtime.sendMessage(msg);
}

export function sendToTab(tabId: number, msg: ZapTabMessage): Promise<ZapTabResponse> {
  return chrome.tabs.sendMessage(tabId, msg);
}
