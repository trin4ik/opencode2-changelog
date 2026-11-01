// Release-notes reader: selection/translation requests with cancellation, the text shown and its motion viewport.
import { usePlugin } from "@opencode/plugin/tui"
import { SyntaxStyle, type ScrollBoxRenderable } from "@opentui/core"
import { batch, createEffect, createMemo, createSignal, on, onCleanup, Show, untrack } from "solid-js"
import type { ChangelogService } from "./changelog-service"
import { createBodyMotion } from "./motion/engine"
import { loading, transitionById } from "./motion/index"
import { errorMessage, type ModelRef } from "./models"
import {
  candidateItems,
  mainNotes,
  readableNotes,
  releaseItems,
  renderItems,
  withoutLeadIn,
  type Release,
} from "./releases"
import { isEnglish, type TranslationSettings } from "./translation"

export type Level = "important" | "personal" | "full"

const FREE_LIMIT = /free.*(?:limit|quota)|free tier can only be used from within opencode/i

export function createReader(input: {
  service: ChangelogService
  releases: () => Release[]
  version: () => string | undefined
  /** Open editor of the window, if any: the reader is hidden then and must not animate. */
  editor: () => string | undefined
  onModelError: (message: string) => void
}) {
  const context = usePlugin()
  const service = input.service
  const theme = context.theme.surface("dialog")
  const release = createMemo(() => input.releases().find((item) => item.version === input.version()))
  // Version and hash: notes refreshed upstream under the same version are a different text to translate.
  const releaseKey = (item = release()) => (item ? `${item.version}:${item.hash}` : "")
  const level = () => service.settings().detail ?? "important"
  const original = () => service.settings().original === true
  const animations = () => service.settings().animations !== false
  const [translated, setTranslated] = createSignal<{
    release: string
    source: string
    text: string
    language: string
  }>()
  const [selection, setSelection] = createSignal<{
    key: string
    ids: string[]
    model?: ModelRef
    busy: boolean
    error: string
  }>({ key: "", ids: [], busy: false, error: "" })
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [retry, setRetry] = createSignal(0)
  let scroll: ScrollBoxRenderable | undefined
  let disposed = false
  let pendingVisualUpdate: (() => void) | undefined
  let lastSourceKey: string | undefined
  let automaticModelKey: string | undefined
  // Automatic persistence updates the picker, not the identity of the request that just completed.
  const requestModel = createMemo<{ key: string; revision: number }>((previous) => {
    const key = JSON.stringify(service.settings().model)
    if (previous?.key === key) return previous
    const automatic = key === automaticModelKey
    automaticModelKey = undefined
    return {
      key,
      revision: previous && automatic ? previous.revision : (previous?.revision ?? -1) + 1,
    }
  })
  const motion = createBodyMotion(
    context,
    () => {
      // ScrollBox.viewport and Renderable coordinates are public in OpenTUI 0.6.8.
      // Never inspect the host dialog tree: only this reader's own laid-out viewport may be painted.
      const viewport = scroll?.viewport
      if (input.editor() || !viewport || viewport.isDestroyed || viewport.width < 1 || viewport.height < 1)
        return undefined
      return {
        x: viewport.x,
        y: viewport.y,
        width: viewport.width,
        height: viewport.height,
        scrollTop: scroll?.scrollTop,
      }
    },
    animations,
    () => transitionById(service.settings().transition),
    loading,
  )
  const syntax = SyntaxStyle.fromStyles(
    {
      default: { fg: theme.text.muted },
      "markup.heading": { fg: theme.text.base, bold: true },
      "markup.strong": { fg: theme.text.base, bold: true },
      "markup.italic": { fg: theme.text.base, italic: true },
      "markup.link": { fg: theme.text.action.primary.base, underline: true },
      "markup.raw": { fg: theme.text.base },
    },
    context.renderer.nativeScene,
  )
  onCleanup(() => {
    disposed = true
    motion.dispose()
    void context.renderer.idle().then(() => syntax.destroy())
  })

  // A running wait keeps the frame it captured. Other notes (a refresh replaced the release) need a fresh capture,
  // or the previous release's text stays frozen under the loading animation until the translation arrives.
  let waitingRelease: string | undefined
  function wait() {
    const key = untrack(() => releaseKey())
    if (waitingRelease !== key && untrack(motion.phase) !== "idle") motion.cancel()
    waitingRelease = key
    motion.wait()
  }
  function reveal(update: () => void) {
    const apply = () => {
      if (pendingVisualUpdate === apply) pendingVisualUpdate = undefined
      update()
    }
    pendingVisualUpdate = apply
    motion.wait()
    motion.reveal(apply)
  }
  function rememberModel(model: ModelRef | undefined, settings: TranslationSettings) {
    if (!settings.freeOnly || !model) return
    const key = JSON.stringify(model)
    if (key === JSON.stringify(settings.model)) return
    automaticModelKey = key
    void service.rememberModel(model).catch((cause) => {
      if (!disposed) input.onModelError(`Model choice not saved: ${String(cause)}`)
    })
  }

  const parsed = createMemo(() => {
    // Full notes never depend on the item selector's narrower Markdown grammar.
    if (level() === "full") return { items: [], error: "" }
    const item = release()
    try {
      return { items: item ? releaseItems(item) : [], error: "" }
    } catch (cause) {
      return { items: [], error: cause instanceof Error ? cause.message : String(cause) }
    }
  })
  const selectionKey = createMemo(() =>
    JSON.stringify([
      release()?.version,
      release()?.hash,
      level(),
      requestModel().revision,
      service.settings().freeOnly,
      service.settings().selectionPrompt,
      service.settings().language,
      service.settings().prompt,
      original(),
      level() === "personal" ? service.settings().interests : undefined,
    ]),
  )
  const personal = createMemo(() =>
    level() === "personal" && selection().key === selectionKey() ? selection() : undefined,
  )
  const mainSource = createMemo(() => mainNotes(parsed().items))
  const source = createMemo(() => {
    if (level() === "full" || parsed().error) return release()?.markdown ?? ""
    const ids = level() === "personal" ? (personal()?.ids ?? []) : []
    return withSelected(mainSource(), ids)
  })
  // The shown text with the source it came from: a kept translation of the previous view has a different source.
  const displayed = createMemo(() => {
    const ready = translated()
    const untranslated = { text: source(), source: source() }
    if (original() || parsed().error || error()) return untranslated
    // Keep the last readable translation while the next view of the same notes is being generated;
    // other or refreshed notes show their original at once, never the previous release's translation.
    if (!ready || ready.release !== releaseKey()) return untranslated
    if (busy() || personal()?.busy || ready.source === source()) return ready
    return untranslated
  })
  const presentation = createMemo(() => withoutLeadIn(readableNotes(displayed().text), displayed().source))
  const problem = createMemo(() => {
    if (!error()) return ""
    if (FREE_LIMIT.test(error()))
      return "Free translation unavailable: service limit reached. Showing the original, not a translation."
    if (/timeout|timed out|aborted due to timeout/i.test(error()))
      return "The model did not respond within 3 minutes. Showing the original, not a translation."
    return "Translation failed. Showing the original; details are under Source."
  })

  function withSelected(main: string, ids: string[]) {
    return ids.length
      ? `${main}\n\n## Matching your interests · ${ids.length}\n\n${renderItems(parsed().items, ids)}`.trim()
      : main
  }

  createEffect(
    on(
      createMemo(() => JSON.stringify([selectionKey(), retry()])),
      () => {
        const key = selectionKey()
        const controller = new AbortController()
        onCleanup(() => controller.abort())
        const item = release()
        setSelection({ key, ids: [], busy: false, error: "" })
        if (
          !item ||
          level() !== "personal" ||
          parsed().error ||
          !service.settings().interests?.trim() ||
          !candidateItems(parsed().items).length
        )
          return
        setSelection({ key, ids: [], busy: true, error: "" })
        if (!input.editor()) wait()
        const settings = service.settings()
        const combined = !original() && !isEnglish(settings.language)
        const operation = combined
          ? service.translator.personal(item, { ...settings, detail: "personal" }, controller.signal)
          : service.translator.select(item, { ...settings, detail: "personal" }, controller.signal)
        void operation.then(
          (result) => {
            if (controller.signal.aborted) return
            const valid = new Set(candidateItems(parsed().items).map((item) => item.id))
            const ids = [...new Set(result.ids)].filter((id) => valid.has(id)).slice(0, 5)
            const update = () => {
              if (controller.signal.aborted || disposed) return
              batch(() => {
                setSelection({ key, ids, model: result.model, busy: false, error: "" })
                if ("text" in result && typeof result.text === "string")
                  setTranslated({
                    release: releaseKey(item),
                    source: withSelected(mainSource(), ids),
                    text: result.text,
                    language: settings.language,
                  })
              })
            }
            // A saved translation of other notes has no frame of the same text to morph from: show it at once.
            const instant =
              "text" in result && "cached" in result && !!result.cached && translated()?.release !== releaseKey(item)
            if ("text" in result && !input.editor() && !instant) reveal(update)
            else {
              if (instant) motion.cancel()
              update()
              // A selection that leaves the already displayed source unchanged starts no translation.
              const ready = translated()
              if (
                !("text" in result) &&
                ready?.release === releaseKey(item) &&
                ready.source === source() &&
                ready.language === settings.language
              )
                motion.cancel()
            }
            rememberModel(result.model, settings)
          },
          (cause: unknown) => {
            if (controller.signal.aborted) return
            motion.cancel()
            // Provider errors can echo request data, including the user's private interests.
            setSelection({
              key,
              ids: [],
              busy: false,
              error: FREE_LIMIT.test(errorMessage(cause))
                ? "Free matching unavailable: service limit reached. Showing highlights."
                : "The model could not match items. Highlights kept.",
            })
          },
        )
      },
    ),
  )

  createEffect(
    on(
      createMemo(() =>
        JSON.stringify([
          release()?.version,
          release()?.hash,
          source(),
          original(),
          level(),
          service.settings().language,
          service.settings().prompt,
          requestModel().revision,
          service.settings().freeOnly,
          personal()?.busy,
          personal()?.model,
          retry(),
        ]),
      ),
      () => {
        const text = source()
        const showOriginal = original()
        const detail = level()
        const controller = new AbortController()
        // Selector -> translation is one wait. The replacement request owns cancel/reveal, not this cleanup.
        onCleanup(() => controller.abort())
        setError("")
        setBusy(false)
        const sourceKey = JSON.stringify([release()?.version, release()?.hash, level(), text])
        if (sourceKey !== lastSourceKey) scroll?.scrollTo(0)
        lastSourceKey = sourceKey
        if (!text.trim() || parsed().error || (detail === "personal" && (!personal() || personal()?.busy))) {
          if (!personal()?.busy) motion.cancel()
          return
        }
        const settings = service.settings()
        const currentRelease = releaseKey()
        if (
          detail === "personal" &&
          translated()?.release === currentRelease &&
          translated()?.source === text &&
          translated()?.language === settings.language
        )
          return
        const preferred = settings.freeOnly ? (personal()?.model ?? settings.model) : settings.model
        // English and explicit original require no translation, but personal selection still reveals its result.
        if (showOriginal || isEnglish(settings.language)) {
          const update = () => {
            if (!controller.signal.aborted && !disposed)
              setTranslated({ release: currentRelease, source: text, text, language: settings.language })
          }
          if (input.editor()) update()
          else reveal(update)
          return
        }
        setBusy(true)
        if (!input.editor()) wait()
        void service.translator
          .translate(text, { ...settings, detail, model: preferred && { ...preferred } }, controller.signal)
          .then(
            (result) => {
              if (controller.signal.aborted) return
              setBusy(false)
              // Capture the clean old frame before changing Markdown, including synchronous cache hits.
              const update = () => {
                if (!controller.signal.aborted && !disposed)
                  setTranslated({
                    release: currentRelease,
                    source: text,
                    text: result.text,
                    language: settings.language,
                  })
              }
              // A saved translation of other notes has no frame of the same text to morph from: show it at once.
              const instant = result.cached && translated()?.release !== currentRelease
              if (instant) motion.cancel()
              if (input.editor() || instant) update()
              else reveal(update)
              rememberModel(result.model, settings)
            },
            (cause: unknown) => {
              if (controller.signal.aborted) return
              setError(cause instanceof Error ? cause.message : String(cause))
              setBusy(false)
              motion.cancel()
            },
          )
      },
    ),
  )

  // Editors hide the reader, not the request. Resume its visual wait only when the reader returns.
  createEffect(
    on(
      input.editor,
      (value) => {
        pendingVisualUpdate?.()
        motion.cancel()
        if (!value && (busy() || personal()?.busy)) wait()
      },
      { defer: true },
    ),
  )
  createEffect(
    on(
      animations,
      (enabled) => {
        if (!enabled) {
          pendingVisualUpdate?.()
          motion.cancel()
        } else if (!input.editor() && (busy() || personal()?.busy)) wait()
      },
      { defer: true },
    ),
  )

  return {
    release,
    level,
    original,
    animations,
    parsed,
    personal,
    source,
    presentation,
    problem,
    busy,
    error,
    motion,
    syntax,
    scroll: () => scroll,
    setScroll: (value: ScrollBoxRenderable) => (scroll = value),
    reload: () => setRetry((value) => value + 1),
  }
}

export function ChangelogReader(props: {
  reader: ReturnType<typeof createReader>
  /** Why the shown release may differ from the expected one. */
  notice: string
  onChooseModel: () => void
  /** Click on the reader while a dropdown is open. */
  onBackdrop: (event: { stopPropagation: () => void }) => void
}) {
  const context = usePlugin()
  const theme = context.theme.surface("dialog")
  const reader = props.reader
  return (
    <>
      <Show when={props.notice}>
        <box paddingLeft={2} paddingRight={2} paddingTop={1} flexShrink={0}>
          <text fg={theme.text.feedback.warning.base} wrapMode="word">
            {props.notice}
          </text>
        </box>
      </Show>
      <Show when={reader.error() || reader.personal()?.error}>
        <box paddingLeft={2} paddingRight={2} paddingTop={1} flexShrink={0}>
          <text fg={theme.text.feedback.warning.base} wrapMode="word">
            {reader.problem() || reader.personal()?.error}
          </text>
          <text selectable={false} fg={theme.text.action.primary.base} onMouseUp={props.onChooseModel}>
            Choose another model ›
          </text>
        </box>
      </Show>
      <box
        backgroundColor={context.theme.background.raised.high}
        paddingTop={1}
        paddingBottom={1}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        onMouseDown={props.onBackdrop}
      >
        <scrollbox
          id="changelog-reader"
          ref={reader.setScroll}
          flexGrow={1}
          minHeight={0}
          contentOptions={{ minHeight: 0, paddingLeft: 2, paddingRight: 2 }}
          backgroundColor={context.theme.background.raised.high}
          scrollbarOptions={{ visible: false }}
        >
          <Show when={reader.release()} fallback={<text fg={theme.text.muted}>No releases available</text>}>
            <Show
              when={reader.source().trim()}
              fallback={<text fg={theme.text.muted}>No highlights published. Choose All.</text>}
            >
              <markdown
                content={reader.presentation()}
                syntaxStyle={reader.syntax}
                fg={theme.text.muted}
                conceal
                concealCode
                streaming={false}
              />
            </Show>
          </Show>
        </scrollbox>
      </box>
    </>
  )
}
