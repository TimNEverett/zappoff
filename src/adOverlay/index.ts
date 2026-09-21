import { EMPTY_AD_OVERLAY_SETTINGS, type AdOverlaySettings } from "../shared/types";
import { originOf } from "../shared/scope";
import { isAdOverlaySupportedOrigin } from "../shared/adOverlaySites";
import type { AdDetector } from "./detector";
import { AdOverlay } from "./overlay";
import { YoutubeAdDetector } from "./youtube";

/**
 * Entry point for the ad-overlay feature (separate from the hide-rules
 * engine in rulesEngine.ts — this is live mute/cover/reveal, not a
 * persisted per-site rule). Owns which site profile is active for the
 * current frame and reacts to settings changes without a page reload.
 */

let settings: AdOverlaySettings = EMPTY_AD_OVERLAY_SETTINGS;
let detector: AdDetector | null = null;
let mutedByUs = false;
const overlay = new AdOverlay();

function detectorFor(origin: string): (() => AdDetector) | null {
  // Only one Tier 1 profile exists so far; more (e.g. generic IMA-SDK sites)
  // plug in here behind the same isAdOverlaySupportedOrigin check.
  if (isAdOverlaySupportedOrigin(origin)) return () => new YoutubeAdDetector(onAdStateChange);
  return null;
}

function onAdStateChange(isAd: boolean, player: HTMLElement): void {
  const video = player.querySelector("video");
  if (isAd) {
    overlay.show(player);
    if (video && !video.muted) {
      video.muted = true;
      mutedByUs = true;
    }
  } else {
    overlay.hide();
    if (video && mutedByUs) video.muted = false;
    mutedByUs = false;
  }
}

function currentOrigin(): string | null {
  try {
    return originOf(location.href);
  } catch {
    return null;
  }
}

function shouldRun(origin: string | null): boolean {
  return settings.enabled && origin != null && !settings.disabledOrigins.includes(origin);
}

function startIfEligible(): void {
  if (detector) return;
  const origin = currentOrigin();
  if (!shouldRun(origin)) return;
  const factory = origin ? detectorFor(origin) : null;
  if (!factory) return;
  detector = factory();
  detector.start();
}

function stopDetector(): void {
  detector?.stop();
  detector = null;
  overlay.hide();
  mutedByUs = false;
}

export function initAdOverlay(initialSettings: AdOverlaySettings): void {
  settings = initialSettings;
  startIfEligible();
}

export function setAdOverlaySettings(next: AdOverlaySettings): void {
  settings = next;
  if (shouldRun(currentOrigin())) startIfEligible();
  else stopDetector();
}
