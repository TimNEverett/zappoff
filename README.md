# Zap

Click any element on a webpage and permanently hide it on that site. A Chrome
MV3 extension implementing the PRD's v1 scope: picker → specificity ladder →
scoped, persistent `display: none` rules, with shadow DOM, SPA, and no-flash
handling.

## Build & load

```
npm install
npm run build      # bundles into dist/
```

Then in Chrome: `chrome://extensions` → enable Developer mode → **Load
unpacked** → select the `dist/` folder.

`npm run watch` rebuilds on change (reload the extension in `chrome://extensions`
after each rebuild — Chrome doesn't hot-reload unpacked extensions).

`npm run typecheck` runs `tsc --noEmit`. `npm run icons` regenerates the
placeholder toolbar icons.

## Usage

- Click the toolbar icon → **Zap an element**, or press `Ctrl+Shift+X`
  (`Cmd+Shift+X` on Mac).
- The first time you zap something on a given site, Chrome will ask you to
  grant that site's host permission — this is the only permission prompt
  you'll see, and it's scoped to that one origin (§6.8 of the PRD).
- Hover to highlight, click to pick an element, drag the slider (or use
  ←/→) to widen or narrow the match, pick a scope (this page / this
  section / whole site), and hit **Zap** or <kbd>Enter</kbd>.
- Manage rules from the popup (per-page) or the options page (everything,
  with JSON export/import).

## Architecture

Matches PRD §6.3 directly:

- `src/sw` — service worker. Owns the canonical rule store, keeps an
  in-memory mirror hydrated from `chrome.storage`, and injects light-DOM
  hiding CSS synchronously on `webNavigation.onCommitted` so rules apply
  before first paint (§6.4).
- `src/content` — content script: the picker overlay (`picker.ts`), the
  specificity-ladder algorithm (`ladder.ts`), shadow DOM adoption
  (`shadow.ts`), SPA navigation handling (`spa.ts`), and per-page rule
  application (`rulesEngine.ts`).
- `src/popup`, `src/options` — vanilla-DOM UI, no framework.
- `src/shared` — types, the scope-matching logic, `chrome.storage`
  persistence (chunked per-origin, sync with a local-storage quota
  fallback), and the message protocol between all of the above.

## Known v1 limitations

A few of these are explicit PRD decisions; the rest are pragmatic calls made
where the PRD flagged something as an open question or a low-severity,
"if needed" risk.

- **Closed shadow roots are unsupported by design** (PRD D3) — force-opening
  them was explicitly rejected as too invasive/detectable.
- **Shadow-DOM flash on slow pages**: only the top-level document's rules are
  guaranteed pre-paint (via the service worker); shadow-scoped rules apply
  once the content script's async store fetch resolves, which is normally
  fast but isn't a hard guarantee. The PRD marks this Low severity with an
  optional opacity-cloak fallback; that fallback isn't implemented in v1.
- **Nested shadow trees**: `shadowPath` records only the immediate
  containing shadow root's host descriptor. A rule created two shadow
  boundaries deep matches on that innermost host only, not the full
  ancestor chain.
- **Stale-rule signal** (R6.1) uses "matched at least once, ever" as
  "previously matched" — the PRD leaves this as an open question (#2); a
  window-based signal (e.g. "matched in the last N loads") was not built.
- **Section-scope heuristic** (open question #1) is a flat "drop the last
  path segment" rule with no per-site special-casing.
- **No first-run onboarding** beyond the picker itself (open question #3).
- **Cross-origin iframes** are out of scope, matching R4.5's "same-origin
  iframes" wording — this falls out naturally from the per-origin
  permission model rather than needing separate handling.
- Live match-count highlighting in the picker preview is capped at 150
  boxes for render performance; the actual hiding CSS still applies to every
  match regardless of the cap.

## Testing performed

`tsc --noEmit` and the esbuild bundle both pass cleanly (~32KB JS total,
under the PRD's 50KB target). The extension was also smoke-tested end to end
in real Chromium via Playwright (loaded unpacked, host permission
pre-granted to sidestep Chrome's native permission-prompt UI, which
automation can't click through): content script + shadow DOM init, picker
activation, hover/click seeding, ladder widening (verified against the "hide
every promoted post, leave regular posts alone" case from PRD U3), rule
creation, persistence across reload via the service worker's pre-paint
injection path, and undo.

Not exercised by automation: the real toolbar-icon popup click and the
native Chrome permission-prompt dialog (both are outside what Playwright can
drive for MV3 extensions) — these were verified by code review instead.
