# Changelog

## 0.1.2 — 2026-10-29

- Fix: the newest OpenCode version is now read from the same endpoint `/update` uses (then npm), not only from the
  GitHub API. With the API rate-limited, 0.1.1 showed 2.2.0 as the latest while 2.2.1 was out.
- Fix: right after an OpenCode update the notes for the new installed version are fetched at once instead of showing
  “Notes for … are not published yet” for up to 5 minutes. Existing caches heal on the next open.

## 0.1.1 — 2026-10-29

- Installer `scripts/install.mjs`: checks that OpenCode is 2.1.4 or newer (and explains how to update otherwise),
  builds the plugin and registers it in `cli.json` with the built-in highlights dialog turned off.
- README: install by asking your agent first, manual install below; step-by-step instructions for coding agents.
  Verified on OpenCode 2.0.32 and 2.1.3 (refused) and 2.1.4, 2.2.0, 2.2.1 (installed and working).

## 0.1.0 — 2026-10-29

First public release.

- `/changelog` with every OpenCode 2 release, newest first; the installed version is marked. Notes missing from `dev`
  are taken from the newest release tag or its GitHub Release, never invented.
- Highlights / For me / All views; translation into any language through any model OpenCode can reach; free-only
  mode without a paid fallback.
- Cached notes and translations; switching language, view or version cancels the request in flight.
- Opens once by itself after an OpenCode update.
- Loading and transition animations as swappable files in `src/motion/` (Decode, Split-flap, Dissolve).
- Requires OpenCode 2.1.4 or newer.
