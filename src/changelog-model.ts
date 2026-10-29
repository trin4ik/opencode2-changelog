// Translator model choice through the host's dialog.select (search, categories, favorites action).
// A select replaces the changelog window, so the window is opened again on the same version afterwards.
import type { ModelInfo } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import { createEffect, createResource, createSignal, onCleanup } from "solid-js"
import type { ChangelogService } from "./changelog-service"
import { errorMessage, freeCandidates, isFree, loadModels, modelKey, type ModelRef } from "./models"

type Picked = { model: ModelRef; freeOnly: boolean }

export function createModelPicker(service: ChangelogService, version: () => string | undefined) {
  const context = usePlugin()
  const [requests, setRequests] = createSignal<number>()
  let controller: AbortController | undefined
  onCleanup(() => controller?.abort())
  // An undefined source skips the fetch: the catalogue is loaded only after the user asks for it.
  const [inventory] = createResource(requests, () => {
    controller?.abort()
    const current = (controller = new AbortController())
    return loadModels(context.client, current.signal).catch((cause) => {
      if (current.signal.aborted) return
      context.ui.toast.show({ message: `Could not load models: ${errorMessage(cause)}`, variant: "error" })
    })
  })

  let shown: ModelInfo[] | undefined
  createEffect(() => {
    const models = inventory()
    if (!models || models === shown) return
    shown = models
    const reopen = version()
    void pick(models)
      .then((picked) => picked && service.updateSettings(picked))
      .catch((cause) =>
        context.ui.toast.show({ message: `Model choice not saved: ${errorMessage(cause)}`, variant: "error" }),
      )
      .then(() => service.open(reopen))
  })

  async function pick(models: ModelInfo[]): Promise<Picked | undefined> {
    const current = service.settings().model
    const currentKey = current && modelKey(current)
    let focus = currentKey
    while (true) {
      let toggled = false
      const key = await context.ui.dialog.select({
        title: "Select model",
        placeholder: "Search models",
        current: focus,
        options: modelOptions(models, service.recent(), service.favorites()).map((option) => ({
          ...option,
          footer:
            [option.footer, option.value === currentKey && focus !== currentKey ? "current" : undefined]
              .filter(Boolean)
              .join(" ") || undefined,
        })),
        actions: [
          {
            bind: "ctrl+f",
            title: "Favorites",
            selection: "required",
            onTrigger(value) {
              toggled = true
              focus = value
              const model = models.find((item) => modelKey(item) === value)!
              // The options are static: closing the dialog settles select(), and the loop shows it again.
              void service
                .toggleFavorite({ providerID: model.providerID, id: model.id })
                .catch((cause) =>
                  context.ui.toast.show({ message: `Not saved: ${errorMessage(cause)}`, variant: "error" }),
                )
                .then(() => context.ui.dialog.clear())
            },
          },
        ],
      })
      if (toggled) continue
      const model = models.find((item) => modelKey(item) === key)
      if (!model) return
      const ref: ModelRef = { providerID: model.providerID, id: model.id }
      if (!model.variants.length) return { model: ref, freeOnly: isFree(model) }
      const variant = await context.ui.dialog.select({
        title: `Select variant · ${model.name}`,
        current: preferredVariant(models, model, current),
        options: ["default", ...model.variants.map((item) => item.id).filter((id) => id !== "default")].map((id) => ({
          title: id,
          value: id,
        })),
      })
      if (variant === undefined) {
        focus = key
        continue
      }
      if (variant !== "default") ref.variant = variant
      return { model: ref, freeOnly: isFree(model) }
    }
  }

  return { open: () => setRequests((value) => (value ?? 0) + 1), loading: () => inventory.loading }
}

function modelOptions(models: ModelInfo[], recent: ModelRef[], favorites: ModelRef[]) {
  const used = new Set<string>()
  const add = (model: ModelInfo | undefined, category: string) => {
    if (!model || used.has(modelKey(model))) return []
    used.add(modelKey(model))
    return [
      {
        title: model.name,
        value: modelKey(model),
        description: model.providerID,
        footer: isFree(model) ? "Free" : undefined,
        category,
      },
    ]
  }
  const find = (ref: ModelRef) => models.find((model) => modelKey(model) === modelKey(ref))
  return [
    ...favorites.flatMap((ref) => add(find(ref), "Favorites")),
    ...recent.flatMap((ref) => add(find(ref), "Recent")),
    ...models
      .toSorted(
        (a, b) =>
          Number(b.providerID === "opencode-go") - Number(a.providerID === "opencode-go") ||
          Number(b.providerID === "opencode") - Number(a.providerID === "opencode") ||
          a.providerID.localeCompare(b.providerID) ||
          Number(isFree(b)) - Number(isFree(a)),
      )
      .flatMap((model) => add(model, model.providerID === "opencode" && isFree(model) ? "Free" : model.providerID)),
  ]
}

// The saved variant of the same model wins; a free model otherwise starts on its cheapest candidate (usually low).
function preferredVariant(models: ModelInfo[], model: ModelInfo, current?: ModelRef) {
  if (current && modelKey(current) === modelKey(model)) return current.variant ?? "default"
  if (!isFree(model)) return "default"
  return freeCandidates(models, current).find((ref) => modelKey(ref) === modelKey(model))?.variant ?? "default"
}
