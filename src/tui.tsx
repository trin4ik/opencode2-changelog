// CLI-only changelog browser. Source notes are cached durably; network access starts only on user open.
import { Plugin, PluginContextProvider, usePlugin } from "@opencode/plugin/tui"
import { createResource, onCleanup, onMount, Show } from "solid-js"
import { ChangelogDialog } from "./changelog-dialog"
import { createChangelogService, isFresh, type ChangelogService } from "./changelog-service"
import { compareVersions } from "./releases"

// The host opens its own highlights once after an update, asynchronously after plugins are ready. Opening a little
// later replaces that dialog (`dialog.show` replaces the stack) instead of being replaced by it.
const OPEN_ON_UPDATE_DELAY_MS = 1500

export default Plugin.define({
  id: "trin4ik.changelog",
  setup(context) {
    const service = createChangelogService(context, (version) => show(context, service, version))
    context.ui.slot({ append: "app", render: () => <Commands context={context} service={service} /> })
    return service.dispose
  },
})

function show(context: Plugin.Context, service: ChangelogService, initialVersion?: string) {
  context.ui.dialog.show(() => (
    <PluginContextProvider value={context}>
      <ChangelogLoader service={service} initialVersion={initialVersion} />
    </PluginContextProvider>
  ))
}

function Commands(props: { context: Plugin.Context; service: ChangelogService }) {
  openOnUpdate(props.context, props.service)
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "trin4ik.changelog.open",
        title: "Changelog — release history",
        group: "Changelog",
        palette: true,
        slash: { name: "changelog", arguments: true },
        run(input) {
          const requested = input?.trim().replace(/^v/, "") || undefined
          if (requested && !/^2\.\d+\.\d+$/.test(requested)) {
            props.context.ui.toast.show({ message: "Enter a V2 version: /changelog 2.1.4", variant: "warning" })
            return
          }
          props.service.open(requested)
        },
      },
    ],
  }))
  return null
}

/** Opens the notes of a freshly updated OpenCode once, like the host's own highlights; `openOnUpdate: false` opts out. */
function openOnUpdate(context: Plugin.Context, service: ChangelogService) {
  const installed = service.installed
  if (context.options.openOnUpdate === false || !installed) return
  const [state, update] = context.storage.store<{ seen?: string }>("launch.v1", { initial: {} })
  // First run records the version silently; only a newer stable version than the one seen opens the window.
  const due = (seen?: string) => !!seen && compareVersions(installed, seen) > 0
  let timer: ReturnType<typeof setTimeout> | undefined
  onMount(() => {
    if (state.seen && !due(state.seen)) return
    timer = setTimeout(async () => {
      let show = false
      // Decided inside the locked update, so only one of several TUIs starting together opens it.
      await update((draft) => {
        show = due(draft.seen)
        if (!draft.seen || show) draft.seen = installed
      }).catch(() => {})
      if (show && context.ui.router.current().type === "home") service.open(installed)
    }, OPEN_ON_UPDATE_DELAY_MS)
  })
  onCleanup(() => clearTimeout(timer))
}

function ChangelogLoader(props: { service: ChangelogService; initialVersion?: string }) {
  const context = usePlugin()
  const cached = props.service.cached()
  const wanted = [props.initialVersion, props.service.installed]
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  // createResource does not cancel by itself: the controller above aborts the shared request on close.
  // A fresh cache skips the fetch (source false); a stale one is shown while the warm refresh runs.
  const [loaded, { refetch }] = createResource(
    () => !cached || !isFresh(cached, wanted),
    () =>
      props.service.load(controller.signal, !!cached, wanted).catch((reason) => {
        if (controller.signal.aborted || !cached) throw reason
        // Stale notes stay readable, but must not pass silently for the current list.
        context.ui.toast.show({
          message: `Could not refresh the version list, showing the saved copy: ${reason instanceof Error ? reason.message : String(reason)}`,
          variant: "warning",
        })
        return cached
      }),
    { initialValue: cached },
  )
  context.keymap.layer(() => ({
    mode: "modal",
    commands: [{ bind: "r", title: "Retry loading", enabled: Boolean(loaded.error), run: () => void refetch() }],
  }))
  const theme = context.theme.surface("dialog")
  context.ui.dialog.set({ size: "large", centered: true })
  return (
    <Show
      when={loaded.error ? undefined : loaded()}
      fallback={
        <box paddingX={4} paddingBottom={1} gap={1}>
          <text fg={theme.text.base}>
            <b>Changelog</b>
          </text>
          <Show when={loaded.error} fallback={<text fg={theme.text.muted}>Loading release history…</text>}>
            <text fg={theme.text.feedback.error.base} wrapMode="word">
              {String(loaded.error instanceof Error ? loaded.error.message : loaded.error)}
            </text>
            <text fg={theme.text.action.primary.base} onMouseUp={() => void refetch()}>
              r · Retry
            </text>
          </Show>
          <text fg={theme.text.action.secondary.base} onMouseUp={() => context.ui.dialog.clear()}>
            esc · close
          </text>
        </box>
      }
    >
      {(items) => (
        <ChangelogDialog
          service={props.service}
          releases={items().releases}
          latest={items().latest}
          initialVersion={props.initialVersion}
        />
      )}
    </Show>
  )
}
