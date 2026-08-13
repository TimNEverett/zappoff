/**
 * Shadow DOM support (PRD §6.5). Constructed stylesheets don't cross shadow
 * boundaries, so each root (the document, plus every open shadow root we
 * know about) gets its own pair of CSSStyleSheet instances — one for
 * confirmed rules, one for the picker's live preview — kept in sync by
 * rulesEngine.ts and picker.ts respectively.
 *
 * We discover roots two ways: walking the existing tree at init, and a
 * patched `Element.prototype.attachShadow` installed at document_start so
 * every root created afterwards (including ones nested arbitrarily deep, or
 * created later by client-side routing / infinite scroll) is caught too —
 * no MutationObserver needed.
 *
 * Closed shadow roots are out of scope (PRD D3) and are invisible to us.
 */

type StyleRoot = Document | ShadowRoot;

const rulesSheets = new WeakMap<StyleRoot, CSSStyleSheet>();
const previewSheets = new WeakMap<StyleRoot, CSSStyleSheet>();
const knownRoots = new Set<ShadowRoot>();
const newRootListeners: Array<(root: ShadowRoot) => void> = [];
let patched = false;

function ensureSheet(map: WeakMap<StyleRoot, CSSStyleSheet>, root: StyleRoot): CSSStyleSheet {
  let sheet = map.get(root);
  if (!sheet) {
    sheet = new CSSStyleSheet();
    map.set(root, sheet);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  }
  return sheet;
}

function safeReplace(sheet: CSSStyleSheet, cssText: string): void {
  try {
    sheet.replaceSync(cssText);
  } catch {
    // A malformed selector in one rule shouldn't take down every other rule.
  }
}

export function setRulesCSSForRoot(root: StyleRoot, cssText: string): void {
  safeReplace(ensureSheet(rulesSheets, root), cssText);
}

export function setPreviewCSSForRoot(root: StyleRoot, cssText: string): void {
  safeReplace(ensureSheet(previewSheets, root), cssText);
}

export function clearPreviewCSS(): void {
  const doc = previewSheets.get(document);
  if (doc) safeReplace(doc, "");
  for (const root of knownRoots) {
    const sheet = previewSheets.get(root);
    if (sheet) safeReplace(sheet, "");
  }
}

export function getKnownShadowRoots(): ShadowRoot[] {
  return Array.from(knownRoots);
}

/** Fires once for every currently-known root, then for every new one going forward. */
export function onEveryShadowRoot(cb: (root: ShadowRoot) => void): void {
  for (const root of knownRoots) cb(root);
  newRootListeners.push(cb);
}

function registerRoot(root: ShadowRoot): void {
  if (knownRoots.has(root)) return;
  knownRoots.add(root);
  for (const cb of newRootListeners) cb(root);
}

function walkExistingShadowRoots(node: ParentNode): void {
  for (const el of Array.from(node.querySelectorAll("*"))) {
    const root = (el as Element).shadowRoot;
    if (root) {
      registerRoot(root);
      walkExistingShadowRoots(root);
    }
  }
}

function patchAttachShadow(): void {
  if (patched) return;
  patched = true;
  const original = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
    const root = original.call(this, init);
    if (init.mode === "open") registerRoot(root);
    return root;
  };
}

/** Call once, as early as possible (document_start). */
export function initShadowSupport(): void {
  patchAttachShadow();
  if (document.body) walkExistingShadowRoots(document);
  else document.addEventListener("DOMContentLoaded", () => walkExistingShadowRoots(document), { once: true });
}
