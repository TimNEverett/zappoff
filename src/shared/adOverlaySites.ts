/**
 * Origins with a Tier 1 (DOM/event-based) ad-detection profile. Shared
 * between the content-script module that runs the detectors and the
 * popup/options UI, which only show ad-overlay controls where they'd
 * actually do something.
 */
export const AD_OVERLAY_SUPPORTED_ORIGINS = new Set([
  "https://www.youtube.com",
  "https://youtube.com",
  "https://m.youtube.com",
]);

export function isAdOverlaySupportedOrigin(origin: string): boolean {
  return AD_OVERLAY_SUPPORTED_ORIGINS.has(origin);
}
