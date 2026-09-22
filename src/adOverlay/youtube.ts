import type { AdDetector, AdStateListener } from "./detector";

/**
 * YouTube exposes ad state directly on the player container's class list
 * (`ad-showing` while an ad plays, plus `ad-interrupting` during the brief
 * transition into one). Watching that with a MutationObserver is free,
 * instant, and needs no polling loop.
 */
const PLAYER_SELECTOR = "#movie_player";
const AD_CLASSES = ["ad-showing", "ad-interrupting"];

// The player doesn't exist yet when a document_start content script runs, so
// retry with backoff until YouTube has mounted it.
const FIND_PLAYER_RETRY_DELAYS_MS = [0, 250, 500, 1000, 2000, 4000];

export class YoutubeAdDetector implements AdDetector {
  private readonly onChange: AdStateListener;
  private classObserver: MutationObserver | null = null;
  private player: HTMLElement | null = null;
  private wasAd = false;
  private stopped = true;
  private readonly onNavigate = (): void => {
    this.attachToCurrentPlayer();
  };

  constructor(onChange: AdStateListener) {
    this.onChange = onChange;
  }

  start(): void {
    this.stopped = false;
    // YouTube is a client-rendered SPA that dispatches this after each
    // in-app navigation completes (watch page <-> home, video <-> video),
    // which can swap out the underlying player element.
    window.addEventListener("yt-navigate-finish", this.onNavigate);
    void this.findAndAttach();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener("yt-navigate-finish", this.onNavigate);
    this.classObserver?.disconnect();
    this.classObserver = null;
    this.player = null;
    this.wasAd = false;
  }

  private async findAndAttach(): Promise<void> {
    for (const delay of FIND_PLAYER_RETRY_DELAYS_MS) {
      if (this.stopped) return;
      if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
      if (this.attachToCurrentPlayer()) return;
    }
  }

  private attachToCurrentPlayer(): boolean {
    const player = document.querySelector<HTMLElement>(PLAYER_SELECTOR);
    if (!player) return false;
    if (player === this.player) return true;

    this.classObserver?.disconnect();
    this.player = player;
    this.wasAd = false;
    this.classObserver = new MutationObserver(() => this.checkState());
    this.classObserver.observe(player, { attributes: true, attributeFilter: ["class"] });
    this.checkState();
    return true;
  }

  private checkState(): void {
    const player = this.player;
    if (!player) return;
    const isAd = AD_CLASSES.some((c) => player.classList.contains(c));
    if (isAd === this.wasAd) return;
    this.wasAd = isAd;
    this.onChange(isAd, player);
  }
}
