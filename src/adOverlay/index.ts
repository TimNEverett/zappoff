import { EMPTY_AD_OVERLAY_SETTINGS, type AdOverlaySettings } from "../shared/types";
import { originOf } from "../shared/scope";
import { isAdOverlaySupportedOrigin } from "../shared/adOverlaySites";
import type { AdDetector } from "./detector";
import { findVideosDeep, pickPrimaryVideo } from "./domUtil";
import { AdOverlay } from "./overlay";
import { YoutubeAdDetector } from "./youtube";

/**
 * Entry point for the ad-overlay feature (separate from the hide-rules
 * engine in rulesEngine.ts — this is live mute/cover/reveal, not a
 * persisted per-site rule). Owns which site profile is active for the
 * current frame and reacts to settings changes without a page reload.
 */

// While an ad is showing, re-find and re-mute on this cadence rather than
// trusting a single snapshot taken the instant the ad-state class flips —
// the ad's <video> can mount slightly later, or get swapped out mid-ad.
const MUTE_REASSERT_INTERVAL_MS = 500;

let settings: AdOverlaySettings = EMPTY_AD_OVERLAY_SETTINGS;
let detector: AdDetector | null = null;
let mutedVideos = new Set<HTMLVideoElement>();
let muteInterval: number | null = null;
const overlay = new AdOverlay();

function detectorFor(origin: string): (() => AdDetector) | null {
  // Only one Tier 1 profile exists so far; more (e.g. generic IMA-SDK sites)
  // plug in here behind the same isAdOverlaySupportedOrigin check.
  if (isAdOverlaySupportedOrigin(origin)) return () => new YoutubeAdDetector(onAdStateChange);
  return null;
}

function muteAndOverlay(player: HTMLElement): void {
  const videos = findVideosDeep(player);
  for (const video of videos) {
    if (!video.muted) {
      video.muted = true;
      mutedVideos.add(video);
    }
  }
  const primary = pickPrimaryVideo(videos);
  if (primary) overlay.show(primary);
}

function onAdStateChange(isAd: boolean, player: HTMLElement): void {
  if (muteInterval != null) {
    window.clearInterval(muteInterval);
    muteInterval = null;
  }

  if (isAd) {
    muteAndOverlay(player);
    muteInterval = window.setInterval(() => muteAndOverlay(player), MUTE_REASSERT_INTERVAL_MS);
  } else {
    overlay.hide();
    for (const video of mutedVideos) video.muted = false;
    mutedVideos.clear();
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
  if (muteInterval != null) {
    window.clearInterval(muteInterval);
    muteInterval = null;
  }
  overlay.hide();
  for (const video of mutedVideos) video.muted = false;
  mutedVideos.clear();
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
