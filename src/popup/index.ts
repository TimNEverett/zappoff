import type { AdOverlaySettings, ScopeLevel, ZapRule, ZapStore } from "../shared/types";
import { sendToBackground, sendToTab } from "../shared/messages";
import { computeScope, matchesScope, originOf } from "../shared/scope";
import { isAdOverlaySupportedOrigin } from "../shared/adOverlaySites";

const SCOPE_LABELS: Record<ScopeLevel, string> = {
  page: "This page",
  section: "This section",
  site: "Whole site",
};

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<HTMLElementTagNameMap[K]> & { className?: string },
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props) Object.assign(e, props);
  for (const c of children) e.append(c);
  return e;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * chrome.permissions.request() only succeeds inside a live user gesture. By
 * the time a click reaches the service worker over sendMessage (plus its
 * own await for the store to hydrate), that gesture is gone and the request
 * is silently rejected with no dialog shown. Requesting here instead, still
 * synchronously inside the button's own click handler, keeps the gesture
 * fresh — the service worker only needs to know it already succeeded.
 */
async function ensureHostPermission(origin: string): Promise<boolean> {
  const pattern = `${origin}/*`;
  const already = await chrome.permissions.contains({ origins: [pattern] });
  if (already) return true;
  return chrome.permissions.request({ origins: [pattern] });
}

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;

  const tab = await getActiveTab();
  if (!tab?.url) {
    root.append(h("div", { className: "empty" }, ["No active tab."]));
    return;
  }

  let url: URL;
  try {
    url = new URL(tab.url);
  } catch {
    root.append(h("div", { className: "empty" }, ["Zap can't run on this page."]));
    return;
  }
  if (!/^https?:$/.test(url.protocol)) {
    root.append(h("div", { className: "empty" }, ["Zap only works on regular web pages."]));
    return;
  }

  const [storeRes, adOverlayRes] = await Promise.all([
    sendToBackground({ type: "GET_STORE" }),
    sendToBackground({ type: "GET_AD_OVERLAY_SETTINGS" }),
  ]);
  if (!storeRes.ok || !storeRes.store) {
    root.append(h("div", { className: "empty" }, ["Couldn't load rules."]));
    return;
  }

  render(root, tab.id!, tab.url, storeRes.store, adOverlayRes.ok ? adOverlayRes.adOverlaySettings : undefined);
}

function render(
  root: HTMLElement,
  tabId: number,
  tabUrl: string,
  store: ZapStore,
  adOverlaySettings?: AdOverlaySettings,
): void {
  root.replaceChildren();
  const origin = originOf(tabUrl);

  const matchingRules = store.rules
    .filter((r) => r.origin === origin)
    .filter((r) => matchesScope(tabUrl, r.scope, r.scopeLevel))
    .sort((a, b) => b.createdAt - a.createdAt);

  const header = h("div", { className: "header" }, [
    h("div", { className: "title" }, ["Zap"]),
    h(
      "button",
      {
        className: "primary",
        onclick: async () => {
          const granted = await ensureHostPermission(origin);
          if (!granted) {
            showError(root, "Permission to read and change this site was denied.");
            return;
          }
          const res = await sendToBackground({ type: "ACTIVATE_PICKER_FOR_ACTIVE_TAB" });
          if (res.ok) window.close();
          else showError(root, res.error);
        },
      },
      ["Zap an element"],
    ),
  ]);

  const disableRow = h("label", { className: "row disable-row" }, [
    h("input", {
      type: "checkbox",
      checked: store.disabledOrigins.includes(origin),
      onchange: async (e: Event) => {
        const disabled = (e.target as HTMLInputElement).checked;
        await sendToBackground({ type: "SET_ORIGIN_DISABLED", origin, disabled });
        await refresh(root, tabId, tabUrl);
      },
    } as Partial<HTMLInputElement>),
    h("span", {}, [`Disable Zap on ${origin.replace(/^https?:\/\//, "")}`]),
  ]);

  const adOverlayRow =
    adOverlaySettings && isAdOverlaySupportedOrigin(origin)
      ? h("label", { className: "row disable-row" }, [
          h("input", {
            type: "checkbox",
            checked: adOverlaySettings.disabledOrigins.includes(origin),
            onchange: async (e: Event) => {
              const disabled = (e.target as HTMLInputElement).checked;
              await sendToBackground({ type: "SET_AD_OVERLAY_ORIGIN_DISABLED", origin, disabled });
              await refresh(root, tabId, tabUrl);
            },
          } as Partial<HTMLInputElement>),
          h("span", {}, [`Disable ad overlay on ${origin.replace(/^https?:\/\//, "")}`]),
        ])
      : null;

  const list = h("div", { className: "list" });
  if (matchingRules.length === 0) {
    list.append(h("div", { className: "empty" }, ["No rules on this page yet."]));
  } else {
    for (const rule of matchingRules) {
      list.append(buildRuleRow(root, tabId, tabUrl, rule));
    }
  }

  const undoBtn = h(
    "button",
    {
      className: "secondary",
      onclick: async () => {
        const res = await sendToBackground({ type: "UNDO_LAST" });
        if (res.ok) await refresh(root, tabId, tabUrl);
        else showError(root, res.error);
      },
    },
    ["Undo last zap"],
  );

  const optionsLink = h(
    "button",
    { className: "link", onclick: () => chrome.runtime.openOptionsPage() },
    ["Manage all rules"],
  );

  const footer = h("div", { className: "footer" }, [undoBtn, optionsLink]);

  root.append(header, disableRow);
  if (adOverlayRow) root.append(adOverlayRow);
  root.append(list, footer);
}

function buildRuleRow(root: HTMLElement, tabId: number, tabUrl: string, rule: ZapRule): HTMLElement {
  const countEl = h("span", { className: "count" }, ["…"]);
  void sendToTab(tabId, { type: "GET_LIVE_COUNTS", ruleIds: [rule.id] }).then((res) => {
    if (res.ok && "counts" in res) {
      const c = res.counts[rule.id];
      countEl.textContent = c != null ? `${c} matched` : "not on this page";
    }
  });

  const scopeSelect = h(
    "select",
    {
      className: "scope-select",
      value: rule.scopeLevel,
      onchange: async (e: Event) => {
        const level = (e.target as HTMLSelectElement).value as ScopeLevel;
        const scope = computeScope(tabUrl, level);
        await sendToBackground({ type: "UPDATE_RULE", id: rule.id, patch: { scope, scopeLevel: level } });
        await refresh(root, tabId, tabUrl);
      },
    } as Partial<HTMLSelectElement>,
    (["page", "section", "site"] as ScopeLevel[]).map((level) =>
      h("option", { value: level, selected: level === rule.scopeLevel } as Partial<HTMLOptionElement>, [
        SCOPE_LABELS[level],
      ]),
    ),
  );

  const enabledToggle = h("input", {
    type: "checkbox",
    checked: rule.enabled,
    onchange: async (e: Event) => {
      const enabled = (e.target as HTMLInputElement).checked;
      await sendToBackground({ type: "UPDATE_RULE", id: rule.id, patch: { enabled } });
      await refresh(root, tabId, tabUrl);
    },
  } as Partial<HTMLInputElement>);

  const deleteBtn = h(
    "button",
    {
      className: "icon-btn",
      title: "Delete rule",
      onclick: async () => {
        await sendToBackground({ type: "DELETE_RULE", id: rule.id });
        await refresh(root, tabId, tabUrl);
      },
    },
    ["✕"],
  );

  const mainRow = h("div", { className: "rule-row" }, [
    enabledToggle,
    h("div", { className: "rule-main" }, [
      h("div", { className: "rule-label" }, [rule.label || rule.selector]),
      h("div", { className: "rule-meta" }, [scopeSelect, countEl]),
    ]),
    deleteBtn,
  ]);

  mainRow.addEventListener("mouseenter", () => {
    void sendToTab(tabId, { type: "HIGHLIGHT_RULE", ruleId: rule.id });
  });
  mainRow.addEventListener("mouseleave", () => {
    void sendToTab(tabId, { type: "HIGHLIGHT_RULE", ruleId: null });
  });

  const wrapper = h("div", { className: "rule-item" }, [mainRow]);

  if (rule.stale) {
    wrapper.append(buildStaleBanner(root, tabId, tabUrl, rule));
  }

  return wrapper;
}

function buildStaleBanner(root: HTMLElement, tabId: number, tabUrl: string, rule: ZapRule): HTMLElement {
  const banner = h("div", { className: "stale-banner" }, [
    h("span", {}, ["⚠ This rule stopped matching anything — the site may have changed. "]),
  ]);

  const select = h(
    "select",
    { className: "fallback-select" } as Partial<HTMLSelectElement>,
    rule.ladder.map((_selector, i) =>
      h(
        "option",
        { value: String(i), selected: i === rule.rungIndex } as Partial<HTMLOptionElement>,
        [`Rung ${i}${i === rule.rungIndex ? " (current)" : ""}`],
      ),
    ),
  );

  const applyBtn = h(
    "button",
    {
      className: "secondary small",
      onclick: async () => {
        const rungIndex = Number(select.value);
        const selector = rule.ladder[rungIndex];
        if (!selector) return;
        await sendToBackground({
          type: "UPDATE_RULE",
          id: rule.id,
          patch: { selector, rungIndex },
        });
        await refresh(root, tabId, tabUrl);
      },
    },
    ["Use this rung"],
  );

  banner.append(select, applyBtn);
  return banner;
}

function showError(root: HTMLElement, message: string): void {
  const banner = h("div", { className: "error-banner" }, [message]);
  root.prepend(banner);
  window.setTimeout(() => banner.remove(), 4000);
}

async function refresh(root: HTMLElement, tabId: number, tabUrl: string): Promise<void> {
  const [storeRes, adOverlayRes] = await Promise.all([
    sendToBackground({ type: "GET_STORE" }),
    sendToBackground({ type: "GET_AD_OVERLAY_SETTINGS" }),
  ]);
  if (storeRes.ok && storeRes.store) {
    render(root, tabId, tabUrl, storeRes.store, adOverlayRes.ok ? adOverlayRes.adOverlaySettings : undefined);
  }
}

void main();
