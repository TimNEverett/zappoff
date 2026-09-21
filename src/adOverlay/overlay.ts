/**
 * The bundled v1 placeholder (see plan: "single bundled placeholder", no
 * config UI). Drawn from CSS rather than a shipped image/video asset, so it
 * scales to any player size with no `web_accessible_resources` entry needed.
 *
 * Rendered inside a closed shadow root so the host page's CSS can't leak in
 * (and so a host page can't style-probe the overlay's contents out).
 */

const CARD_CSS = `
  :host { all: initial; }
  .card {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: #0b0c10;
    color: #f4f6ff;
    font: 600 14px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .bolt {
    font-size: 28px;
    filter: drop-shadow(0 0 6px rgba(79, 124, 255, 0.6));
  }
  .label {
    letter-spacing: 0.02em;
    opacity: 0.85;
  }
`;

export class AdOverlay {
  private host: HTMLDivElement | null = null;
  private target: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly onWindowChange = (): void => this.reposition();

  show(target: HTMLElement): void {
    this.target = target;
    if (!this.host) this.host = this.build();
    if (!this.host.isConnected) document.documentElement.appendChild(this.host);

    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(() => this.reposition());
    }
    this.resizeObserver.observe(target);
    window.addEventListener("resize", this.onWindowChange);
    window.addEventListener("scroll", this.onWindowChange, true);
    this.reposition();
  }

  hide(): void {
    this.host?.remove();
    if (this.target) this.resizeObserver?.unobserve(this.target);
    window.removeEventListener("resize", this.onWindowChange);
    window.removeEventListener("scroll", this.onWindowChange, true);
    this.target = null;
  }

  private reposition(): void {
    if (!this.host || !this.target) return;
    const rect = this.target.getBoundingClientRect();
    Object.assign(this.host.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  private build(): HTMLDivElement {
    const host = document.createElement("div");
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "none";

    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CARD_CSS;
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="bolt">⚡</div><div class="label">Ad zapped</div>`;
    shadow.append(style, card);

    return host;
  }
}
