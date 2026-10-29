// Plugin-wide state shared by every open changelog window: preferences, caches, translator and the shared source request.
import type { Plugin } from "@opencode/plugin/tui"
import { modelKey, type ModelRef } from "./models"
import {
  buildReleases,
  loadChangelog,
  SOURCE_PAGE_PREFIX,
  V2_VERSION,
  type ExtraRelease,
  type Release,
} from "./releases"
import {
  createTranslator,
  readSettings,
  type SelectionCache,
  type TranslationCache,
  type TranslationSettings,
} from "./translation"
import { createMemo } from "solid-js"

type Preferences = Partial<TranslationSettings> & { recentModels: ModelRef[]; favoriteModels: ModelRef[] }
// v1 cached only the dev changelog, which can lag behind a published release; it is ignored, not migrated.
type SourceCache = { version: 2; at: number; markdown: string; extra: ExtraRelease[]; latest: string | null }
export type Loaded = { at: number; releases: Release[]; latest?: string }
const SOURCE_TTL_MS = 60 * 60_000
// A known-missing version (requested, installed or newest tag) is rechecked on open, but not more often.
const MISSING_RECHECK_MS = 5 * 60_000
const MAX_CACHED_BYTES = 4 * 1024 * 1024

function extraRelease(value: unknown): value is ExtraRelease {
  if (!value || typeof value !== "object") return false
  const { version, date, markdown, url } = value as Partial<ExtraRelease>
  return (
    typeof version === "string" &&
    V2_VERSION.test(version) &&
    typeof date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    typeof markdown === "string" &&
    typeof url === "string" &&
    url.startsWith(SOURCE_PAGE_PREFIX)
  )
}

function cachedSource(value: unknown): Loaded | undefined {
  if (!value || typeof value !== "object") return
  const { version, at, markdown, extra, latest } = value as Partial<SourceCache>
  if (
    version !== 2 ||
    !Number.isSafeInteger(at) ||
    at! <= 0 ||
    at! > Date.now() ||
    typeof markdown !== "string" ||
    !Array.isArray(extra) ||
    !extra.every(extraRelease) ||
    (latest !== null && (typeof latest !== "string" || !V2_VERSION.test(latest))) ||
    Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_CACHED_BYTES
  )
    return
  try {
    return { at: at!, releases: buildReleases({ markdown, extra }), latest: latest ?? undefined }
  } catch {
    return
  }
}

/** Fresh means: within TTL, and every version we know should exist is present (or was just rechecked). */
export function isFresh(data: Loaded, wanted: readonly (string | undefined)[]): boolean {
  const age = Date.now() - data.at
  if (age >= SOURCE_TTL_MS) return false
  const missing = [...wanted, data.latest].some(
    (version) => version && !data.releases.some((release) => release.version === version),
  )
  return !missing || age < MISSING_RECHECK_MS
}

function storedModels(value: unknown): ModelRef[] {
  if (!Array.isArray(value)) return []
  return value
    .flatMap((model) => {
      if (!model || typeof model !== "object") return []
      try {
        return [readSettings({ model }).model!]
      } catch {
        return []
      }
    })
    .slice(0, 50)
}

export type ChangelogService = ReturnType<typeof createChangelogService>

/** `open` shows the changelog window again, e.g. after a dialog of the model picker replaced it. */
export function createChangelogService(context: Plugin.Context, open: (version?: string) => void) {
  const configured = readSettings(context.options)
  const [preferences, updatePreferences] = context.storage.store<Preferences>("preferences.v1", {
    // Only explicit choices are stored: defaults (prompts, language list) must stay upgradable.
    initial: { recentModels: [], favoriteModels: [] },
  })
  const [cache, updateCache] = context.storage.store<TranslationCache>("translations.v1", {
    initial: { entries: {} },
  })
  const [selections, updateSelections] = context.storage.store<SelectionCache>("selections.v1", {
    initial: { entries: {} },
  })
  const [sourceCache, updateSourceCache] = context.storage.store<SourceCache>("source.v2", {
    initial: { version: 2, at: 0, markdown: "", extra: [], latest: null },
  })
  // The running host; beta/dev channels report non-release numbers and are not looked up.
  const installed = V2_VERSION.test(context.app.version) ? context.app.version : undefined
  const translator = createTranslator(context.client, () => cache, updateCache, {
    read: () => selections,
    save: updateSelections,
  })
  const settings = createMemo(() => {
    // The previous built-in paid default was persisted on first open, not explicitly selected.
    // Preserve actual choices (recorded in recentModels) and explicit installation options.
    const oldDefault =
      context.options.model === undefined &&
      preferences.model?.providerID === "openai" &&
      preferences.model.id === "gpt-6-luna" &&
      !storedModels(preferences.recentModels).length
    const values: Record<string, unknown> = { ...configured }
    for (const key of Object.keys(configured) as Array<keyof TranslationSettings>) {
      if (key === "selectionPrompt" || (oldDefault && (key === "model" || key === "freeOnly"))) continue
      const value = preferences[key]
      if (value === undefined) continue
      try {
        readSettings({ ...configured, [key]: value })
        values[key] = value
      } catch {
        // A corrupt field must not discard the other saved preferences.
      }
    }
    // The configured free-only flag belongs to the configured model; a saved model without a saved flag
    // derives it (readSettings: opencode/*-free ⇒ free-only), instead of forbidding a chosen paid model.
    if (values.model !== configured.model && preferences.freeOnly === undefined) delete values.freeOnly
    try {
      return readSettings(values)
    } catch {
      return configured
    }
  })
  const updateSettings = async (patch: Partial<TranslationSettings>) => {
    const checked = readSettings({ ...settings(), ...patch })
    await updatePreferences((draft) => {
      if ("language" in patch) draft.language = checked.language
      if ("languages" in patch) draft.languages = checked.languages
      if ("detail" in patch) draft.detail = checked.detail
      if ("prompt" in patch) draft.prompt = checked.prompt
      if ("model" in patch) draft.model = checked.model && { ...checked.model }
      if ("freeOnly" in patch) draft.freeOnly = checked.freeOnly
      if ("interests" in patch) draft.interests = checked.interests
      if ("animations" in patch) draft.animations = checked.animations
      if ("transition" in patch) draft.transition = checked.transition
      if ("original" in patch) draft.original = checked.original
      if ("model" in patch && checked.model) {
        const recent = storedModels(draft.recentModels)
        draft.recentModels = [
          { ...checked.model },
          ...recent.filter((item) => item && modelKey(item) !== modelKey(checked.model!)),
        ].slice(0, 10)
      }
    })
  }
  const rememberModel = (model: ModelRef) =>
    updatePreferences((draft) => {
      draft.model = { ...model }
    })
  const favorites = () => storedModels(preferences.favoriteModels)
  const recent = () => storedModels(preferences.recentModels)
  const toggleFavorite = async (model: ModelRef) => {
    await updatePreferences((draft) => {
      const values = storedModels(draft.favoriteModels)
      draft.favoriteModels = values.some((item) => item && modelKey(item) === modelKey(model))
        ? values.filter((item) => item && modelKey(item) !== modelKey(model))
        : [{ ...model }, ...values].slice(0, 50)
    })
  }

  // Debug: forget translations, selections and the fetched notes; the next open downloads them again.
  const clearCaches = async () => {
    await Promise.all([
      updateCache((draft) => {
        draft.entries = {}
      }),
      updateSelections((draft) => {
        draft.entries = {}
      }),
      updateSourceCache((draft) => {
        draft.at = 0
        draft.markdown = ""
        draft.extra = []
        draft.latest = null
      }),
    ])
  }

  // One request per setup, shared by open dialogs. A warm refresh may finish after the dialog closes.
  let active = true
  let sourceMemo: { at: number; length: number; value: Loaded | undefined } | undefined
  const savedSource = () => {
    const at = sourceCache.at
    const length = typeof sourceCache.markdown === "string" ? sourceCache.markdown.length : -1
    if (!sourceMemo || sourceMemo.at !== at || sourceMemo.length !== length) {
      sourceMemo = { at, length, value: cachedSource(sourceCache) }
    }
    return sourceMemo.value
  }
  let pending:
    | {
        controller: AbortController
        promise: Promise<Loaded>
        coldReaders: number
        keepAlive: boolean
      }
    | undefined
  const load = (signal: AbortSignal, warm: boolean, wanted: readonly (string | undefined)[]): Promise<Loaded> => {
    if (signal.aborted || !active) return Promise.reject(new DOMException("Aborted", "AbortError"))
    const cached = savedSource()
    if (cached && isFresh(cached, wanted)) return Promise.resolve(cached)
    if (pending?.controller.signal.aborted) pending = undefined
    if (!pending) {
      const controller = new AbortController()
      const startedAt = Date.now()
      const promise = loadChangelog(controller.signal)
        .then(async ({ markdown, extra, latest, releases }) => {
          const at = Date.now()
          if (active && !controller.signal.aborted) {
            // The synced store may have been updated by another TUI while this request was in flight.
            await updateSourceCache((draft) => {
              if (Number.isSafeInteger(draft.at) && draft.at > startedAt && draft.at <= Date.now()) return
              draft.version = 2
              draft.at = at
              draft.markdown = markdown
              draft.extra = extra.map((item) => ({ ...item }))
              draft.latest = latest ?? null
            }).catch(() => {}) // A failed disk write must not discard successfully fetched notes.
          }
          return { at, releases, latest }
        })
        .finally(() => {
          if (pending?.promise === promise) pending = undefined
        })
      pending = { controller, promise, coldReaders: 0, keepAlive: warm }
    }
    const request = pending
    if (warm) request.keepAlive = true
    else {
      request.coldReaders++
      let released = false
      const release = () => {
        if (released) return
        released = true
        signal.removeEventListener("abort", release)
        request.coldReaders--
        if (!request.coldReaders && !request.keepAlive) request.controller.abort()
      }
      signal.addEventListener("abort", release, { once: true })
      void request.promise.then(release, release)
    }
    return request.promise
  }

  return {
    installed,
    open,
    settings,
    translator,
    updateSettings,
    rememberModel,
    recent,
    favorites,
    toggleFavorite,
    clearCaches,
    cached: savedSource,
    load,
    dispose() {
      active = false
      pending?.controller.abort()
    },
  }
}
