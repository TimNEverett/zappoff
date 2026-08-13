import type { ZapRule } from "./types";

/** The one and only hiding mechanism (PRD §6.1, D2): `display: none`, never `visibility: hidden`. */
export function ruleCSS(rule: ZapRule): string {
  return `${rule.selector} { display: none !important; }`;
}
