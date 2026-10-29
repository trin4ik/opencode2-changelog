// Settings panel and the three text editors (translation prompt, interests, language list) of the changelog window.
import { usePlugin } from "@opencode/plugin/tui"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, onCleanup } from "solid-js"
import type { ChangelogService } from "./changelog-service"
import { transitionById, transitions } from "./motion/index"
import { DEFAULT_LANGUAGES, DEFAULT_PROMPT, readSettings, type TranslationSettings } from "./translation"

/** What the window currently shows instead of (or over) the reader. */
export type Editor =
  | "version"
  | "language"
  | "view"
  | "source"
  | "prs"
  | "prompt"
  | "interests"
  | "languages"
  | "settings"
  | undefined

export function createSettingsEditor(input: {
  service: ChangelogService
  editor: () => Editor
  setEditor: (value: Editor) => void
  /** Runs the current view again, e.g. after the caches were cleared. */
  reload: () => void
}) {
  const context = usePlugin()
  const service = input.service
  const dimensions = useTerminalDimensions()
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal("")
  const [index, setIndex] = createSignal(0)
  const [promptDraft, setPromptDraft] = createSignal(service.settings().prompt)
  const [languagesDraft, setLanguagesDraft] = createSignal("")
  const [interestsDraft, setInterestsDraft] = createSignal(service.settings().interests ?? "")
  let scroll: ScrollBoxRenderable | undefined
  let promptInput: TextareaRenderable | undefined
  let disposed = false
  onCleanup(() => (disposed = true))

  const editingText = () =>
    input.editor() === "prompt" || input.editor() === "interests" || input.editor() === "languages"
  const textLimit = () => (input.editor() === "languages" ? 1500 : input.editor() === "interests" ? 4000 : 16000)
  const textDraft = () =>
    input.editor() === "languages"
      ? languagesDraft()
      : input.editor() === "interests"
        ? interestsDraft()
        : promptDraft()
  const title = () =>
    input.editor() === "settings"
      ? "Settings"
      : input.editor() === "languages"
        ? "Languages"
        : input.editor() === "interests"
          ? "My interests"
          : input.editor() === "prompt"
            ? "Translation prompt"
            : undefined

  async function save(patch: Partial<TranslationSettings>) {
    if (saving()) return
    setSaving(true)
    setError("")
    try {
      await service.updateSettings(patch)
    } catch (cause) {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!disposed) setSaving(false)
    }
  }

  function openPrompt() {
    setPromptDraft(service.settings().prompt)
    setError("")
    input.setEditor("prompt")
  }

  function openInterests() {
    setInterestsDraft(service.settings().interests ?? "")
    setError("")
    input.setEditor("interests")
  }

  function openLanguages() {
    setLanguagesDraft(service.settings().languages.join("\n"))
    setError("")
    input.setEditor("languages")
  }

  function reset() {
    const editor = input.editor()
    const value = editor === "languages" ? DEFAULT_LANGUAGES.join("\n") : editor === "interests" ? "" : DEFAULT_PROMPT
    if (editor === "languages") setLanguagesDraft(value)
    else if (editor === "interests") setInterestsDraft(value)
    else setPromptDraft(value)
    promptInput?.setText(value)
  }

  async function submit() {
    if (saving()) return
    setError("")
    const target = input.editor()
    try {
      const patch =
        target === "languages"
          ? {
              languages: languagesDraft()
                .split(/[\n,]+/)
                .map((code) => code.trim())
                .filter(Boolean),
            }
          : target === "interests"
            ? { interests: interestsDraft() }
            : { prompt: promptDraft() }
      readSettings({ ...service.settings(), ...patch })
      setSaving(true)
      await service.updateSettings(patch)
      if (!disposed && input.editor() === target) input.setEditor("settings")
    } catch (cause) {
      if (!disposed)
        setError(
          target === "interests"
            ? "Could not save interests. Try again."
            : cause instanceof Error
              ? cause.message
              : String(cause),
        )
    } finally {
      if (!disposed) setSaving(false)
    }
  }

  const animations = () => service.settings().animations !== false
  const actions = () => [
    { title: "Translation prompt", key: "p", run: openPrompt },
    { title: "Languages", key: "l", run: openLanguages },
    { title: "My interests", key: "i", run: openInterests },
    { title: `Animations · ${animations() ? "on" : "off"}`, key: "a", run: () => save({ animations: !animations() }) },
    {
      title: `Transition · ${transitionById(service.settings().transition).title}`,
      key: "t",
      run: () => {
        const current = transitions.indexOf(transitionById(service.settings().transition))
        return save({ transition: transitions[(current + 1) % transitions.length]!.id })
      },
    },
    {
      title: "Reset cache (debug)",
      key: "x",
      run: async () => {
        try {
          await service.clearCaches()
        } catch (cause) {
          if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
          return
        }
        if (disposed) return
        // Re-run the current view: the reader keeps its text and shows the loading wave over it.
        input.setEditor(undefined)
        input.reload()
        context.ui.toast.show({ message: "Cache reset: translating again", variant: "info" })
      },
    },
    {
      title: `Original · ${service.settings().original ? "on" : "off"}`,
      key: "o",
      run: () => save({ original: !service.settings().original }),
    },
    { title: "Source", key: "c", run: () => input.setEditor("source") },
  ]

  return {
    saving,
    error,
    setError,
    index,
    setIndex,
    editingText,
    title,
    actions,
    save,
    submit,
    openInterests,
    setScroll: (value: ScrollBoxRenderable) => (scroll = value),
    /** Arrow/page keys inside the settings list. */
    move(bind: string) {
      const count = actions().length
      setIndex((value) => (value + (bind === "up" || bind === "pageup" ? count - 1 : 1)) % count)
      scroll?.scrollTo(Math.max(0, index() - Math.max(2, dimensions().height - 11)))
    },
    textEditor: {
      draft: textDraft,
      limit: textLimit,
      reset,
      setPromptInput: (value: TextareaRenderable) => (promptInput = value),
      change(value: unknown) {
        // Textarea has no maxLength option; bound both pasted and typed content here.
        const text = typeof value === "string" ? value : (promptInput?.plainText ?? "")
        const bounded = text.slice(0, textLimit())
        if (input.editor() === "languages") setLanguagesDraft(bounded)
        else if (input.editor() === "interests") setInterestsDraft(bounded)
        else setPromptDraft(bounded)
        if (text !== bounded) promptInput?.setText(bounded)
      },
    },
  }
}

type SettingsEditor = ReturnType<typeof createSettingsEditor>

export function SettingsList(props: { settings: SettingsEditor }) {
  const context = usePlugin()
  const theme = context.theme.surface("dialog")
  const dimensions = useTerminalDimensions()
  return (
    <>
      <box height={1} />
      <scrollbox
        ref={props.settings.setScroll}
        maxHeight={Math.max(3, dimensions().height - 10)}
        scrollbarOptions={{ visible: false }}
      >
        <For each={props.settings.actions()}>
          {(item, index) => {
            const focused = () => index() === props.settings.index() % props.settings.actions().length
            return (
              <text
                selectable={false}
                wrapMode="none"
                fg={focused() ? theme.text.action.primary.focused : theme.text.base}
                bg={focused() ? theme.background.action.primary.focused : theme.background.base}
                onMouseUp={() => {
                  props.settings.setIndex(index())
                  item.run()
                }}
              >{`${item.key} ${item.title}`}</text>
            )
          }}
        </For>
      </scrollbox>
    </>
  )
}

export function TextEditor(props: { settings: SettingsEditor; editor: Editor }) {
  const context = usePlugin()
  const theme = context.theme.surface("dialog")
  const editor = props.settings.textEditor
  return (
    <box flexGrow={1} minHeight={0}>
      <text fg={theme.text.muted} wrapMode="word">
        {props.editor === "languages"
          ? "Language codes, one per line, for example en, ru, zh-Hans."
          : props.editor === "interests"
            ? "Used by the For me view. The text is sent to the selected model."
            : "{language} is replaced with the selected language."}
      </text>
      <box height={1} />
      <textarea
        ref={editor.setPromptInput}
        focused
        initialValue={editor.draft()}
        flexGrow={1}
        minHeight={2}
        wrapMode="word"
        textColor={theme.text.formfield.base}
        backgroundColor={theme.background.formfield.base}
        focusedTextColor={theme.text.formfield.focused}
        focusedBackgroundColor={theme.background.formfield.focused}
        onContentChange={editor.change}
      />
      <box flexDirection="row" flexWrap="wrap" gap={2} paddingTop={1}>
        <text selectable={false} fg={theme.text.action.primary.base} onMouseUp={editor.reset}>
          {props.editor === "languages"
            ? "Restore default list"
            : props.editor === "interests"
              ? "Clear"
              : "Restore default prompt"}
        </text>
        <text fg={theme.text.muted}>{`${editor.draft().length}/${editor.limit()}`}</text>
      </box>
    </box>
  )
}
