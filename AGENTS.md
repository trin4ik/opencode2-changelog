# AGENTS.md

Guidance for contributors and coding agents working on this plugin. User-facing documentation is in
[README.md](README.md); upstream assumptions and the minimum OpenCode version are in
[docs/upstream-audit.md](docs/upstream-audit.md).

## What this is

An external **OpenCode 2 TUI plugin** (CLI entry `./tui`, built to `dist/`). It may use only the public
`@opencode/plugin/tui` API and OpenTUI/Solid. No private host imports, no mutation of the host's renderable tree, no
commands that clash with built-in ones.

## Layout

- `scripts/install.mjs` — the installer (Node built-ins only): OpenCode version check, build, `cli.json` registration.
  Keep the README "For coding agents" steps in sync with it.
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
npm test              # fast offline check of the sources (Bun), a few seconds — during development
npm run test:install  # Docker install test on the minimum and newest OpenCode — before a release
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

## Code style

New and changed code follows the style of OpenCode 2 itself and its official plugins, taken from the newest stable
`v2.x.y` tag of [anomalyco/opencode](https://github.com/anomalyco/opencode), not from memory:

- the "Style Guide" in the root `AGENTS.md` (const over let, early returns, no unneeded destructuring, aliases or
  star imports, few `try`/`catch`, no `any`, inference over annotations, no single-use helpers);
- `packages/plugin/AGENTS.md` and `packages/tui/AGENTS.md`;
- official plugin code as examples: `packages/tui/src/feature-plugins/`, `packages/plugins/`,
  `packages/plugin-browser/`.

Where those rules conflict with the rules above (purpose comments, Node built-ins in the installer, Prettier settings),
the rules of this file win. Existing code is aligned when it is touched, not in a separate rewrite.

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

Two tests, no unit-test matrix:

- `npm test` (`test/smoke.tsx`) — run during development. It imports the sources directly and checks release parsing
  and source merging, caches, cancellation, the free-model policy, the real OpenTUI renderer and the animation engine,
  offline, with fake providers and no credentials. It must stay a few seconds: no packing, installing or network, and
  a held fake request must settle on abort (a dangling one kept the 3-minute translation timeout alive). Add an
  assertion only for a concrete regression you are fixing.
- `npm run test:install` (`test/install.mjs`) — run before a release, on the committed HEAD. For the minimum and the
  newest OpenCode 2 from npm, a clean Docker container clones the repository, runs `scripts/install.mjs` as the README
  says and opens `/changelog` in the real TUI. Needs Docker and network.

Visual changes are additionally checked by hand in a real TUI.

## Contributing flow

1. Open an issue first for new features; bug fixes may go straight to a PR.
2. Keep PRs small and focused; use Conventional Commits (`fix:`, `feat:`, `refactor:`, `docs:`).
3. Run check, format and `npm test`; describe how you verified the change (for visuals: terminal, OpenCode version,
   a screenshot or GIF).
4. When an upstream assumption changes, update `docs/upstream-audit.md` with the version you checked.
5. Before every release, run two reviewer subagents in parallel with the brief in
   [docs/review-prompt.md](docs/review-prompt.md) over the diff since the previous release tag: `openai/gpt-6.1-sol-fast#high`
   and `anthropic/claude-opus-5-5#high`. Never a weaker model. Fix or consciously reject each finding.
6. Commit, then run `npm run test:install`.
7. Releases: bump `version` in `package.json` (semver; the README badge too), add a section to `CHANGELOG.md`, tag
   `vX.Y.Z` and publish a GitHub Release with that section. The package is not published to npm.
