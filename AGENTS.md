# AGENTS.md

Guidance for contributors and coding agents working on this plugin. User-facing documentation is in
[README.md](README.md); upstream assumptions and the minimum OpenCode version are in
[docs/upstream-audit.md](docs/upstream-audit.md).

## What this is

An external **OpenCode 2 TUI plugin** (CLI entry `./tui`, built to `dist/`). It may use only the public
`@opencode/plugin/tui` API and OpenTUI/Solid. No private host imports, no mutation of the host's renderable tree, no
commands that clash with built-in ones.

## Layout

- `src/tui.tsx` — plugin entry: `/changelog` command in the `app` slot, notes loader.
- `src/changelog-*.ts(x)` — the window, split by feature (dialog, reader, settings, model picker, shared service).
- `src/releases.ts`, `src/translation.ts`, `src/models.ts` — pure logic: release sources, prompts and caches, model
  policy. Keep them free of UI.
- `src/motion/` — **all animation code, one animation per file.** `engine.ts` owns capture, timers and cleanup;
  `kit.ts` defines `LoadingAnimation` / `TransitionAnimation` and shared helpers; `loading-*.ts` and
  `transition-*.ts` are swappable animations registered in `index.ts`. Change or add an animation without touching
  the engine; change the engine without touching animations. Animations are plain objects implementing an interface,
  not classes.

## Commands

```sh
npm ci
npm run check         # tsc
npm run format:check  # Prettier: no semicolons, printWidth 120
npm test              # the single smoke test (Bun)
npm run build         # dist/, written atomically (a running TUI hot-reloads it)
```

## Rules

- **Never load OpenCode in the background.** No polling, no network requests from timers, render or animation
  frames. Notes are fetched only when the window opens (1 h cache, missing versions rechecked at most every 5 min).
- **Cancel what you start.** Every model request carries the window's `AbortSignal`; switching language, view or
  version aborts the request in flight and sends exactly one new one. Late answers are not cached.
- **Cache before spending.** A cached translation or selection must work without the model catalog or network.
- **Money:** never substitute a paid model silently. Free-only rotation is limited to confirmed `$0` models and to
  model-specific failures (not rate limits, auth or network errors).
- **Durable state holds explicit choices only.** Defaults (prompts, language list) must stay upgradable; corrupt
  fields fall back individually.
- **Theme tokens** are `base` / `focused` (there is no `default`); clickable text uses `action`, inputs `formfield`,
  `feedback` only for errors and warnings. Optional tokens may be missing — never let that crash a frame.
- **UI language is English.** OpenCode's TUI has no localisation API; release notes are translated, the interface is
  not.
- **No version guard.** The minimum OpenCode version is documented, not enforced.
- Start every source file with a one-line purpose comment; comment non-obvious decisions and their limits. Comments
  are in English.

## Design principles

- The reader stays visible under the version, language and view dropdowns.
- A real wait (loading animation) and the arrival of text (transition) look different; cached text is never delayed
  artificially.
- Motion stays inside the reader's own viewport and is judged by eye in a real OpenCode TUI, not only by frame
  counters. Reference: <https://anoma.ly/notes/opencode-reloaded/> (terminal cells, not a pixel copy).
- Controls are compact; technical details live in Settings and Source.
- Keyboard and mouse both work, animations can be turned off, colours come from the host theme, and an error never
  hides or alters the original text.

## Tests

There is **one** integration smoke test, `test/smoke.tsx`: it packs and installs the plugin, then checks release
parsing and source merging, caches, cancellation, the free-model policy, the real OpenTUI renderer and the animation
engine — offline, with fake providers and no credentials. Do not grow it into a unit-test matrix. Add an assertion
only for a concrete regression you are fixing. Visual changes are additionally checked by hand in a real TUI.

## Contributing flow

1. Open an issue first for new features; bug fixes may go straight to a PR.
2. Keep PRs small and focused; use Conventional Commits (`fix:`, `feat:`, `refactor:`, `docs:`).
3. Run check, format and test; describe how you verified the change (for visuals: terminal, OpenCode version,
   a screenshot or GIF).
4. When an upstream assumption changes, update `docs/upstream-audit.md` with the version you checked.
5. Releases: bump `version` in `package.json` (semver; the README badge too), add a section to `CHANGELOG.md`, tag
   `vX.Y.Z` and publish a GitHub Release with that section. The package is not published to npm.
