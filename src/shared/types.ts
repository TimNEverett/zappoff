export type ScopeLevel = "page" | "section" | "site";

export interface ZapRule {
  id: string;
  /** Origin the rule belongs to, e.g. "https://www.youtube.com" */
  origin: string;
  /** Match pattern derived from scopeLevel, e.g. exact path / prefix / origin-wide. Query + hash stripped. */
  scope: string;
  scopeLevel: ScopeLevel;
  /** The selector currently in effect (ladder[rungIndex]). */
  selector: string;
  /** Every candidate selector computed at creation time, most specific first. */
  ladder: string[];
  rungIndex: number;
  /**
   * Path (list of shadow-host selectors, outermost first) from document root
   * down to the shadow root that contains the target element, or null if the
   * element lives in the light DOM.
   */
  shadowPath: string[] | null;
  enabled: boolean;
  label: string;
  createdAt: number;
  lastMatchedAt: number | null;
  /** True once a page load found zero matches for `selector` where it previously matched. */
  stale: boolean;
}

export interface ZapStore {
  version: 1;
  rules: ZapRule[];
  disabledOrigins: string[];
}

export const EMPTY_STORE: ZapStore = {
  version: 1,
  rules: [],
  disabledOrigins: [],
};

export interface LadderRung {
  selector: string;
  matchCount: number;
}

/**
 * Settings for the ad-overlay feature: mute+cover video ads in place rather
 * than blocking them outright. Separate namespace from ZapStore/ZapRule
 * (which are user-authored, per-element hide rules) since this is a single
 * global behavior toggle plus per-site opt-out, not a rule list.
 */
export interface AdOverlaySettings {
  version: 1;
  enabled: boolean;
  disabledOrigins: string[];
}

export const EMPTY_AD_OVERLAY_SETTINGS: AdOverlaySettings = {
  version: 1,
  enabled: true,
  disabledOrigins: [],
};
