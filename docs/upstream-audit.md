# Upstream audit

What OpenCode behaviour this plugin relies on, why, and against which versions it was checked.

## Verified versions

- OpenCode runtime: 2.1.4 (tag `v2.1.4`, commit `68bc26b7da1990ce10ffecfbc1e09eb13aa5d824`).
  `@opencode/plugin` and `@opencode/client` resolve to 2.1.4 in the lockfile.
- Release-notes behaviour was additionally checked against 2.2.1 sources and releases (2026-10-29).
- OpenTUI: 0.6.8 (`@opentui/core`, `@opentui/solid`).
- Solid: the build uses 1.9.12, the OpenCode host runs 1.9.15. The npm peer of `@opentui/solid` requires 1.9.12;
  the plugin accepts `solid-js >=1.9.12 <2`. Peer checks are not bypassed (`--force`/`--legacy-peer-deps`).
- There is no runtime version guard. Manifest ranges for `@opencode/*` are `latest` and OpenTUI peers are `*`;
  the lockfile pins the verified build. Compatibility is judged by API and source, not by version number.

## Public API used

- `Plugin.define` with a CLI entry (`./tui`); `ui.slot({ append: "app" })` hosts the `/changelog` command and
  `keymap.layer` registers the palette/slash command and the single modal key layer.
- `ui.dialog.show` for the reader, `ui.dialog.set` for size/placement.
  `ui.dialog.select` **replaces** the current dialog, so model/variant pickers close the reader;
  the plugin reopens it on the same version afterwards. Language and view live in settings, translations in cache.
- `storage.store` for plugin-scoped durable state: preferences, translation and selection caches, `source.v2`.
- Theme tokens are `base` / `focused`; there is no `default` token. Optional tokens (e.g. `text.feedback.error`)
  may be missing and must not break rendering.
- `client.generate.text({ prompt, model }, { signal })` is stateless: no session, history, project instructions or
  tools. It uses the host's saved provider connections; the plugin never reads credentials. Only base providers
  are resolvable: models that exist only in project-local config are rejected.
- `client.model.list(undefined, { signal })` returns the default Location inventory (variants come from `ModelInfo`).
  It does not prove that a project-only provider works in global Generate. The catalog is loaded only on demand.
- `renderer.addPostProcessFn` / `removePostProcessFn` for animation (see below).

Docs: https://opencode.ai/v2/docs/build/plugins/, https://opencode.ai/v2/docs/build/plugins/cli,
https://opencode.ai/v2/docs/cli/config

Exact sources (v2.1.4):

- https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/plugin/src/tui/context.ts
- https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/generate.ts
- https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/server/src/handlers/generate.ts

Not available as public API, so not implemented: contributions to the standard Settings, host favorites/recent
models, interception of the built-in `/update`, creating the host's highlights dialogs. Favorites and recent
models are owned by the plugin; the main session model is never changed.

## Release notes source

The built-in `app.highlights` keeps at most five items per release, truncated (title 60, description 300 characters,
trailing PR links stripped). It is not a full changelog, so the plugin builds its own source:

1. `CHANGELOG.md` from `dev` (required): https://raw.githubusercontent.com/anomalyco/opencode/dev/CHANGELOG.md
2. Newest v2 tag via `GET /repos/anomalyco/opencode/git/matching-refs/tags/v2.` (about 16 KB).
3. Versions missing from `dev` come from the tag's `CHANGELOG.md`, otherwise from the GitHub Release body
   (`releases/tags/v<version>`).

Why this chain, as observed on 2026-10-29:

- `dev` lags releases: `v2.2.1` was out while `dev` ended at 2.2.0.
- The tag's `CHANGELOG.md` sometimes lacks its own section (true for `v2.1.4`; `writeChangelog` runs after tagging).
- Not every version has a GitHub Release (none for 2.1.4).
- `releases/latest` points to V1 (`v1.19.5`), the release list is too heavy (30 entries ≈ 2.3 MB), and the site's
  `/changelog.json` is V1. None of them is used.
- The unauthenticated GitHub API is limited to 60 requests/hour. GitHub errors never break notes from `dev`.

Cache (`source.v2`; `source.v1` is ignored): stores the `dev` text, added versions and the newest tag.
A valid cache renders synchronously. TTL is 1 hour and a refresh starts only when the window opens.
If the requested, installed or newest version is absent, a recheck happens at most every 5 minutes.
A cold close aborts the HTTP request; a warm refresh belongs to setup and is aborted on unload.
Absent versions are never invented. The UI states when a different version is shown. Only real version sections
are kept, and the translation cache is keyed by a hash of the text actually received.

Sources:

- https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/script/src/highlights.ts
- https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/tui/src/app.tsx#L723-L745
- https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/script/publish.ts#L105-L118

Modes: Highlights = published highlights plus explicitly marked risks; For me = highlights plus up to five existing
entries chosen by a separate interests prompt (the model returns only validated IDs, never new text); All = the full
published text, not a Git compare. PR counts are unique PRs mentioned in the notes only.

## Free models

The catalog reports zero prices for `opencode/glm-5.3-flash-free` and `opencode/deepseek-v4.1-flash-free`, but the
public stateless Generate endpoint refused them:

- 2.1.4: HTTP 503 "OpenCode's free tier can only be used from within OpenCode."
- 2026-10-27: HTTP 503 `Free usage limit reached` for both; plain `opencode run` with GLM gave the same.

Stateless Generate sends only `x-opencode-session`, whereas session model requests also send `x-opencode-client`,
a User-Agent and other attribution
([model-request.ts](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/session/model-request.ts#L271-L295)).
This is a suspected host/gateway mismatch, not a proven cause; what the quota is tied to is gateway-side and unknown.
The plugin does not forge headers, create helper sessions or fall back to a paid model; the failure is shown above
the original text. Translation quality of free models is unmeasured.

Rules (`src/models.ts`, `src/translation.ts`):

- Choosing an `opencode/*-free` model turns on free-only mode. Before a new request the catalog is re-read:
  `-free` suffix, active, and every non-empty price tier zero. Unknown price is not zero.
- A vanished or now-paid `opencode/*-free` route may be replaced by another free model. An explicitly chosen paid model
  under free-only produces an error, not a substitution.
- Only a model-specific refusal (free tier / free usage limit) rotates, over at most three distinct free candidates.
  Gateway, auth and network errors never rotate. A substitution is saved as the new choice but not added to recent.
- Cached translations and selections need neither the catalog nor the provider.
- Waits are bounded: 3 minutes for translation (with selection), 30 seconds for selection alone.

## Animation

The effect lives in the plugin's own `ScrollBox` viewport using the public renderer post-process hooks; the host
renderable tree is not walked or mutated and no private APIs are imported.

- OpenTUI 0.6.8 does not allow copying a Session source into a plugin-owned buffer through `drawFrameBuffer`, so the
  snapshot is built from public decoded `CapturedSpan`s. Borrowed planes and pooled grapheme/link IDs are not kept
  across frames; link styling survives the snapshot, destinations do not. On completion the effect is removed and
  the normal Markdown render remains.
- Grapheme width is checked with `encodeUnicode`; wide and composed glyphs are never split. Widths are cached per
  glyph because the native lookup cost about 100 ms per frame for a full reader.
- Loading runs only while actually busy. A ready cached/EN result is applied after the old frame snapshot so an
  instant Promise cannot lose the transition. Effect errors never drop the model answer. Idle, close and unload
  remove the post-process and timers; frame callbacks make no network requests.
- Interactive picker labels are not selectable: stale selection after a picker row was destroyed blocked all waiting
  frames (found with real SGR clicks, 2026-10). The engine guards real selection/drag, not the mere presence of a
  Selection.
- Transition (2026-10-25): three intermediate glyphs, fade to background, 300 ms with start spread up to 96 ms;
  no accent bars or flashes. Waiting is a sparse diagonal letter swap.
- This is an approximation in terminal cells, not a pixel copy of the vertical SVG reel with blur at
  https://anoma.ly/notes/opencode-reloaded. Visual parity with it is not claimed.
- Animations are a plugin-level setting: the public CLI context does not expose the host's global animations flag.

## Dependencies and audit note

`npm audit` reports four critical entries coming through the host-mandated OpenTUI/Solid → Seroval chain. The plugin
uses neither Seroval/`fromJSON` nor SSR. This is not a claim of no vulnerabilities; incompatible upgrades or peer
overrides to silence audit were not applied. Babel is pinned to 7.29.7, which includes the fix for a known advisory.

## Minimum OpenCode version

Declared minimum: **OpenCode 2.1.4** — the oldest release verified at runtime. A source review (2026-10-29) of every
public API the plugin calls puts the API floor at **2.1.0**:

- `ui.dialog.select` actions that do not close the dialog: since 2.0.23;
- the theme token set used here (`surface("dialog")`, `action`/`formfield`/`feedback` `base`/`focused`): since 2.0.9;
- `renderer.nativeScene` as the owner of buffers and `SyntaxStyle` (OpenTUI 0.6.6): since 2.1.0;
- everything else (`Plugin.define`, `PluginContextProvider`/`usePlugin`, `ui.slot("app")`, `keymap.layer`,
  `storage.store`, `app.version`, `generate.text`, `model.list`, OpenTUI buffer/span APIs): since 2.0.0.

No used API was removed up to 2.2.1. In 2.2.1 `client.generate.text` became a deprecated alias of
`client.experimental.generate.text`, scheduled for removal in the next minor; the plugin prefers the new path when it
exists and falls back to the old one.

The plugin loader (2.2.1) reads only the manifest `name`/`exports` and the default export `id`/`setup`; it has no
field for a minimum host version. The minimum is therefore documented (README), not enforced: there is no runtime
version guard.
