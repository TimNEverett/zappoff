import type { ScopeLevel } from "./types";

/** Strips query string and hash fragment, per R4.2c. */
export function stripQueryAndHash(url: string): string {
  const u = new URL(url);
  u.search = "";
  u.hash = "";
  return u.toString();
}

function normalizedPath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

/**
 * Computes the scope match pattern for a URL at a given breadth level.
 * - page:    exact origin + path (no trailing wildcard)
 * - section: origin + path-prefix-up-to-last-segment + "/*"
 * - site:    origin + "/*"
 */
export function computeScope(url: string, level: ScopeLevel): string {
  const u = new URL(url);
  const path = normalizedPath(u.pathname);

  if (level === "site") {
    return `${u.origin}/*`;
  }

  if (level === "page") {
    return `${u.origin}${path}`;
  }

  // section: drop the last path segment
  const segments = path.split("/").filter(Boolean);
  const prefixSegments = segments.length > 1 ? segments.slice(0, -1) : segments;
  const prefix = prefixSegments.length > 0 ? `/${prefixSegments.join("/")}` : "";
  return `${u.origin}${prefix}/*`;
}

/** Whether `url` (query/hash ignored) falls within a rule's stored scope pattern. */
export function matchesScope(url: string, scope: string, level: ScopeLevel): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const targetStr = `${target.origin}${normalizedPath(target.pathname)}`;

  if (level === "page") {
    return targetStr === scope;
  }

  // section / site scopes are stored as "<prefix>/*"
  const prefix = scope.endsWith("/*") ? scope.slice(0, -1) : scope; // keep trailing "/"
  return targetStr === scope.slice(0, -2) || targetStr.startsWith(prefix);
}

export function originOf(url: string): string {
  return new URL(url).origin;
}
