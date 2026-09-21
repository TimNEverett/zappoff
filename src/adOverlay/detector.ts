/**
 * Tier 1 ad detection: DOM/event-based, no network calls, no polling loop.
 * Each site profile (YouTube, generic IMA-SDK, ...) implements this the same
 * way — watch known ad-state markers on the player and report transitions.
 * A future Tier 2 (model-based fallback for sites with no usable DOM signal)
 * would implement the same interface so callers don't care which is active.
 */
export interface AdDetector {
  start(): void;
  stop(): void;
}

/** Called with `true` when an ad starts covering `player`, `false` when it ends. */
export type AdStateListener = (isAd: boolean, player: HTMLElement) => void;
