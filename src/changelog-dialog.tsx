// Changelog window: compact chrome, dropdowns (version, language, view) and the single modal keymap layer.
// The reader, settings editors and model choice live in the sibling changelog-* modules.
import { usePlugin } from "@opencode/plugin/tui"
import { TextAttributes, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createModelPicker } from "./changelog-model"
import { ChangelogReader, createReader, type Level } from "./changelog-reader"
import type { ChangelogService } from "./changelog-service"
import { createSettingsEditor, SettingsList, TextEditor, type Editor } from "./changelog-settings"
import { compareVersions, type Release } from "./releases"
import { readSettings } from "./translation"

const defaultLanguageNames = [
  { code: "ru", name: "Русский" },
  { code: "en", name: "English" },
  { code: "de", name: "Deutsch" },
  { code: "fr", name: "Français" },
  { code: "es", name: "Español" },
  { code: "pt", name: "Português" },
  { code: "uk", name: "Українська" },
  { code: "ja", name: "日本語" },
  { code: "zh", name: "中文" },
  { code: "ko", name: "한국어" },
]

const views = [
  { title: "Highlights", key: "1", detail: "important" as const },
  { title: "For me", key: "2", detail: "personal" as const },
  { title: "All", key: "3", detail: "full" as const },
]

export function ChangelogDialog(props: {
  service: ChangelogService
  releases: Release[]
  /** Newest V2 release tag upstream, which may be newer than any notes found. */
  latest?: string
  initialVersion?: string
}) {
  const context = usePlugin()
  const service = props.service
  const theme = context.theme.surface("dialog")
  const dimensions = useTerminalDimensions()
  const has = (value?: string) => !!value && props.releases.some((item) => item.version === value)
  // Until the user picks a version the window follows the requested one, else the newest, across source refreshes.
  const [chosen, setChosen] = createSignal<string>()
  const version = createMemo(
    () => chosen() ?? (has(props.initialVersion) ? props.initialVersion : props.releases[0]?.version),
  )
  // Never let an older release pass for the requested, installed or newest published one.
  const missingNotice = createMemo(() => {
    const shown = version() ?? "—"
    if (props.initialVersion && !has(props.initialVersion) && chosen() === undefined)
      return `No notes for ${props.initialVersion} — showing ${shown}.`
    const newest = props.releases[0]?.version
    if (version() !== newest) return ""
    const expected = [props.latest, service.installed]
      .filter((value): value is string => !!value && !has(value) && (!newest || compareVersions(value, newest) > 0))
      .sort((left, right) => compareVersions(right, left))[0]
    return expected ? `Notes for ${expected} are not published yet — showing ${shown}.` : ""
  })

  const [editor, setEditorValue] = createSignal<Editor>()
  const [controlsFocused, setControlsFocused] = createSignal(false)
  // Source (and its PR list) returns to where it was opened from: Settings or the reader.
  let sourceBack: Editor
  function setEditor(value: Editor) {
    if (!value && editor()) setControlsFocused(false)
    if (value === "source" && editor() !== "prs") sourceBack = editor() === "settings" ? "settings" : undefined
    setEditorValue(value)
  }
  const reader = createReader({
    service,
    releases: () => props.releases,
    version,
    editor,
    onModelError: (message) => settings.setError(message),
  })
  const settings = createSettingsEditor({ service, editor, setEditor, reload: reader.reload })
  const modelPicker = createModelPicker(service, version)
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal(0)
  const [draft, setDraft] = createSignal(service.settings().language)
  const [languageError, setLanguageError] = createSignal("")
  const [languageSaving, setLanguageSaving] = createSignal(false)
  const [languageIndex, setLanguageIndex] = createSignal(0)
  const [customLanguage, setCustomLanguage] = createSignal(false)
  const [action, setAction] = createSignal(0)
  const [viewIndex, setViewIndex] = createSignal(0)
  const languages = createMemo(() =>
    service.settings().languages.map((code) => {
      const known = defaultLanguageNames.find((item) => item.code === code)
      if (known) return known
      try {
        return { code, name: new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code }
      } catch {
        return { code, name: code }
      }
    }),
  )
  const inlinePicker = () => editor() === "language" || editor() === "version" || editor() === "view"
  const readerVisible = () => !editor() || inlinePicker()
  let root: BoxRenderable | undefined
  const anchors: Partial<Record<"version" | "language" | "view", BoxRenderable>> = {}
  let languageScroll: ScrollBoxRenderable | undefined
  let sourceScroll: ScrollBoxRenderable | undefined
  let disposed = false
  let languageRequest = 0
  onCleanup(() => {
    disposed = true
    languageRequest++
  })
  context.ui.dialog.set({ size: "large", centered: true })

  const height = () => Math.max(1, Math.min(Math.floor(dimensions().height * 0.6) - 2, dimensions().height - 10))
  const matches = createMemo(() =>
    props.releases.filter((item) => `${item.version} ${item.date}`.toLowerCase().includes(query().toLowerCase())),
  )
  const pickerRows = () => Math.max(1, Math.min(5, height() - 2))
  const pickerStart = () => Math.max(0, selected() - pickerRows() + 1)
  const prLinks = () =>
    (reader.release()?.prs ?? []).map((id) => ({ id, url: `https://github.com/anomalyco/opencode/pull/${id}` }))
  const readingStatus = () => {
    if (modelPicker.loading()) return "Loading models…"
    if (reader.parsed().error) return "Showing the full original · c details"
    const personal = reader.personal()
    if (personal?.busy || reader.busy()) {
      const spinner = reader.animations() ? `${"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[reader.motion.frame() % 10]} ` : ""
      return `${spinner}${personal?.busy ? "Matching your interests…" : "Translating…"}`
    }
    return reader.error() || personal?.error ? "m · choose model   r · retry" : ""
  }

  function choose(item: Release) {
    context.renderer.clearSelection()
    setChosen(item.version)
    setEditor(undefined)
  }

  // The dropdown hangs under its button; layout values are read when the editor or the terminal size changes.
  const pickerPosition = createMemo(() => {
    const kind = editor()
    dimensions()
    if (kind !== "version" && kind !== "language" && kind !== "view") return { left: 2, top: 2, width: 32 }
    const anchor = anchors[kind]
    const availableWidth = root?.width || Math.max(20, dimensions().width - 8)
    // Version rows fit "2.1.4 · 2026-10-23 · installed ✓" inside border and padding.
    const width = Math.min(kind === "version" ? 40 : kind === "language" ? 29 : 24, availableWidth - 2)
    return {
      left: Math.max(1, Math.min((anchor?.x ?? 2) - (root?.x ?? 0), availableWidth - width - 1)),
      top: anchor && root ? anchor.y - root.y + anchor.height : 2,
      width,
    }
  })
  const pickerHeight = () =>
    Math.min(
      Math.max(4, dimensions().height - 8),
      editor() === "language" ? (customLanguage() || languageError() ? 12 : 8) : editor() === "version" ? 9 : 5,
    )

  function openVersion() {
    setQuery("")
    setSelected(
      Math.max(
        0,
        props.releases.findIndex((item) => item.version === version()),
      ),
    )
    setEditor("version")
  }

  function openLanguage() {
    setDraft(service.settings().language)
    setLanguageIndex(
      Math.max(
        0,
        languages().findIndex((item) => item.code === service.settings().language),
      ),
    )
    setCustomLanguage(false)
    setLanguageError("")
    setEditor("language")
  }

  async function applyLanguage(language = draft()) {
    if (languageSaving()) return
    const request = ++languageRequest
    try {
      const next = readSettings({ ...service.settings(), language: language.trim() })
      context.renderer.clearSelection()
      setLanguageSaving(true)
      setLanguageError("")
      // Restore the reader before changing language: cached/English replies can settle synchronously.
      // Otherwise the old frame is hidden in the picker and the transition has nothing to capture.
      setEditor(undefined)
      await service.updateSettings({ language: next.language, original: false })
      if (!disposed && request === languageRequest && editor() === "language") setEditor(undefined)
    } catch (cause) {
      if (!disposed && request === languageRequest) {
        if (!editor()) setEditor("language")
        setLanguageError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (!disposed && request === languageRequest) setLanguageSaving(false)
    }
  }

  function selectLanguage() {
    const item = languages()[languageIndex()]
    if (item) return applyLanguage(item.code)
    setCustomLanguage(true)
  }

  function openView() {
    setViewIndex(views.findIndex((view) => view.detail === reader.level()))
    setEditor("view")
  }

  function pickView(detail: Level) {
    void settings.save({ detail })
    setEditor(undefined)
  }

  function copyText(text: string, message: string) {
    if (!text) return
    const copied = context.renderer.copyToClipboardOSC52(text)
    context.ui.toast.show({
      message: copied ? message : "Clipboard unavailable",
      variant: copied ? "success" : "warning",
    })
  }
  const copySource = () => copyText(reader.release()?.url ?? "", "Link copied")
  const copyOriginal = () => copyText(reader.release()?.markdown ?? "", "Original copied")
  const copyPRs = () =>
    copyText(
      prLinks()
        .map((pr) => `#${pr.id} ${pr.url}`)
        .join("\n"),
      "PR list copied",
    )

  const actions = [
    { title: "Version", key: "v", run: openVersion },
    { title: "Language", key: "l", run: openLanguage },
    { title: "View", key: "d", run: openView },
    { title: "Model", key: "m", run: modelPicker.open },
    { title: "Settings", key: "s", run: () => setEditor("settings") },
  ]
  const actionTitle = (key: string, title: string) => {
    const personal = reader.personal()
    return key === "v"
      ? `Version ${version() ?? "—"} ▾`
      : key === "l"
        ? `${reader.original() ? "EN · original" : (languages().find((item) => item.code === service.settings().language)?.name ?? service.settings().language)} ▾`
        : key === "d"
          ? `${views.find((view) => view.detail === reader.level())?.title}${reader.level() === "personal" && service.settings().interests?.trim() && personal && !personal.busy && !personal.error ? ` +${personal.ids.length}` : ""} ▾`
          : key === "m"
            ? `Model ${service.settings().model?.id ?? "default"} ▾`
            : key === "s"
              ? "⚙"
              : title
  }

  context.keymap.layer(() => ({
    mode: "modal",
    priority: 10,
    commands: [
      {
        bind: "ctrl+s",
        enabled: settings.editingText(),
        title: "Save prompt",
        run: settings.submit,
      },
      {
        bind: "escape",
        title: "Back / close",
        run: () => {
          if (editor() === "prs") setEditor("source")
          else if (editor() === "source") setEditor(sourceBack)
          else if (settings.editingText()) setEditor("settings")
          else if (editor()) setEditor(undefined)
          else context.ui.dialog.clear()
        },
      },
      ...["up", "down", "pageup", "pagedown", "home", "end"].map((bind) => ({
        bind,
        run: () => {
          if (settings.editingText()) return false as const
          if (editor() === "view") {
            setViewIndex((index) =>
              bind === "home" ? 0 : bind === "end" ? 2 : (index + (bind === "up" || bind === "pageup" ? 2 : 1)) % 3,
            )
            return
          }
          if (editor() === "settings") return settings.move(bind)
          if (editor() === "language") {
            if (customLanguage()) return false as const
            const step = bind === "pageup" ? -5 : bind === "pagedown" ? 5 : bind === "up" ? -1 : 1
            setLanguageIndex((value) =>
              Math.max(
                0,
                Math.min(languages().length, bind === "home" ? 0 : bind === "end" ? languages().length : value + step),
              ),
            )
            languageScroll?.scrollTo(Math.max(0, languageIndex() - 4))
            return
          }
          if (editor() === "version") {
            const step = bind === "pageup" ? -pickerRows() : bind === "pagedown" ? pickerRows() : bind === "up" ? -1 : 1
            setSelected((value) =>
              Math.max(
                0,
                Math.min(
                  matches().length - 1,
                  bind === "home" ? 0 : bind === "end" ? matches().length - 1 : value + step,
                ),
              ),
            )
          } else {
            const target = editor() === "source" || editor() === "prs" ? sourceScroll : reader.scroll()
            if (bind === "home" || bind === "end") target?.scrollTo(bind === "home" ? 0 : Infinity)
            else target?.scrollBy(bind === "up" ? -1 : bind === "down" ? 1 : bind === "pageup" ? -height() : height())
          }
        },
      })),
      {
        bind: "return",
        run: () => {
          if (settings.editingText()) return false as const
          if (editor() === "view") {
            pickView(views[viewIndex()].detail)
            return
          }
          if (editor() === "source") return copySource()
          if (editor() === "prs") return copyPRs()
          if (editor() === "settings") {
            settings.actions()[settings.index() % settings.actions().length]?.run()
            return
          }
          if (editor() === "language") return customLanguage() ? applyLanguage() : selectLanguage()
          if (editor() === "version") {
            const item = matches()[selected()]
            if (item) choose(item)
          } else if (controlsFocused()) actions[action() % actions.length]?.run()
          else context.ui.dialog.clear()
        },
      },
      ...["tab", "shift+tab"].map((bind) => ({
        bind,
        enabled: !editor(),
        run: () => {
          if (!controlsFocused()) {
            setAction(bind === "tab" ? 0 : actions.length - 1)
            setControlsFocused(true)
          } else setAction((value) => (value + (bind === "tab" ? 1 : actions.length - 1)) % actions.length)
        },
      })),
      ...actions.map((item) => ({
        bind: item.key,
        enabled: !editor(),
        title: item.title,
        run: () => {
          item.run()
        },
      })),
      ...views.map((item) => ({
        bind: item.key,
        enabled: !editor() || editor() === "view",
        title: item.title,
        run: () => pickView(item.detail),
      })),
      {
        bind: "c",
        enabled: !editor(),
        title: "Source",
        run: () => setEditor("source"),
      },
      {
        bind: "b",
        enabled: editor() === "source",
        title: "Copy original",
        run: copyOriginal,
      },
      {
        bind: "p",
        enabled: editor() === "source",
        title: "Show PRs",
        run: () => setEditor("prs"),
      },
      ...settings.actions().map((item) => ({
        bind: item.key,
        enabled: editor() === "settings",
        title: item.title,
        run: () => {
          item.run()
        },
      })),
      {
        bind: "r",
        enabled: !editor() && Boolean(reader.error() || reader.personal()?.error),
        title: "Retry",
        run: reader.reload,
      },
      {
        bind: "i",
        enabled: !editor() && reader.level() === "personal" && !service.settings().interests?.trim(),
        title: "Edit interests",
        run: settings.openInterests,
      },
    ],
  }))

  return (
    <box
      ref={(node: BoxRenderable) => (root = node)}
      backgroundColor={theme.background.base}
      height={Math.max(6, dimensions().height - 4)}
    >
      <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2} flexShrink={0}>
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
          {settings.title() ?? `What's new · ${version() ?? ""}`}
        </text>
        <text selectable={false} fg={theme.text.action.secondary.base} onMouseUp={() => context.ui.dialog.clear()}>
          ×
        </text>
      </box>
      <box
        visible={readerVisible()}
        flexDirection="row"
        flexWrap="wrap"
        paddingLeft={2}
        paddingRight={2}
        gap={1}
        flexShrink={0}
      >
        <For each={actions}>
          {(item, index) => {
            const focused = () => controlsFocused() && index() === action() % actions.length && !editor()
            return (
              <box
                ref={(node: BoxRenderable) => {
                  if (item.key === "v") anchors.version = node
                  if (item.key === "l") anchors.language = node
                  if (item.key === "d") anchors.view = node
                }}
                backgroundColor={focused() ? theme.background.action.primary.focused : theme.background.base}
                onMouseUp={(event) => {
                  event.stopPropagation()
                  setControlsFocused(true)
                  setAction(index())
                  item.run()
                }}
              >
                <text selectable={false} fg={focused() ? theme.text.action.primary.focused : theme.text.base}>
                  {actionTitle(item.key, item.title)}
                </text>
              </box>
            )
          }}
        </For>
      </box>
      <box
        visible={Boolean(editor())}
        position={inlinePicker() ? "absolute" : "relative"}
        left={inlinePicker() ? pickerPosition().left : undefined}
        top={inlinePicker() ? pickerPosition().top : undefined}
        width={inlinePicker() ? pickerPosition().width : undefined}
        height={inlinePicker() ? pickerHeight() : undefined}
        zIndex={inlinePicker() ? 10 : undefined}
        onMouseDown={(event) => {
          if (inlinePicker()) event.stopPropagation()
        }}
        border={inlinePicker()}
        borderStyle="single"
        borderColor={theme.text.muted}
        backgroundColor={inlinePicker() ? theme.background.base : undefined}
        paddingLeft={inlinePicker() ? 1 : 2}
        paddingRight={inlinePicker() ? 1 : 2}
        flexShrink={1}
        flexGrow={editor() && !inlinePicker() ? 1 : 0}
        minHeight={0}
      >
        <Show when={editor() === "view"}>
          <For each={views}>
            {(item, index) => (
              <text
                selectable={false}
                fg={index() === viewIndex() ? theme.text.action.primary.focused : theme.text.base}
                bg={index() === viewIndex() ? theme.background.action.primary.focused : theme.background.base}
                onMouseUp={() => pickView(item.detail)}
              >{`${item.key} ${item.title}${item.detail === reader.level() ? " ✓" : ""}`}</text>
            )}
          </For>
        </Show>
        <Show when={editor() === "source"}>
          <scrollbox
            ref={(value: ScrollBoxRenderable) => (sourceScroll = value)}
            maxHeight={height() + 2}
            contentOptions={{ gap: 1 }}
            scrollbarOptions={{ visible: false }}
          >
            <text fg={theme.text.base}>
              {reader.release()?.url.includes("/releases/tag/") ? "Source · GitHub Release" : "Source · CHANGELOG.md"}
            </text>
            <text fg={theme.text.muted} wrapMode="word">
              {`${reader.release()?.date ?? "—"} · ${reader.release()?.prs.length ?? 0} PRs mentioned`}
            </text>
            <text fg={theme.text.action.primary.base} wrapMode="char">
              {reader.release()?.url ?? "Source unavailable"}
            </text>
            <Show when={reader.parsed().error || reader.error() || reader.personal()?.error}>
              <text fg={theme.text.feedback.warning.base} wrapMode="word">
                {reader.parsed().error || reader.error() || reader.personal()?.error}
              </text>
            </Show>
            <text selectable={false} fg={theme.text.action.primary.base} onMouseUp={copySource}>
              Enter · copy link
            </text>
            <text selectable={false} fg={theme.text.action.primary.base} onMouseUp={copyOriginal}>
              b · copy English original
            </text>
            <text selectable={false} fg={theme.text.action.primary.base} onMouseUp={() => setEditor("prs")}>
              p · PRs and links ›
            </text>
          </scrollbox>
        </Show>
        <Show when={editor() === "prs"}>
          <scrollbox
            ref={(value: ScrollBoxRenderable) => (sourceScroll = value)}
            maxHeight={height() + 2}
            contentOptions={{ gap: 1 }}
            scrollbarOptions={{ visible: false }}
          >
            <text fg={theme.text.base}>PRs · original links</text>
            <text selectable={false} fg={theme.text.action.primary.base} onMouseUp={copyPRs}>
              Enter · copy list
            </text>
            <For each={prLinks()}>
              {(pr) => (
                <text
                  selectable={false}
                  fg={theme.text.action.primary.base}
                  wrapMode="char"
                  onMouseUp={() => copyText(pr.url, "PR link copied")}
                >
                  {`#${pr.id} · ${pr.url}`}
                </text>
              )}
            </For>
            <Show when={!prLinks().length}>
              <text fg={theme.text.muted}>No PRs listed</text>
            </Show>
          </scrollbox>
        </Show>
        <Show when={editor() === "settings"}>
          <SettingsList settings={settings} />
        </Show>
        <Show when={editor() === "version"}>
          <box>
            <input
              focused
              value={query()}
              placeholder="Search version or date"
              marginBottom={1}
              textColor={theme.text.formfield.base}
              backgroundColor={theme.background.formfield.base}
              focusedTextColor={theme.text.formfield.focused}
              focusedBackgroundColor={theme.background.formfield.focused}
              onInput={(value) => {
                setQuery(value)
                setSelected(0)
              }}
            />
            <For each={matches().slice(pickerStart(), pickerStart() + pickerRows())}>
              {(item, index) => (
                <text
                  selectable={false}
                  fg={pickerStart() + index() === selected() ? theme.text.action.primary.focused : theme.text.base}
                  bg={
                    pickerStart() + index() === selected()
                      ? theme.background.action.primary.focused
                      : theme.background.base
                  }
                  onMouseUp={() => choose(item)}
                >{`${item.version} · ${item.date}${item.version === service.installed ? " · installed" : ""}${item.version === version() ? " ✓" : ""}`}</text>
              )}
            </For>
            <Show when={!matches().length}>
              <text fg={theme.text.muted}>Version not found</text>
            </Show>
          </box>
        </Show>
        <Show when={editor() === "language"}>
          <box>
            <scrollbox ref={(value: ScrollBoxRenderable) => (languageScroll = value)} maxHeight={5}>
              <For each={languages()}>
                {(item, index) => (
                  <text
                    selectable={false}
                    fg={index() === languageIndex() ? theme.text.action.primary.focused : theme.text.base}
                    bg={index() === languageIndex() ? theme.background.action.primary.focused : theme.background.base}
                    onMouseUp={() => void applyLanguage(item.code)}
                  >{`${item.name} · ${item.code}${service.settings().language === item.code ? " ✓" : ""}`}</text>
                )}
              </For>
            </scrollbox>
            <text
              selectable={false}
              fg={languageIndex() === languages().length ? theme.text.action.primary.focused : theme.text.muted}
              bg={
                languageIndex() === languages().length ? theme.background.action.primary.focused : theme.background.base
              }
              onMouseUp={() => {
                setLanguageIndex(languages().length)
                setCustomLanguage(true)
              }}
            >
              Other language…
            </text>
            <Show when={customLanguage()}>
              <input
                focused
                value={draft()}
                maxLength={80}
                placeholder="BCP 47 tag or language name"
                textColor={theme.text.formfield.base}
                backgroundColor={theme.background.formfield.base}
                focusedTextColor={theme.text.formfield.focused}
                focusedBackgroundColor={theme.background.formfield.focused}
                onInput={setDraft}
              />
              <text selectable={false} fg={theme.text.action.primary.base} onMouseUp={() => void applyLanguage()}>
                Enter · apply language
              </text>
            </Show>
            <Show when={languageSaving()}>
              <text fg={theme.text.muted}>Saving…</text>
            </Show>
            <Show when={languageError()}>
              <text fg={theme.text.feedback.error.base}>{languageError()}</text>
            </Show>
          </box>
        </Show>
        <Show when={settings.editingText()}>
          <TextEditor settings={settings} editor={editor()} />
        </Show>
        <Show when={settings.saving()}>
          <text fg={theme.text.muted}>Saving settings…</text>
        </Show>
        <Show when={settings.error()}>
          <text fg={theme.text.feedback.error.base} wrapMode="none">{`Settings not saved: ${settings.error()}`}</text>
        </Show>
      </box>
      <Show when={readerVisible()}>
        <ChangelogReader
          reader={reader}
          notice={missingNotice()}
          onChooseModel={modelPicker.open}
          onBackdrop={(event) => {
            if (inlinePicker()) {
              event.stopPropagation()
              setEditor(undefined)
            }
          }}
        />
      </Show>
      <box paddingLeft={2} paddingRight={2} flexShrink={0}>
        <Show when={settings.editingText()}>
          <box flexDirection="row" gap={2}>
            <text selectable={false} fg={theme.text.action.primary.base} onMouseUp={() => void settings.submit()}>
              Ctrl+S save
            </text>
            <text selectable={false} fg={theme.text.action.secondary.base} onMouseUp={() => setEditor("settings")}>
              Esc cancel
            </text>
          </box>
        </Show>
        <Show when={!settings.editingText()}>
          <text
            selectable={false}
            fg={
              reader.error() || reader.personal()?.error || reader.parsed().error
                ? theme.text.feedback.warning.base
                : theme.text.muted
            }
            wrapMode="none"
            onMouseUp={() => {
              if (reader.error() || reader.personal()?.error) reader.reload()
              else if (reader.parsed().error) setEditor("source")
            }}
          >
            {editor() === "settings"
              ? "↑/↓ select · Enter open · Esc back"
              : (!editor() && readingStatus()) ||
                (dimensions().width < 80 ? "↑↓ · s settings · esc close" : "↑/↓ scroll · s settings · enter/esc close")}
          </text>
        </Show>
      </box>
    </box>
  )
}
