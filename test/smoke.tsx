// One offline integration smoke: inspect the packed V2 entry, parsing/loading, translation cache, and real TUI renderer.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { rmSync } from "node:fs"
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { testRender, useRenderer } from "@opentui/solid"
import { createSignal } from "solid-js"
import { RGBA, type BoxRenderable } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import type { Release } from "../src/releases"
import { SOURCE_URL } from "../src/releases"
import type { TranslationCache, TranslationSettings } from "../src/translation"

// Animation timers may request a native render while a frame is captured; retry that race instead of flaking.
function capture(view: { captureCharFrame(): string }): string {
  for (let attempt = 0; ; attempt++) {
    try {
      return view.captureCharFrame()
    } catch (error) {
      if (attempt >= 50 || !String(error).includes("OutputBusy")) throw error
      Bun.sleepSync(2)
    }
  }
}

const root = fileURLToPath(new URL("..", import.meta.url))
const temp = await mkdtemp(`${tmpdir()}/changelog-smoke-`)
const pack = JSON.parse(
  execFileSync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: root, encoding: "utf8" }),
)[0]
assert.ok(
  pack.files.some((file: { path: string }) => file.path === "dist/tui.js"),
  "compiled plugin is packed",
)
const installed = `${temp}/installed`
await mkdir(installed)
// Test the locked host stack, not npm's inconsistent "latest" tags (Core 0.5 vs Solid 0.6).
// These consumer-only overrides satisfy the real peers; the plugin manifest remains latest / *.
const overrides = Object.fromEntries(
  await Promise.all(
    ["@opencode/plugin", "@opentui/core", "@opentui/solid", "solid-js"].map(async (name) => [
      name,
      JSON.parse(await readFile(`${root}/node_modules/${name}/package.json`, "utf8")).version,
    ]),
  ),
)
await writeFile(`${installed}/package.json`, JSON.stringify({ private: true, type: "module", overrides }))
execFileSync(
  "npm",
  [
    "install",
    "--prefix",
    installed,
    "--ignore-scripts",
    "--omit=peer",
    "--no-audit",
    "--no-fund",
    `${temp}/${pack.filename}`,
  ],
  { stdio: "pipe" },
)
for (const name of ["solid-js", "@opentui"])
  await symlink(`${root}/node_modules/${name}`, `${installed}/node_modules/${name}`)
const dist = `${installed}/node_modules/opencode2-changelog/dist`
assert.equal(
  typeof (await import(pathToFileURL(`${dist}/tui.js`).href)).default.setup,
  "function",
  "installed entry is V2 setup plugin",
)
const releases = (await import(pathToFileURL(`${dist}/releases.js`).href)) as typeof import("../src/releases")
const translations = (await import(pathToFileURL(`${dist}/translation.js`).href)) as typeof import("../src/translation")
const { ChangelogDialog } = await import(pathToFileURL(`${dist}/changelog-dialog.js`).href)
// The dialog reads the context through the installed copy of the plugin SDK, so the provider must come from it too.
const { PluginContextProvider } = (await import(
  pathToFileURL(`${installed}/node_modules/@opencode/plugin/dist/tui/index.js`).href
)) as typeof import("@opencode/plugin/tui")
const { createBodyMotion } = (await import(
  pathToFileURL(`${dist}/motion/engine.js`).href
)) as typeof import("../src/motion/engine")
const animations = (await import(pathToFileURL(`${dist}/motion/index.js`).href)) as typeof import("../src/motion")
const modelPolicy = (await import(pathToFileURL(`${dist}/models.js`).href)) as typeof import("../src/models")

const source = `# Changelog
## 1.9.0 — 2026-01-01
old
## 2.1.4 — 2026-10-01
### Highlights
Fast feature.
### Changes
Full entry [#4](https://github.com/anomalyco/opencode/pull/4) [duplicate](https://github.com/anomalyco/opencode/pull/4) and [#5](https://github.com/anomalyco/opencode/pull/5).
## 2.1.2 — 2026-09-01
Previous entry.
`
const parsed = releases.parseChangelog(source)
assert.deepEqual(
  parsed.map((item) => item.version),
  ["2.1.4", "2.1.2"],
  "do not invent missing versions",
)
assert.match(parsed[0]!.highlights, /Fast feature/)
assert.match(parsed[0]!.markdown, /Full entry/)
assert.deepEqual(parsed[0]!.prs, [4, 5])
assert.equal(parsed[0]!.hash, releases.parseChangelog(source)[0]!.hash)
assert.notEqual(parsed[0]!.hash, parsed[1]!.hash)

const structured = releases.parseChangelog(
  [
    "# Changelog",
    "## 2.1.4 — 2026-10-23",
    "### Highlights",
    "- Main announcement.",
    "### Extensions",
    "#### Bug fixes",
    "- MCP request no longer hangs.",
    "  - Nested detail stays with its parent.",
    "  ```diff",
    "  ### Not a section",
    "  - Not a separate entry",
    "  ```",
    "- Unrelated rendering fix.",
    "### Breaking changes",
    "A breaking protocol change.",
    "",
    "| Before | After |",
    "| --- | --- |",
    "| a | b |",
  ].join("\n"),
)[0]!
const items = releases.releaseItems(structured)
const main = releases.mainItems(items)
const candidates = releases.candidateItems(items)
assert.equal(candidates.length, 2, "nested lists and fenced content are not invented as separate news")
assert.match(candidates[0]!.markdown, /Nested detail/)
assert.match(candidates[0]!.markdown, /Not a section/)
assert.ok(main.some((item) => item.highlight))
assert.ok(main.some((item) => item.mandatory && item.sectionPath[0] === "Breaking changes"))
assert.throws(() => releases.renderItems(items, ["invented"]), /Unknown release item/)
const ordered = releases.renderItems(items, candidates.map((item) => item.id).reverse())
assert.ok(ordered.indexOf("MCP request") < ordered.indexOf("Unrelated"), "selection keeps source order")
assert.throws(
  () => releases.releaseItems({ ...structured, markdown: "### Core\n```diff\n- unfinished" }),
  /unclosed fenced/,
)

// Exercise bounded response, HTTP failure, and abort through a local fake fetch only.
const oldFetch = globalThis.fetch
try {
  // dev lags behind the newest tag; the tag's changelog lacks its own section; its GitHub Release has it.
  const requested: string[] = []
  let tags = ["v2.1.2", "v2.1.4", "v2.1.5", "v2.10.0", "v2.10.0-beta.1"]
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    requested.push(href)
    assert.ok(init?.signal)
    if (href === SOURCE_URL) return new Response(source, { status: 200 })
    if (href.endsWith("/git/matching-refs/tags/v2."))
      return Response.json(tags.map((tag) => ({ ref: `refs/tags/${tag}` })))
    if (href.endsWith("/v2.10.0/CHANGELOG.md"))
      return new Response(`# Changelog\n## v2.1.5 — 2026-10-02\nTagged only.\n${source.slice(12)}`)
    if (href.endsWith("/releases/tags/v2.10.0"))
      return Response.json({
        tag_name: "v2.10.0",
        draft: false,
        prerelease: false,
        published_at: "2026-10-29T05:16:55Z",
        html_url: "https://github.com/anomalyco/opencode/releases/tag/v2.10.0",
        body: "### Highlights\r\n- Newest release.",
      })
    return new Response("missing", { status: 404, statusText: "Not Found" })
  }) as unknown as typeof fetch
  const merged = await releases.loadChangelog()
  assert.equal(merged.latest, "2.10.0", "numeric, not lexicographic, newest plain release tag")
  assert.deepEqual(
    merged.releases.map((item) => [item.version, item.date]),
    [
      ["2.10.0", "2026-10-29"],
      ["2.1.5", "2026-10-02"],
      ["2.1.4", "2026-10-01"],
      ["2.1.2", "2026-09-01"],
    ],
    "versions missing from dev come from the tag changelog, then from the published release",
  )
  assert.equal(merged.releases[0]!.markdown, "### Highlights\n- Newest release.")
  assert.match(merged.releases[0]!.url, /releases\/tag\/v2\.10\.0$/)
  assert.deepEqual(
    releases.buildReleases(merged).map((item) => item.hash),
    merged.releases.map((item) => item.hash),
    "cached source rebuilds the same releases",
  )
  tags = ["v2.1.4"]
  requested.length = 0
  assert.equal((await releases.loadReleases()).length, 2)
  assert.equal(requested.length, 2, "an up-to-date dev changelog needs only the tag lookup")
  globalThis.fetch = (async (url: string | URL | Request) =>
    String(url) === SOURCE_URL
      ? new Response(source)
      : new Response("rate limited", { status: 403, statusText: "Forbidden" })) as unknown as typeof fetch
  const offline = await releases.loadChangelog()
  assert.equal(offline.latest, undefined, "a GitHub API failure leaves the newest tag unknown")
  assert.equal(offline.releases.length, 2, "and does not break the dev notes")
  globalThis.fetch = (async () =>
    new Response("denied", { status: 403, statusText: "Forbidden" })) as unknown as typeof fetch
  await assert.rejects(releases.loadReleases(), /HTTP 403 Forbidden/)
  const controller = new AbortController()
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
    )) as unknown as typeof fetch
  const pending = releases.loadReleases(controller.signal)
  controller.abort(new Error("cancelled"))
  await assert.rejects(pending, /cancelled/)
} finally {
  globalThis.fetch = oldFetch
}

const notes = parsed[0]!.markdown.padEnd(120, " ")
const settings = (overrides = {}) =>
  translations.readSettings({
    language: "ru",
    prompt: "Translate {language}",
    model: { providerID: "local", id: "fixture", variant: "safe" },
    detail: "full",
    animations: false,
    ...overrides,
  })
let cache: TranslationCache = { entries: {} }
let calls = 0
let saved = 0
let behavior: (signal: AbortSignal) => Promise<string> = async () => `Перевод ${"слово ".repeat(25)}`
const client = {
  generate: {
    text: async (request: any, options: { signal: AbortSignal }) => {
      calls++
      assert.match(request.prompt, /BEGIN RELEASE_NOTES_/)
      assert.match(request.prompt, /Requested output language: /)
      assert.doesNotMatch(request.prompt, /Complete fidelity:|You are a release-note translator/)
      assert.ok(request.model.variant, "variant is passed through to provider")
      return { text: await behavior(options.signal) }
    },
  },
}
const translator = translations.createTranslator(
  client as any,
  () => cache,
  async (mutate) => {
    mutate(cache)
    saved++
  },
)
const controller = () => new AbortController()
const translated = (await translator.translate(notes, settings(), controller().signal)).text
assert.equal((await translator.translate(notes, settings(), controller().signal)).text, translated)
assert.equal(calls, 1, "cache hit reuses provider result")
assert.equal(
  (await translator.translate(notes, settings({ freeOnly: true }), controller().signal)).text,
  translated,
  "a cached translation needs neither free-model inventory nor a working gateway",
)
for (const changed of [
  settings({ language: "fr" }),
  settings({ model: { providerID: "local", id: "fixture", variant: "other" } }),
  settings({ prompt: "Other {language}" }),
]) {
  await translator.translate(notes, changed, controller().signal)
}
assert.equal(calls, 4, "language/model variant/prompt invalidate cache")
await translator.translate(notes, settings({ detail: "personal", interests: "MCP" }), controller().signal)
assert.equal(calls, 4, "view/interests do not invalidate the translation of the same exact text")
assert.equal(
  (await translator.translate(notes, settings({ language: "en" }), controller().signal)).text,
  notes,
  "English full bypasses generation",
)
await translator.translate(notes, settings({ language: "en", detail: "personal" }), controller().signal)
assert.equal(calls, 4, "English bypasses translation, not the separate personal selection")
const beforeMalformed = calls
cache = { entries: { invalid: { text: "bad", at: 1 } } as any }
await translator.translate(notes, settings(), controller().signal)
assert.equal(calls, beforeMalformed + 1, "malformed persisted cache is ignored")
const beforeFailure = saved
behavior = async () => ""
await assert.rejects(translator.translate(notes, settings({ language: "de" }), controller().signal), /empty, truncated/)
assert.equal(saved, beforeFailure, "failed generation is not cached")
let finishLate!: (value: string) => void
// Simulate a provider that ignores cancellation: a late success must still not enter cache or reach the UI.
behavior = () =>
  new Promise((resolve) => {
    finishLate = resolve
  })
const abort = controller()
const late = translator.translate(notes, settings({ language: "it" }), abort.signal)
abort.abort(new Error("cancelled"))
finishLate(`Tradotto ${"parola ".repeat(25)}`)
await assert.rejects(late)
assert.equal(saved, beforeFailure, "cancelled late success is not persisted")

let selectionCalls = 0
let selectionReply = JSON.stringify({ ids: [candidates[0]!.id] })
let selectionCache: import("../src/translation").SelectionCache = { entries: {} }
const selector = translations.createTranslator(
  {
    generate: {
      text: async () => {
        selectionCalls++
        return { text: selectionReply }
      },
    },
  } as any,
  () => ({ entries: {} }),
  async () => {},
  {
    read: () => selectionCache,
    save: async (mutate) => mutate(selectionCache),
  },
)
const interested = settings({ detail: "personal", interests: "MCP, зависшие запросы" })
let combinedCalls = 0
let combinedReply = JSON.stringify({
  ids: [candidates[0]!.id],
  text: "Главное и выбранное изменение MCP переведены полностью.",
})
const combinedCache: import("../src/translation").TranslationCache = { entries: {} }
const combined = translations.createTranslator(
  {
    generate: {
      text: async () => {
        combinedCalls++
        return { text: combinedReply }
      },
    },
  } as any,
  () => combinedCache,
  async (mutate) => mutate(combinedCache),
)
assert.deepEqual((await combined.personal(structured, interested, controller().signal)).ids, [candidates[0]!.id])
await combined.personal(structured, interested, controller().signal)
assert.equal(combinedCalls, 1, "personal selection and translation are one generation and are cached together")
combinedReply = JSON.stringify({ ids: ["invented"], text: "Неизвестный пункт не должен быть принят." })
await assert.rejects(
  combined.personal(structured, { ...interested, interests: "different" }, controller().signal),
  /invalid IDs/,
)
combinedReply =
  JSON.stringify({ ids: [candidates[0]!.id], text: "Главное и выбранное изменение MCP переведены полностью." }) + "}"
assert.deepEqual(
  (await combined.personal(structured, { ...interested, interests: "extra brace" }, controller().signal)).ids,
  [candidates[0]!.id],
  "one redundant closing brace is accepted only after validating the response",
)
assert.deepEqual((await selector.select(structured, interested, controller().signal)).ids, [candidates[0]!.id])
await selector.select(
  structured,
  { ...interested, language: "en", prompt: "Changed translation style" },
  controller().signal,
)
assert.equal(selectionCalls, 1, "selection cache is independent of language and translation prompt")
assert.deepEqual(
  (await selector.select(structured, { ...interested, freeOnly: true }, controller().signal)).ids,
  [candidates[0]!.id],
  "cached selection does not fetch the model inventory",
)
await selector.select(
  structured,
  { ...interested, selectionPrompt: "Return matching candidate IDs as JSON." },
  controller().signal,
)
assert.equal(selectionCalls, 2, "changing the selection prompt invalidates its cache")
await selector.select(structured, { ...interested, interests: "" }, controller().signal)
assert.equal(selectionCalls, 2, "empty interests do not invoke a model")
selectionReply = JSON.stringify({ ids: [] })
const noMatch = { ...interested, language: "en", interests: "Unrelated topic" }
assert.deepEqual((await selector.select(structured, noMatch, controller().signal)).ids, [])
assert.equal(selectionCalls, 3, "English still invokes semantic personal selection")
await selector.select(structured, noMatch, controller().signal)
assert.equal(selectionCalls, 3, "a successful empty match is cached")
selectionReply = JSON.stringify({ ids: ["invented"] })
const failedSelection = { ...interested, interests: "Different interests" }
await assert.rejects(selector.select(structured, failedSelection, controller().signal), /existing candidate IDs/)
await assert.rejects(selector.select(structured, failedSelection, controller().signal), /existing candidate IDs/)
assert.equal(selectionCalls, 5, "invented IDs are rejected and failed selection is not cached")
assert.equal(translations.readSettings({ detail: "medium" }).detail, "personal", "old middle view migrates")
assert.deepEqual(translations.readSettings({}).model, { providerID: "opencode", id: "glm-5.3-flash-free" })
assert.equal(translations.readSettings({}).freeOnly, true, "the default never falls back to a paid model")
assert.deepEqual(translations.readSettings({ languages: ["en", "zh-hans"] }).languages, ["en", "zh-Hans"])
assert.throws(() => translations.readSettings({ languages: ["en", "EN"] }), /distinct valid/)
assert.throws(() => translations.readSettings({ languages: [] }), /1 to 30/)

// Free rotation is a billing boundary: stale prices and unknown pricing cannot enter the pool.
const freeModel = (id: string, cost = 0) => ({
  providerID: "opencode",
  id,
  enabled: true,
  status: "active",
  capabilities: { output: ["text"] },
  variants: [{ id: "low", name: "Low" }],
  cost: [{ input: cost, output: cost, cache: { read: 0, write: 0 } }],
})
let inventory = [freeModel("a-free"), freeModel("b-free"), freeModel("paid-free", 1)]
assert.equal(modelPolicy.isFree({ ...freeModel("unknown-free"), cost: [] } as any), false)
const attempts: string[] = []
let freeFailure = "Model a-free no longer available"
const freeTranslator = translations.createTranslator(
  {
    model: { list: async () => ({ data: inventory }) },
    generate: {
      text: async (request: any) => {
        attempts.push(request.model.id)
        if (request.model.id === "a-free") throw new Error(freeFailure)
        return { text: translated }
      },
    },
  } as any,
  () => ({ entries: {} }),
  async () => {},
)
const freeSettings = settings({ model: { providerID: "opencode", id: "a-free", variant: "low" }, freeOnly: true })
const freeTranslation = await freeTranslator.translate(notes, freeSettings, controller().signal)
assert.deepEqual(attempts, ["a-free", "b-free"], "expired free model rotates only to another confirmed-free model")
assert.equal(freeTranslation.model?.id, "b-free")
inventory = [freeModel("a-free", 1), freeModel("b-free")]
attempts.length = 0
await freeTranslator.translate(notes, freeSettings, controller().signal)
assert.deepEqual(attempts, ["b-free"], "a formerly free but now priced model is never called")
inventory = [freeModel("a-free"), freeModel("b-free")]
attempts.length = 0
freeFailure = "OpenCode's free tier can only be used from within OpenCode"
await assert.rejects(freeTranslator.translate(notes, freeSettings, controller().signal), /free tier/)
assert.deepEqual(attempts, ["a-free"], "a systemic free gateway refusal must not fan out into more requests")
assert.equal(
  modelPolicy.canRotateFree(new Error("Free usage limit reached. Free models work in OpenCode")),
  false,
  "a shared free-gateway limit does not trigger a slow model carousel",
)
assert.equal(modelPolicy.canRotateFree(new Error("Free usage limit reached")), false)

// Lightweight host context: production renderer and Solid components remain real.
const color = "#dddddd"
const rgba = RGBA.fromHex(color)
const token = new Proxy(
  {},
  {
    get: (_target, key) =>
      ["base", "muted", "default", "focused", "high", "faint", "selected"].includes(String(key)) ? rgba : token,
  },
)
const theme = new Proxy({}, { get: (_target, key) => (key === "surface" ? () => token : token) }) as any
const noop = () => {}
// ui.dialog.select is mocked: each call takes the next scripted answer; "favorite" fires the first action and
// stays open until the plugin closes it, like the host dialog does.
const selects: any[] = []
const script: string[] = ["favorite", "opencode/pick-free", "low"]
let closeSelect: (() => void) | undefined
const toggled: string[] = []
const favoriteModels: Array<{ providerID: string; id: string }> = []
const reopened: Array<string | undefined> = []
const context: any = {
  theme,
  renderer: undefined,
  client: { model: { list: async () => ({ data: [{ ...freeModel("pick-free"), name: "Free preview" }] }) } },
  ui: {
    dialog: {
      set: noop,
      clear: () => closeSelect?.(),
      select: (options: any) => {
        selects.push(options)
        const step = script.shift()
        return new Promise((resolve) => {
          if (step !== "favorite") return resolve(step)
          closeSelect = () => resolve(undefined)
          options.actions[0].onTrigger(
            options.options.find((option: any) => option.value === "opencode/pick-free").value,
          )
        })
      },
    },
    toast: { show: noop },
  },
  keymap: { layer: () => noop },
} as unknown as Plugin.Context
let uiCalls = 0
let uiSelections = 0
let uiSuccess = false
let finishFull: ((value: { text: string }) => void) | undefined
let holdFull = false
let heldSignal: AbortSignal | undefined
let holdRequest = false
let heldRequests = 0
const renderedProvider = {
  generate: {
    text: async (request: { prompt: string }, options: { signal: AbortSignal }) => {
      if (holdRequest) {
        heldRequests++
        if (!heldSignal) heldSignal = options.signal
        return await new Promise<{ text: string }>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
        })
      }
      if (request.prompt.includes("Select additional release-note items")) {
        uiSelections++
        const extra = releases.candidateItems(releases.releaseItems(parsed[0]!))[0]!
        if (request.prompt.includes('"text" (translated Markdown string)')) {
          uiCalls++
          return {
            text: JSON.stringify({
              ids: [extra.id],
              text: "Русский текст переведён и содержит выбранный пункт Full entry и основные изменения.",
            }),
          }
        }
        return { text: JSON.stringify({ ids: [extra.id] }) }
      }
      uiCalls++
      if (holdFull && request.prompt.includes("FULL RELEASE MARKER"))
        return await new Promise<{ text: string }>((resolve) => (finishFull = resolve))
      if (uiSuccess)
        return {
          text: request.prompt.includes("Requested output language: fr.")
            ? "Le texte français est traduit et conserve toutes les informations de cette mise à jour."
            : "Русский текст переведён и сохраняет все сведения об изменениях этой версии приложения.",
        }
      throw new Error("HTTP 403 Forbidden from fixture")
    },
  },
}
const uiTranslator = translations.createTranslator(
  renderedProvider as any,
  () => ({ entries: {} }),
  async () => {},
)
const release: Release = { ...parsed[0]!, markdown: notes, highlights: parsed[0]!.highlights }
const [uiRelease, setUiRelease] = createSignal(release)
const [uiSettings, setUiSettings] = createSignal(settings())
const [uiLatest, setUiLatest] = createSignal<string>()
const service = {
  installed: "2.1.4",
  settings: uiSettings,
  translator: uiTranslator,
  updateSettings: async (patch: Partial<TranslationSettings>) => {
    setUiSettings(translations.readSettings({ ...uiSettings(), ...patch }))
  },
  rememberModel: async () => {},
  recent: () => [],
  favorites: () => favoriteModels,
  toggleFavorite: async (model: { providerID: string; id: string }) => {
    toggled.push(`${model.providerID}/${model.id}`)
    favoriteModels.push(model)
  },
  clearCaches: async () => {},
  open: (version?: string) => reopened.push(version),
} as any
const view = await testRender(
  () => {
    context.renderer = useRenderer()
    return (
      <PluginContextProvider value={context}>
        <ChangelogDialog service={service} releases={[uiRelease()]} latest={uiLatest()} />
      </PluginContextProvider>
    )
  },
  { width: 100, height: 40 },
)
try {
  const frame = () => capture(view)
  for (let i = 0; i < 150 && (!frame().includes("Translation failed") || !frame().includes("Fast feature")); i++) {
    await view.renderOnce()
    await Bun.sleep(20)
  }
  assert.match(frame(), /What's new · 2\.1\.4/)
  assert.match(frame(), /Model fixture ▾/, "the model selector is a primary reader control")
  assert.match(frame(), /Fast feature/, "the readable original remains rendered after a translation error")
  assert.match(frame(), /retry/)
  assert.match(frame(), /Showing the original/, "a failed translation cannot masquerade as the selected language")
  setUiRelease({ ...release, version: "2.2.0", hash: "refreshed-source" })
  await view.renderOnce()
  assert.match(frame(), /What's new · 2\.2\.0/, "refresh replaces the default latest release")
  setUiLatest("2.2.1")
  await view.renderOnce()
  assert.match(
    frame(),
    /Notes for 2\.2\.1 are not published yet — showing 2\.2\.0/,
    "a newer tag without notes is never silently replaced by an older release",
  )
  setUiLatest(undefined)
  setUiRelease(release)
  await view.renderOnce()
  assert.doesNotMatch(frame(), /not published yet/)
  const reader = view.renderer.root.findDescendantById("changelog-reader")
  assert.ok(reader)
  const clickText = async (text: string) => {
    const lines = frame().split("\n")
    const y = lines.findIndex((line) => line.includes(text))
    assert.ok(y >= 0, `visible mouse target: ${text}\n${frame()}`)
    await view.mockMouse.click(lines[y]!.indexOf(text) + 1, y)
    await view.renderOnce()
  }
  await clickText("Русский ▾")
  assert.equal(
    view.renderer.root.findDescendantById("changelog-reader"),
    reader,
    "language dropdown keeps the old reader mounted",
  )
  assert.match(frame(), /Fast feature/, "the old notes remain visible beside the language popup")
  await clickText("Русский · ru")
  await clickText("Version 2.1.4 ▾")
  assert.equal(
    view.renderer.root.findDescendantById("changelog-reader"),
    reader,
    "version dropdown keeps the old reader mounted",
  )
  assert.match(frame(), /2026-10-01 · installed/, "versions are visibly selectable, the installed one marked")
  await clickText("2.1.4 · 2026-10-01")
  const count = uiCalls
  await Bun.sleep(150)
  assert.equal(uiCalls, count, "display does not issue idle generation requests")
  setUiSettings({ ...uiSettings(), interests: "MCP" })
  await Bun.sleep(80)
  await view.renderOnce()
  assert.equal(uiCalls, count, "editing interests in All does not restart even a failed translation")
  assert.equal(uiSelections, 0, "All never invokes selection")
  setUiSettings({ ...uiSettings(), detail: "personal", language: "en" })
  for (let i = 0; i < 150 && !frame().includes("Full entry"); i++) {
    await view.renderOnce()
    await Bun.sleep(20)
  }
  assert.match(frame(), /Full entry/, "personal view retains real selected entries")
  assert.equal(uiSelections, 1, "personal selection runs once in English")
  assert.equal(uiCalls, count, "English personal output is not translated")
  setUiSettings({ ...uiSettings(), language: "ru" })
  for (let i = 0; i < 60 && uiCalls === count; i++) {
    await view.renderOnce()
    await Bun.sleep(20)
  }
  assert.equal(uiCalls, count + 1, "changing language generates one translation")
  assert.equal(uiSelections, 2, "changing language selects and translates in one request")
  setUiSettings({ ...uiSettings(), detail: "full" })
  await Bun.sleep(80)
  await view.renderOnce()
  assert.equal(uiCalls, count + 2, "leaving personal mode starts only one full translation")
  setUiSettings({ ...uiSettings(), detail: "full", language: "en" })
  setUiRelease({ ...release, markdown: "### Core\n```diff\n- unfinished", hash: "unsupported-selector-grammar" })
  for (let i = 0; i < 150 && !frame().includes("unfinished"); i++) {
    await view.renderOnce()
    await Bun.sleep(20)
  }
  assert.match(frame(), /unfinished/, "All remains usable when personal item parsing cannot handle the source")
  assert.doesNotMatch(frame(), /Showing the full original/, "All does not run the personal parser")
  uiSuccess = true
  setUiSettings({ ...uiSettings(), language: "ru" })
  for (let i = 0; i < 100 && !frame().includes("Русский текст переведён"); i++) {
    await view.renderOnce()
    await Bun.sleep(20)
  }
  assert.match(frame(), /Русский текст переведён/)
  setUiSettings({ ...uiSettings(), language: "fr" })
  for (let i = 0; i < 100 && !frame().includes("Le texte français"); i++) {
    await view.renderOnce()
    await Bun.sleep(20)
  }
  assert.match(frame(), /Le texte français/, "changing language replaces the reader with the successful translation")
  setUiSettings({ ...uiSettings(), language: "en" })
  await view.renderOnce()
  await clickText("Model fixture ▾")
  for (let i = 0; i < 50 && (selects.length < 3 || !reopened.length); i++) {
    await Bun.sleep(20)
    await view.renderOnce()
  }
  assert.equal(selects.length, 3, "model list, model list again after toggling a favorite, then the variant list")
  assert.deepEqual(toggled, ["opencode/pick-free"], "the favorite action receives the focused model")
  assert.deepEqual(
    selects[0].options.map((option: any) => [option.title, option.category, option.footer]),
    [["Free preview", "Free", "Free"]],
  )
  assert.equal(selects[1].current, "opencode/pick-free", "the list is shown again with the toggled model focused")
  assert.equal(selects[1].options[0].category, "Favorites", "the favorite moves to its own category")
  assert.match(selects[2].title, /Select variant/)
  assert.equal(selects[2].current, "low", "a free model starts on its low variant")
  assert.deepEqual(reopened, ["2.1.4"], "the changelog window is reopened on the same version")
  await view.renderOnce()
  assert.match(frame(), /Model pick-free ▾/, "model and variant selection only changes changelog settings")
  setUiRelease({
    ...release,
    markdown: "### Highlights\n- Highlight item.\n\n### Changes\n- FULL RELEASE MARKER.",
    hash: "delayed-full",
  })
  setUiSettings({ ...settings(), detail: "important", language: "ru", animations: false })
  for (let i = 0; i < 100 && !frame().includes("Русский текст переведён"); i++) {
    await view.renderOnce()
    await Bun.sleep(20)
  }
  assert.match(frame(), /Русский текст переведён/)
  holdFull = true
  setUiSettings({ ...uiSettings(), detail: "full" })
  for (let i = 0; i < 50 && !finishFull; i++) {
    await view.renderOnce()
    await Bun.sleep(20)
  }
  assert.ok(finishFull, "full release starts its own translation")
  await view.renderOnce()
  assert.match(frame(), /Русский текст переведён/, "the previous translation stays visible while All loads")
  assert.doesNotMatch(frame(), /FULL RELEASE MARKER/, "the untranslated full text does not flash during loading")
  finishFull!({ text: "Полный перевод содержит все изменения этого выпуска и дополнительные исправления." })
  for (let i = 0; i < 100 && !frame().includes("Полный перевод содержит"); i++) {
    await view.renderOnce()
    await Bun.sleep(20)
  }
  assert.match(frame(), /Полный перевод содержит/, "All displays the completed full translation")
  holdRequest = true
  setUiSettings({ ...uiSettings(), language: "de" })
  for (let i = 0; i < 50 && !heldSignal; i++) {
    await view.renderOnce()
    await Bun.sleep(20)
  }
  assert.ok(heldSignal, "language change starts a held provider request")
  setUiSettings({ ...uiSettings(), detail: "personal", interests: "MCP" })
  for (let i = 0; i < 50 && heldRequests < 2; i++) {
    await view.renderOnce()
    await Bun.sleep(20)
  }
  await Bun.sleep(80)
  assert.equal(heldSignal.aborted, true, "view change aborts the actual previous generate.text signal")
  assert.equal(heldRequests, 2, "view change sends exactly one request for the new personal state")
} finally {
  view.renderer.destroy()
}

// The effect operates on the real native buffer, never on Markdown or neighbouring host UI.
let body: BoxRenderable | undefined
let motion!: ReturnType<typeof createBodyMotion>
const [motionEnabled, setMotionEnabled] = createSignal(true)
const bodyRows = 28
const [motionText, setMotionText] = createSignal(
  [
    "A readable English line with enough letters for two travelling loading bands.",
    ...Array.from(
      { length: 26 },
      (_, i) => `Row ${i}: another original line stays readable while the local model is thinking.`,
    ),
    "🧪 界 é",
  ].join("\n"),
)
const dark = RGBA.fromHex("#141414")
const mint = RGBA.fromHex("#a0d8c0")
const animated = await testRender(
  () => {
    motion = createBodyMotion(
      {
        renderer: useRenderer(),
        theme: {
          surface: () => ({
            text: {
              action: { primary: { base: mint, focused: dark } },
              feedback: { error: { base: mint } },
              base: RGBA.fromHex("#eeeeee"),
            },
            background: { base: dark, action: { primary: { focused: mint } } },
          }),
        } as unknown as Plugin.Context["theme"],
      },
      () => (body && !body.isDestroyed ? { x: body.x, y: body.y, width: body.width, height: body.height } : undefined),
      motionEnabled,
      () => animations.transitions[0]!,
      animations.loading,
    )
    return (
      <box>
        <text height={1}>HEADER MUST STAY STILL</text>
        <box ref={(node: BoxRenderable) => (body = node)} height={bodyRows} backgroundColor={dark}>
          <text fg="#eeeeee" wrapMode="none">
            {motionText()}
          </text>
        </box>
        <text height={1}>FOOTER MUST STAY STILL</text>
      </box>
    )
  },
  { width: 80, height: bodyRows + 4 },
)
try {
  await animated.renderOnce()
  motion.wait()
  await animated.renderOnce()
  const first = capture(animated)
  await Bun.sleep(180)
  await animated.renderOnce()
  const second = capture(animated)
  assert.notEqual(first, second, "actual waiting glyphs move, not only an invisible clock")
  assert.notEqual(
    first.split("\n")[bodyRows - 1],
    second.split("\n")[bodyRows - 1],
    "the bottom of a tall visible body animates too",
  )
  for (const frame of [first, second]) {
    assert.match(frame.split("\n")[0]!, /HEADER MUST STAY STILL/)
    assert.match(frame.split("\n")[bodyRows + 1]!, /FOOTER MUST STAY STILL/)
    assert.match(frame, /界/, "wide graphemes survive the temporary overlay")
  }
  const target = [
    "Русский текст после готовности модели.",
    ...Array.from(
      { length: 26 },
      (_, i) => `Строка ${i}: все буквы завершаются одним переходом, без повторяющихся блоков.`,
    ),
    "🧪 界 é",
  ].join("\n")
  motion.reveal(() => setMotionText(target))
  for (let i = 0; i < 30 && motion.phase() !== "idle"; i++) {
    await animated.renderOnce()
    await Bun.sleep(40)
  }
  await animated.renderOnce()
  assert.equal(motion.phase(), "idle", "reveal ends without an idle render loop")
  assert.match(capture(animated), /Русский текст/)
  const stoppedFrame = motion.frame()
  await Bun.sleep(150)
  assert.equal(motion.frame(), stoppedFrame, "animation timers stop at idle")
  motion.wait()
  motion.reveal(() => setMotionText("Disabled motion still applies the ready result"))
  setMotionEnabled(false)
  await animated.renderOnce()
  await Bun.sleep(20)
  await animated.renderOnce()
  assert.match(
    capture(animated),
    /Disabled motion still applies/,
    "skipping an effect cannot discard a completed result",
  )
} finally {
  motion.dispose()
  animated.renderer.destroy()
}
console.log("smoke ok")
// A failed run keeps its temporary package for inspection.
rmSync(temp, { recursive: true, force: true })
