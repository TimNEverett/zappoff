import type { LadderRung, ScopeLevel } from "../shared/types";
import { sendToBackground } from "../shared/messages";
import { computeLadder, describeElement } from "./ladder";
import { clearPreviewCSS, setPreviewCSSForRoot } from "./shadow";

/**
 * The picker (PRD §5.2/§5.3): hover-to-highlight, click-to-seed, then a
 * breadth ("ladder") control for choosing how broadly the rule matches,
 * with a live, real preview (the actual hiding CSS, not a mock outline) and
 * a scope control for how broadly the rule *persists* (R4.2a). Lives in a
 * closed shadow root so page CSS can never bleed in or out (§6.9).
 */

const SCOPE_LEVELS: ScopeLevel[] = ["page", "section", "site"];
const SCOPE_LABELS: Record<ScopeLevel, string> = {
  page: "This page",
  section: "This section",
  site: "Whole site",
};

function deepElementFromPoint(x: number, y: number): Element | null {
  let el: Element | null = document.elementFromPoint(x, y);
  let guard = 0;
  while (el?.shadowRoot && guard < 20) {
    const inner: Element | null = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
    guard++;
  }
  return el;
}

function rootOf(el: Element): Document | ShadowRoot {
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root : document;
}

function computeShadowPath(el: Element): string[] | null {
  const root = rootOf(el);
  if (root === document) return null;
  // v1: single-level — records the immediate containing root's host descriptor.
  // Deeply nested shadow trees fall back to matching on that innermost host only.
  return [describeElement((root as ShadowRoot).host)];
}

const STYLE = `
  :host { all: initial; }
  .hover-box, .match-box {
    position: fixed;
    border: 2px solid #4f7cff;
    background: rgba(79, 124, 255, 0.15);
    pointer-events: none;
    box-sizing: border-box;
    z-index: 1;
    border-radius: 2px;
  }
  .match-box { border-color: #ff5470; background: rgba(255, 84, 112, 0.12); }
  .label {
    position: fixed;
    pointer-events: none;
    background: #1a1d29;
    color: #fff;
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 2px 6px;
    border-radius: 4px;
    z-index: 2;
    white-space: nowrap;
  }
  .panel {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    pointer-events: auto;
    background: #1a1d29;
    color: #fff;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    border-radius: 12px;
    padding: 14px 18px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.35);
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 340px;
    z-index: 3;
  }
  .row { display: flex; align-items: center; gap: 10px; }
  .count { font-weight: 600; flex: 1; }
  input[type="range"] { flex: 1; accent-color: #4f7cff; }
  .scope { display: flex; gap: 4px; background: #262a3d; border-radius: 8px; padding: 3px; }
  .scope button {
    flex: 1; border: none; background: transparent; color: #b8bcd0;
    padding: 6px 8px; border-radius: 6px; font: inherit; cursor: pointer;
  }
  .scope button.active { background: #4f7cff; color: #fff; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  button.primary, button.secondary {
    font: inherit; border: none; border-radius: 8px; padding: 7px 14px; cursor: pointer;
  }
  button.primary { background: #4f7cff; color: #fff; }
  button.secondary { background: #262a3d; color: #b8bcd0; }
  .hint { color: #8a8fa8; font-size: 11px; }
`;

export class PickerSession {
  private hostEl: HTMLDivElement;
  private shadow: ShadowRoot;
  private hoverBox: HTMLDivElement;
  private label: HTMLDivElement;
  private matchBoxesContainer: HTMLDivElement;
  private rungInput: HTMLInputElement | null = null;
  private countEl: HTMLDivElement | null = null;

  private seeded = false;
  private seedEl: Element | null = null;
  private seedRoot: Document | ShadowRoot = document;
  private shadowPath: string[] | null = null;
  private ladder: LadderRung[] = [];
  private rungIndex = 0;
  private scopeLevel: ScopeLevel = "page";
  private done = false;

  private onFinish: () => void;

  constructor(onFinish: () => void) {
    this.onFinish = onFinish;
    this.hostEl = document.createElement("div");
    this.hostEl.id = "zap-picker-host";
    this.hostEl.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    this.shadow = this.hostEl.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = STYLE;
    this.shadow.appendChild(style);

    this.hoverBox = document.createElement("div");
    this.hoverBox.className = "hover-box";
    this.hoverBox.style.display = "none";

    this.label = document.createElement("div");
    this.label.className = "label";
    this.label.style.display = "none";

    this.matchBoxesContainer = document.createElement("div");

    this.shadow.append(this.hoverBox, this.label, this.matchBoxesContainer);
    document.documentElement.appendChild(this.hostEl);

    this.onMouseMove = this.onMouseMove.bind(this);
    this.onClick = this.onClick.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onSuppress = this.onSuppress.bind(this);
  }

  start(): void {
    document.addEventListener("mousemove", this.onMouseMove, true);
    document.addEventListener("click", this.onClick, true);
    document.addEventListener("keydown", this.onKeyDown, true);
    for (const type of ["mousedown", "mouseup", "contextmenu", "submit", "dragstart"]) {
      document.addEventListener(type, this.onSuppress, true);
    }
  }

  private stop(): void {
    document.removeEventListener("mousemove", this.onMouseMove, true);
    document.removeEventListener("click", this.onClick, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    for (const type of ["mousedown", "mouseup", "contextmenu", "submit", "dragstart"]) {
      document.removeEventListener(type, this.onSuppress, true);
    }
    clearPreviewCSS();
    this.hostEl.remove();
  }

  private isOwnEvent(e: Event): boolean {
    return e.target === this.hostEl;
  }

  private onSuppress(e: Event): void {
    if (this.isOwnEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();
  }

  private onMouseMove(e: MouseEvent): void {
    if (this.seeded || this.isOwnEvent(e)) return;
    const target = deepElementFromPoint(e.clientX, e.clientY);
    if (!target || target === document.documentElement || target === document.body) {
      this.hoverBox.style.display = "none";
      this.label.style.display = "none";
      return;
    }
    const rect = target.getBoundingClientRect();
    this.hoverBox.style.display = "block";
    Object.assign(this.hoverBox.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    this.label.style.display = "block";
    this.label.textContent = describeElement(target);
    Object.assign(this.label.style, {
      left: `${rect.left}px`,
      top: `${Math.max(0, rect.top - 22)}px`,
    });
  }

  private onClick(e: MouseEvent): void {
    if (this.isOwnEvent(e)) return; // let panel buttons/input work
    e.preventDefault();
    e.stopPropagation();
    if (this.seeded) return;

    const target = deepElementFromPoint(e.clientX, e.clientY);
    if (!target) return;
    this.seedTarget(target);
  }

  private seedTarget(target: Element): void {
    this.seeded = true;
    this.seedEl = target;
    this.seedRoot = rootOf(target);
    this.shadowPath = computeShadowPath(target);
    this.ladder = computeLadder(target, this.seedRoot);
    this.rungIndex = 0;
    this.hoverBox.style.display = "none";
    this.label.style.display = "none";
    this.renderPanel();
    this.renderRung();
  }

  private renderPanel(): void {
    const panel = document.createElement("div");
    panel.className = "panel";

    const countRow = document.createElement("div");
    countRow.className = "row";
    this.countEl = document.createElement("div");
    this.countEl.className = "count";
    countRow.appendChild(this.countEl);

    const sliderRow = document.createElement("div");
    sliderRow.className = "row";
    const rungInput = document.createElement("input");
    rungInput.type = "range";
    rungInput.min = "0";
    rungInput.max = String(Math.max(0, this.ladder.length - 1));
    rungInput.value = "0";
    rungInput.addEventListener("input", () => {
      this.rungIndex = Number(rungInput.value);
      this.renderRung();
    });
    this.rungInput = rungInput;
    sliderRow.appendChild(rungInput);

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Drag or use ←/→ to choose how broadly this rule matches";

    const scope = document.createElement("div");
    scope.className = "scope";
    for (const level of SCOPE_LEVELS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = SCOPE_LABELS[level];
      btn.dataset.level = level;
      btn.addEventListener("click", () => {
        this.scopeLevel = level;
        this.updateScopeButtons(scope);
      });
      scope.appendChild(btn);
    }

    const actions = document.createElement("div");
    actions.className = "actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => this.cancel());
    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "primary";
    confirmBtn.textContent = "Zap";
    confirmBtn.addEventListener("click", () => void this.confirm());
    actions.append(cancelBtn, confirmBtn);

    panel.append(countRow, sliderRow, hint, scope, actions);
    this.shadow.appendChild(panel);
    this.updateScopeButtons(scope);
  }

  private updateScopeButtons(scope: HTMLDivElement): void {
    for (const btn of Array.from(scope.querySelectorAll("button"))) {
      btn.classList.toggle("active", btn.dataset.level === this.scopeLevel);
    }
  }

  private renderRung(): void {
    if (!this.seedEl) return;
    const rung = this.ladder[this.rungIndex];
    if (!rung) return;
    if (this.rungInput) this.rungInput.value = String(this.rungIndex);
    if (this.countEl) {
      this.countEl.textContent = `Hides ${rung.matchCount} element${rung.matchCount === 1 ? "" : "s"}`;
    }

    // Restore layout before measuring so rects reflect the un-hidden page.
    clearPreviewCSS();

    let matches: Element[] = [];
    try {
      matches = Array.from(this.seedRoot.querySelectorAll(rung.selector));
    } catch {
      matches = [];
    }

    this.matchBoxesContainer.replaceChildren();
    for (const el of matches.slice(0, 150)) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const box = document.createElement("div");
      box.className = "match-box";
      Object.assign(box.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      this.matchBoxesContainer.appendChild(box);
    }

    // R3.4: the real hiding CSS, not a mock — this is what confirm will persist.
    const css = `${rung.selector} { display: none !important; }`;
    setPreviewCSSForRoot(this.seedRoot, css);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.isOwnEvent(e)) return;
    if (!this.seeded) {
      if (e.key === "Escape") {
        e.preventDefault();
        this.cancel();
      }
      return;
    }
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        this.rungIndex = Math.max(0, this.rungIndex - 1);
        this.renderRung();
        break;
      case "ArrowRight":
        e.preventDefault();
        this.rungIndex = Math.min(this.ladder.length - 1, this.rungIndex + 1);
        this.renderRung();
        break;
      case "Enter":
        e.preventDefault();
        void this.confirm();
        break;
      case "Escape":
        e.preventDefault();
        this.cancel();
        break;
      default:
        break;
    }
  }

  private cancel(): void {
    if (this.done) return;
    this.done = true;
    this.stop();
    this.onFinish();
  }

  private async confirm(): Promise<void> {
    if (this.done || !this.seedEl) return;
    const rung = this.ladder[this.rungIndex];
    if (!rung) return;

    const origin = location.origin;
    const granted = await this.ensureHostPermission(origin);
    if (!granted) {
      this.cancel();
      return;
    }

    this.done = true;
    const response = await sendToBackground({
      type: "CREATE_RULE",
      origin,
      scopeLevel: this.scopeLevel,
      pageUrl: location.href,
      ladder: this.ladder.map((r) => r.selector),
      rungIndex: this.rungIndex,
      shadowPath: this.shadowPath,
      label: describeElement(this.seedEl),
    });
    if (!response.ok) {
      console.warn("[Zap] failed to create rule:", response.error);
    }
    this.stop();
    this.onFinish();
  }

  private async ensureHostPermission(origin: string): Promise<boolean> {
    const response = await sendToBackground({ type: "REQUEST_HOST_PERMISSION", origin });
    return response.ok && response.granted === true;
  }
}
