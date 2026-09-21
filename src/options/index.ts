import type { AdOverlaySettings, ZapRule, ZapStore } from "../shared/types";
import { sendToBackground } from "../shared/messages";

const SCOPE_LABELS: Record<ZapRule["scopeLevel"], string> = {
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

async function loadStore(): Promise<ZapStore | null> {
  const res = await sendToBackground({ type: "GET_STORE" });
  return res.ok && res.store ? res.store : null;
}

async function loadAdOverlaySettings(): Promise<AdOverlaySettings | null> {
  const res = await sendToBackground({ type: "GET_AD_OVERLAY_SETTINGS" });
  return res.ok && res.adOverlaySettings ? res.adOverlaySettings : null;
}

function groupByOrigin(rules: ZapRule[]): Map<string, ZapRule[]> {
  const groups = new Map<string, ZapRule[]>();
  for (const rule of rules) {
    const list = groups.get(rule.origin) ?? [];
    list.push(rule);
    groups.set(rule.origin, list);
  }
  for (const list of groups.values()) list.sort((a, b) => b.createdAt - a.createdAt);
  return groups;
}

function exportStore(store: ZapStore): void {
  const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: `zap-rules-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function importStoreFromFile(file: File): Promise<{ ok: boolean; error?: string }> {
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return { ok: false, error: "That file isn't valid JSON." };
  }
  if (typeof data !== "object" || data === null || !Array.isArray((data as ZapStore).rules)) {
    return { ok: false, error: "That file doesn't look like a Zap export." };
  }
  const res = await sendToBackground({ type: "IMPORT_STORE", data: data as ZapStore });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;
  await render(root);
}

async function render(root: HTMLElement): Promise<void> {
  const [store, adOverlaySettings] = await Promise.all([loadStore(), loadAdOverlaySettings()]);
  root.replaceChildren();

  if (!store) {
    root.append(h("div", { className: "empty" }, ["Couldn't load rules."]));
    return;
  }

  const status = h("div", { className: "status" });

  const fileInput = h("input", { type: "file", accept: "application/json" } as Partial<HTMLInputElement>);
  fileInput.style.display = "none";
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    const result = await importStoreFromFile(file);
    status.textContent = result.ok ? "Import complete." : `Import failed: ${result.error}`;
    if (result.ok) await render(root);
  });

  const header = h("div", { className: "header" }, [
    h("h1", {}, ["Zap — all rules"]),
    h("div", { className: "actions" }, [
      h(
        "button",
        { className: "secondary", onclick: () => fileInput.click() },
        ["Import"],
      ),
      h(
        "button",
        { className: "secondary", onclick: () => exportStore(store) },
        ["Export"],
      ),
    ]),
  ]);

  const groups = groupByOrigin(store.rules);
  const body = h("div");

  if (groups.size === 0) {
    body.append(h("div", { className: "empty" }, ["No rules yet. Zap something to get started."]));
  } else {
    for (const [origin, rules] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      body.append(buildOriginGroup(root, origin, rules, store.disabledOrigins.includes(origin)));
    }
  }

  root.append(header, fileInput, status);
  if (adOverlaySettings) root.append(buildAdOverlaySection(root, adOverlaySettings));
  root.append(body);
}

function buildAdOverlaySection(root: HTMLElement, settings: AdOverlaySettings): HTMLElement {
  const section = h("div", { className: "ad-overlay-section" });

  const enabledRow = h("label", { className: "ad-overlay-toggle" }, [
    h("input", {
      type: "checkbox",
      checked: settings.enabled,
      onchange: async (e: Event) => {
        await sendToBackground({ type: "SET_AD_OVERLAY_ENABLED", enabled: (e.target as HTMLInputElement).checked });
        await render(root);
      },
    } as Partial<HTMLInputElement>),
    h("span", {}, ["Ad overlay (beta) — mute and cover video ads instead of blocking them, currently: YouTube"]),
  ]);

  section.append(h("h2", {}, ["Ad overlay"]), enabledRow);

  if (settings.disabledOrigins.length > 0) {
    const list = h("div", { className: "ad-overlay-exceptions" });
    for (const origin of [...settings.disabledOrigins].sort()) {
      list.append(
        h("div", { className: "ad-overlay-exception-row" }, [
          h("span", {}, [origin.replace(/^https?:\/\//, "")]),
          h(
            "button",
            {
              className: "icon-btn",
              title: "Re-enable ad overlay on this site",
              onclick: async () => {
                await sendToBackground({ type: "SET_AD_OVERLAY_ORIGIN_DISABLED", origin, disabled: false });
                await render(root);
              },
            },
            ["✕"],
          ),
        ]),
      );
    }
    section.append(h("div", { className: "ad-overlay-exceptions-label" }, ["Disabled on:"]), list);
  }

  return section;
}

function buildOriginGroup(root: HTMLElement, origin: string, rules: ZapRule[], disabled: boolean): HTMLElement {
  const group = h("div", { className: "origin-group" });

  const originHeader = h("div", { className: "origin-header" }, [
    h("span", {}, [
      origin.replace(/^https?:\/\//, ""),
      h("span", { className: "badge" }, [` ${rules.length} rule${rules.length === 1 ? "" : "s"}`]),
    ]),
    h(
      "label",
      { className: "badge" },
      [
        h("input", {
          type: "checkbox",
          checked: disabled,
          onchange: async (e: Event) => {
            await sendToBackground({
              type: "SET_ORIGIN_DISABLED",
              origin,
              disabled: (e.target as HTMLInputElement).checked,
            });
            await render(root);
          },
        } as Partial<HTMLInputElement>),
        " disabled here",
      ],
    ),
  ]);

  group.append(originHeader);

  for (const rule of rules) {
    group.append(buildRuleRow(root, rule));
  }

  return group;
}

function buildRuleRow(root: HTMLElement, rule: ZapRule): HTMLElement {
  const enabledToggle = h("input", {
    type: "checkbox",
    checked: rule.enabled,
    onchange: async (e: Event) => {
      await sendToBackground({
        type: "UPDATE_RULE",
        id: rule.id,
        patch: { enabled: (e.target as HTMLInputElement).checked },
      });
      await render(root);
    },
  } as Partial<HTMLInputElement>);

  const deleteBtn = h(
    "button",
    {
      className: "icon-btn",
      title: "Delete rule",
      onclick: async () => {
        await sendToBackground({ type: "DELETE_RULE", id: rule.id });
        await render(root);
      },
    },
    ["✕"],
  );

  return h("div", { className: "rule-row" }, [
    enabledToggle,
    h("div", { className: "rule-main" }, [
      h("div", { className: "rule-label" }, [
        rule.label || rule.selector,
        h("span", { className: "rule-scope-badge" }, [SCOPE_LABELS[rule.scopeLevel]]),
        rule.stale ? h("span", { className: "stale-badge" }, ["stale"]) : "",
      ]),
      h("div", { className: "rule-selector" }, [rule.selector]),
    ]),
    deleteBtn,
  ]);
}

void main();
