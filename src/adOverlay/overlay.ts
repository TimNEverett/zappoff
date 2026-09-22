/**
 * The bundled v1 placeholder (see plan: "single bundled placeholder", no
 * config UI). Drawn from CSS rather than a shipped image/video asset, so it
 * scales to any player size with no `web_accessible_resources` entry needed.
 *
 * Rendered inside a closed shadow root so the host page's CSS can't leak in
 * (and so a host page can't style-probe the overlay's contents out).
 *
 * The card is inserted as a DOM sibling of the `<video>` element itself —
 * sized to fill its parent via `inset: 0` rather than a JS-measured,
 * viewport-fixed rect — instead of a document-level overlay above the whole
 * player. That keeps it in the *same* local stacking context as the
 * player's own controls (skip button, progress bar, ad countdown), which
 * have an explicitly higher z-index and so stay visible and clickable. The
 * video itself is hidden with `visibility: hidden` rather than covered —
 * audio is unaffected by that (muting is handled separately), and it means
 * the card never has to out-rank the video for stacking order either.
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
  private card: HTMLDivElement | null = null;
  private video: HTMLVideoElement | null = null;
  private restorePosition: string | null = null;

  show(video: HTMLVideoElement): void {
    if (this.video && this.video !== video) this.restoreVideo();
    this.video = video;
    video.style.visibility = "hidden";

    const container = video.parentElement ?? video;
    // `inset: 0` on the card only lines up with the video if `container` is
    // a positioned element — which it almost always already is, since the
    // video itself is normally absolutely positioned to fill it. Force it
    // as a fallback rather than assuming.
    if (getComputedStyle(container).position === "static") {
      this.restorePosition = container.style.position || "";
      container.style.position = "relative";
    }

    if (!this.card) this.card = this.build();
    if (this.card.parentElement !== container) container.appendChild(this.card);
  }

  hide(): void {
    this.card?.remove();
    this.restoreVideo();
  }

  private restoreVideo(): void {
    const video = this.video;
    if (!video) return;
    video.style.visibility = "";
    if (this.restorePosition !== null) {
      const container = video.parentElement;
      if (container) container.style.position = this.restorePosition;
      this.restorePosition = null;
    }
    this.video = null;
  }

  private build(): HTMLDivElement {
    const card = document.createElement("div");
    card.style.position = "absolute";
    card.style.inset = "0";
    card.style.pointerEvents = "none";

    const shadow = card.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CARD_CSS;
    const inner = document.createElement("div");
    inner.className = "card";
    inner.innerHTML = `<div class="bolt">⚡</div><div class="label">Ad zapped</div>`;
    shadow.append(style, inner);

    return card;
  }
}
