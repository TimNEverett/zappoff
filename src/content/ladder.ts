import { finder } from "@medv/finder";
import type { LadderRung } from "../shared/types";

/**
 * Builds the specificity ladder for a clicked element (PRD §6.2).
 *
 * Rung 0 comes from @medv/finder — a minimal selector guaranteed to match
 * only `target`. Rungs 1..n come from an independent ancestor-chain builder:
 * we climb from `target` up to the first ancestor level whose *full*
 * specificity (tag + id + classes + a preferred attribute + :nth-child) is
 * globally unique, then progressively relax that chain — dropping
 * :nth-child, then id, then classes (least-shared first), then the
 * attribute — before climbing to add one more ancestor level and repeating.
 * This produces the same "matches el, then progressively more siblings and
 * ancestors" shape without needing to parse finder's output string.
 */

const MAX_RUNGS = 8;
const MATCH_CEILING_ABS = 400;
const MATCH_CEILING_RATIO = 0.5;
const MAX_ANCESTOR_CLIMB = 25;

interface Level {
  el: Element;
  tag: string;
  id: string | null;
  /** Non-hash-like classes, ascending by document frequency (least-shared first = drop order). */
  classes: string[];
  attr: { name: string; value: string } | null;
  nth: string | null;
  nthActive: boolean;
  idActive: boolean;
  classesDropped: number;
}

const SEMANTIC_ATTR_PRIORITY = ["role", "aria-label", "name", "title"];

function isWordLike(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length < 100 && /^[\w\s-]+$/.test(trimmed);
}

/**
 * Heuristic for generated/hashed class or id names (Tailwind JIT, CSS
 * Modules, styled-components, emotion) that won't survive a redeploy.
 */
export function isHashLike(name: string): boolean {
  if (/^(css|sc|emotion|jsx|styled|chakra|mui)-[a-z0-9]{4,}$/i.test(name)) return true;
  if (/__[a-z0-9]{4,10}$/i.test(name) && /\d/.test(name)) return true;
  if (/^[a-z0-9]{6,14}$/i.test(name) && /\d/.test(name) && /[a-z]/i.test(name)) {
    const letters = name.replace(/[^a-z]/gi, "");
    const vowels = (letters.match(/[aeiou]/gi) ?? []).length;
    if (letters.length === 0 || vowels / letters.length < 0.2) return true;
  }
  return false;
}

function pickPreferredAttr(el: Element): { name: string; value: string } | null {
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith("data-") && isWordLike(attr.value)) {
      return { name: attr.name, value: attr.value };
    }
  }
  for (const name of SEMANTIC_ATTR_PRIORITY) {
    const value = el.getAttribute(name);
    if (value && isWordLike(value)) return { name, value };
  }
  return null;
}

function countByClass(root: Document | ShadowRoot, cls: string): number {
  try {
    return root.querySelectorAll(`.${CSS.escape(cls)}`).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function buildLevel(el: Element, root: Document | ShadowRoot): Level {
  const tag = el.tagName.toLowerCase();
  const rawId = el.getAttribute("id");
  const id = rawId && !isHashLike(rawId) && /^[a-zA-Z][\w-]*$/.test(rawId) ? rawId : null;

  const rawClasses = Array.from(el.classList).filter(
    (c) => !isHashLike(c) && /^[a-zA-Z_-][\w-]*$/.test(c),
  );
  const classes = rawClasses
    .map((c) => ({ c, freq: countByClass(root, c) }))
    .sort((a, b) => a.freq - b.freq)
    .map((x) => x.c);

  const attr = pickPreferredAttr(el);

  const parent = el.parentElement;
  const nth = parent ? `:nth-child(${Array.prototype.indexOf.call(parent.children, el) + 1})` : null;

  return {
    el,
    tag,
    id,
    classes,
    attr,
    nth,
    nthActive: nth !== null,
    idActive: id !== null,
    classesDropped: 0,
  };
}

function escapeAttrValue(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function renderLevel(level: Level): string {
  let s = level.tag;
  if (level.attr) {
    s += `[${level.attr.name}="${escapeAttrValue(level.attr.value)}"]`;
  } else {
    for (const c of level.classes.slice(level.classesDropped)) {
      s += `.${CSS.escape(c)}`;
    }
  }
  if (level.idActive && level.id) s += `#${CSS.escape(level.id)}`;
  if (level.nthActive && level.nth) s += level.nth;
  return s;
}

function renderChain(chain: Level[]): string {
  return chain.map(renderLevel).join(" > ");
}

function climbOneAncestor(chain: Level[], root: Document | ShadowRoot): boolean {
  const top = chain[0];
  const parentEl = top.el.parentElement;
  if (!parentEl || parentEl.tagName === "HTML") return false;
  chain.unshift(buildLevel(parentEl, root));
  return true;
}

function relaxOneStep(chain: Level[], root: Document | ShadowRoot): boolean {
  const active = chain[0];
  if (active.nthActive) {
    active.nthActive = false;
    return true;
  }
  if (active.idActive) {
    active.idActive = false;
    return true;
  }
  if (active.classesDropped < active.classes.length) {
    active.classesDropped++;
    return true;
  }
  if (active.attr) {
    active.attr = null;
    return true;
  }
  return climbOneAncestor(chain, root);
}

export function computeLadder(target: Element, root: Document | ShadowRoot): LadderRung[] {
  const rungs: LadderRung[] = [];
  const seen = new Set<string>();
  const totalElements = root.querySelectorAll("*").length || 1;
  const ceiling = Math.min(MATCH_CEILING_ABS, Math.max(20, Math.floor(totalElements * MATCH_CEILING_RATIO)));
  const mainEl = document.querySelector("main");

  // Rung 0: minimal unique selector via @medv/finder.
  try {
    const finderRoot = (root instanceof Document ? root.body : root.firstElementChild) as Element | undefined;
    const rung0 = finder(target, {
      root: finderRoot ?? target,
      className: (n: string) => !isHashLike(n),
      idName: (n: string) => !isHashLike(n),
    });
    const count = root.querySelectorAll(rung0).length;
    if (count >= 1) {
      rungs.push({ selector: rung0, matchCount: count });
      seen.add(rung0);
    }
  } catch {
    // @medv/finder can throw if it times out or the element is document-root-adjacent;
    // the ancestor-chain builder below still guarantees a first rung.
  }

  const chain: Level[] = [buildLevel(target, root)];
  let climbGuard = 0;
  while (root.querySelectorAll(renderChain(chain)).length !== 1 && climbGuard < MAX_ANCESTOR_CLIMB) {
    if (!climbOneAncestor(chain, root)) break;
    climbGuard++;
  }

  const recordCurrent = (): boolean => {
    const sel = renderChain(chain);
    let matches: Element[];
    try {
      matches = Array.from(root.querySelectorAll(sel));
    } catch {
      return false;
    }
    if (!matches.includes(target)) return false;

    if (!seen.has(sel)) {
      const prev = rungs[rungs.length - 1];
      if (!prev || prev.matchCount !== matches.length) {
        rungs.push({ selector: sel, matchCount: matches.length });
      }
      seen.add(sel);
    }

    if (rungs.length >= MAX_RUNGS) return false;
    if (matches.length > ceiling) return false;
    if (mainEl && matches.some((m) => m !== target && m.contains(mainEl))) return false;
    return true;
  };

  let keepGoing = recordCurrent();
  while (keepGoing) {
    if (!relaxOneStep(chain, root)) break;
    keepGoing = recordCurrent();
  }

  return rungs;
}

/**
 * Short descriptor for an element: tag + id/class. Doubles as the overlay
 * hover badge text (R2.1) and as a matchable selector fragment for
 * `ZapRule.shadowPath` host entries (§6.5).
 */
export function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.getAttribute("id");
  if (id && !isHashLike(id) && /^[a-zA-Z][\w-]*$/.test(id)) return `${tag}#${CSS.escape(id)}`;
  const firstClass = Array.from(el.classList).find(
    (c) => !isHashLike(c) && /^[a-zA-Z_-][\w-]*$/.test(c),
  );
  if (firstClass) return `${tag}.${CSS.escape(firstClass)}`;
  return tag;
}
