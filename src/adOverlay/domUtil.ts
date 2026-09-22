/**
 * A plain `querySelector("video")` doesn't cross shadow boundaries, and
 * player markup can mount the actual playing `<video>` (or an ad-specific
 * one alongside the content video) inside an open shadow root, or slightly
 * after an ad-state class flips. This walks light DOM plus any nested open
 * shadow roots (closed roots are unsupported, same limitation as the
 * hide-rules engine — see content/shadow.ts) and returns every match.
 */
export function findVideosDeep(root: ParentNode): HTMLVideoElement[] {
  const found: HTMLVideoElement[] = Array.from(root.querySelectorAll("video"));
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const shadow = el.shadowRoot;
    if (shadow) found.push(...findVideosDeep(shadow));
  }
  return found;
}

/** The video most likely to be the one actually on screen and playing. */
export function pickPrimaryVideo(videos: HTMLVideoElement[]): HTMLVideoElement | null {
  if (videos.length === 0) return null;
  const playing = videos.find((v) => !v.paused && !v.ended);
  if (playing) return playing;
  return videos.reduce((a, b) => (a.offsetWidth * a.offsetHeight >= b.offsetWidth * b.offsetHeight ? a : b));
}
