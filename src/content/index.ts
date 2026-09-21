import type { ZapTabMessage } from "../shared/messages";
import { sendToBackground } from "../shared/messages";
import { EMPTY_AD_OVERLAY_SETTINGS } from "../shared/types";
import { initAdOverlay, setAdOverlaySettings } from "../adOverlay";
import { initShadowSupport } from "./shadow";
import {
  getStore,
  initRulesEngine,
  liveCountForSelector,
  liveCountsFor,
  reportMatchCounts,
  setStore,
} from "./rulesEngine";
import { initSpaSupport } from "./spa";
import { PickerSession } from "./picker";

// document_start: patch attachShadow before the page can create any roots.
initShadowSupport();
initRulesEngine();

let activePicker: PickerSession | null = null;
let highlightStyleEl: HTMLStyleElement | null = null;

function startPicker(): void {
  if (activePicker) return;
  activePicker = new PickerSession(() => {
    activePicker = null;
  });
  activePicker.start();
}

function setHighlight(selector: string | null): void {
  if (!highlightStyleEl) {
    highlightStyleEl = document.createElement("style");
    document.documentElement.appendChild(highlightStyleEl);
  }
  highlightStyleEl.textContent = selector
    ? `${selector} { outline: 3px solid #4f7cff !important; outline-offset: -2px !important; }`
    : "";
}

chrome.runtime.onMessage.addListener((message: ZapTabMessage, _sender, sendResponse) => {
  switch (message.type) {
    case "ACTIVATE_PICKER":
      startPicker();
      break;
    case "STORE_UPDATED":
      setStore(message.store);
      break;
    case "AD_OVERLAY_SETTINGS_UPDATED":
      setAdOverlaySettings(message.settings);
      break;
    case "HIGHLIGHT_RULE": {
      const rule = getStore().rules.find((r) => r.id === message.ruleId);
      setHighlight(rule?.selector ?? null);
      break;
    }
    case "GET_LIVE_COUNTS":
      sendResponse({ ok: true, counts: liveCountsFor(message.ruleIds) });
      return true;
    case "PREVIEW_SELECTOR_COUNT":
      sendResponse({ ok: true, count: liveCountForSelector(message.selector, message.shadowScoped) });
      return true;
    default:
      break;
  }
  sendResponse({ ok: true });
  return true;
});

initSpaSupport(() => {
  window.setTimeout(reportMatchCounts, 1200);
});

// Bootstrap: fetch the current store. The service worker already applied
// top-level CSS synchronously on navigation (§6.4); this covers shadow
// roots and keeps our local cache current for SPA nav and picker previews.
//
// The service worker is an ephemeral MV3 process that can still be waking
// up when a document_start content script sends its very first message, so
// this first GET_STORE can reject ("Receiving end does not exist") and
// silently leave the tab on an empty local store until something else (e.g.
// toggling the origin off/on) broadcasts STORE_UPDATED. Retry with backoff
// so a slow-to-wake service worker doesn't cost us a working page load.
const BOOTSTRAP_RETRY_DELAYS_MS = [0, 250, 750, 1500, 3000];

async function bootstrapStore(): Promise<void> {
  for (const delay of BOOTSTRAP_RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
    try {
      const res = await sendToBackground({ type: "GET_STORE" });
      if (res.ok && res.store) {
        setStore(res.store);
        return;
      }
    } catch {
      // Service worker likely still waking up; try again.
    }
  }
}

void bootstrapStore();

window.setTimeout(reportMatchCounts, 1500);

// Same ephemeral-service-worker race as bootstrapStore above: retry with
// backoff rather than leaving the tab on the (enabled-by-default) fallback
// if the first message beats the service worker waking up.
async function bootstrapAdOverlaySettings(): Promise<void> {
  for (const delay of BOOTSTRAP_RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
    try {
      const res = await sendToBackground({ type: "GET_AD_OVERLAY_SETTINGS" });
      if (res.ok && res.adOverlaySettings) {
        initAdOverlay(res.adOverlaySettings);
        return;
      }
    } catch {
      // Service worker likely still waking up; try again.
    }
  }
  initAdOverlay(EMPTY_AD_OVERLAY_SETTINGS);
}

void bootstrapAdOverlaySettings();
