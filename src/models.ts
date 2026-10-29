// Model inventory and conservative eligibility checks for the changelog's free-model picker.
import type { OpenCodeClient, ModelInfo } from "@opencode/client"

export type ModelRef = { providerID: string; id: string; variant?: string }

// model.list uses the default location, so a project-specific inventory may differ from global generate resolution.
export async function loadModels(client: Pick<OpenCodeClient, "model">, signal: AbortSignal): Promise<ModelInfo[]> {
  const output = await client.model.list(undefined, { signal })
  return output.data.filter(
    (model) => model.enabled && model.status !== "deprecated" && model.capabilities.output.includes("text"),
  )
}

export function isFree(model: ModelInfo): boolean {
  return (
    model.providerID === "opencode" &&
    model.id.endsWith("-free") &&
    model.enabled &&
    model.status !== "deprecated" &&
    model.capabilities.output.includes("text") &&
    model.cost.length > 0 &&
    model.cost.every((tier) => tier.input === 0 && tier.output === 0 && tier.cache.read === 0 && tier.cache.write === 0)
  )
}

const PREFERRED_FREE_IDS = ["glm-5.3-flash-free", "deepseek-v4.1-flash-free"]

/** Missing entries and stale *-free routes may rotate; an explicitly chosen paid model must not be silently replaced. */
export function assertFreeSelection(models: ModelInfo[], selected?: ModelRef) {
  if (
    selected &&
    !(selected.providerID === "opencode" && selected.id.endsWith("-free")) &&
    models.some((model) => model.providerID === selected.providerID && model.id === selected.id && !isFree(model))
  )
    throw new Error("The selected model is not free, but free-only mode is on")
}

export function freeCandidates(models: ModelInfo[], preferred?: ModelRef): ModelRef[] {
  const candidates = models.filter(isFree)
  const ordered = candidates.sort((left, right) => {
    const rank = (model: ModelInfo) => {
      if (preferred && model.providerID === preferred.providerID && model.id === preferred.id) return -1
      const index = PREFERRED_FREE_IDS.indexOf(model.id)
      return index < 0 ? PREFERRED_FREE_IDS.length : index
    }
    return (
      rank(left) - rank(right) || left.id.localeCompare(right.id) || left.providerID.localeCompare(right.providerID)
    )
  })
  return ordered.map((model) => {
    const result: ModelRef = { providerID: model.providerID, id: model.id }
    if (preferred?.providerID === model.providerID && preferred.id === model.id && preferred.variant === undefined) {
      return result
    }
    const supportedVariant = model.variants.find((item) => item.id === preferred?.variant)?.id
    const variant =
      preferred?.providerID === model.providerID && preferred.id === model.id && supportedVariant
        ? supportedVariant
        : model.variants.find((item) => item.id === "low")?.id
    if (variant) result.variant = variant
    return result
  })
}

export function modelKey(model: ModelRef): string {
  return `${model.providerID}/${model.id}`
}

export function errorMessage(error: unknown, depth = 0): string {
  if (depth > 4) return ""
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null) {
    const value = error as { message?: unknown; cause?: unknown; data?: unknown }
    const parts = [value.message, value.data, value.cause].map((item) => errorMessage(item, depth + 1)).filter(Boolean)
    return parts.join(" ")
  }
  return ""
}

export function canRotateFree(error: unknown): boolean {
  const message = errorMessage(error)
  if (
    !message ||
    /free tier can only be used from within opencode|free models work in opencode|free usage limit reached/i.test(
      message,
    )
  )
    return false
  if (
    /rate limit|too many requests|abort(?:ed|error)?|cancel(?:led|ed)?|unauthori[sz]ed|forbidden|\b(?:401|403|429)\b|\b(?:network|fetch|timeout|timed out|temporar(?:y|ily)|overload)\b/i.test(
      message,
    )
  ) {
    return false
  }
  return /(?:model|provider)[^\n]{0,100}(?:not found|unavailable|disabled|unsupported|no longer available)|(?:free|quota|usage)[^\n]{0,100}(?:limit|exhausted|expired|depleted|unavailable|ended)|no longer free|(?:limit|quota)[^\n]{0,100}(?:free|model|provider)/i.test(
    message,
  )
}
