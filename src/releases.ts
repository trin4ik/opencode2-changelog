/** Loads and parses the upstream OpenCode V2 release notes for the changelog panel. */
import { createHash } from "node:crypto"

export type Release = {
  version: string
  date: string
  markdown: string
  highlights: string
  url: string
  hash: string
  prs: number[]
}

/** A source-preserving unit available to the personal release selection. */
export type ReleaseItem = {
  id: string
  markdown: string
  sectionPath: string[]
  highlight: boolean
  mandatory: boolean
}

/** Notes for a version missing from `dev`, taken from its release tag or GitHub Release. */
export type ExtraRelease = { version: string; date: string; markdown: string; url: string }

/** Everything fetched from upstream; `latest` is the newest V2 release tag, when it could be determined. */
export type ChangelogSource = {
  markdown: string
  extra: ExtraRelease[]
  latest?: string
  /** Versions looked up beyond `dev`; one still missing afterwards is genuinely unpublished for now. */
  checked?: string[]
}

const REPOSITORY = "anomalyco/opencode"
export const SOURCE_URL = `https://raw.githubusercontent.com/${REPOSITORY}/dev/CHANGELOG.md`
const TAGS_URL = `https://api.github.com/repos/${REPOSITORY}/git/matching-refs/tags/v2.`
// The endpoint OpenCode's own updater (`/update`, install script) reads; npm is its distribution channel.
const UPDATER_URL = "https://opencode.ai/update/api/latest/cli/npm"
const NPM_LATEST_URL = "https://registry.npmjs.org/@opencode%2Fcli/latest"
const tagChangelogUrl = (version: string) => `https://raw.githubusercontent.com/${REPOSITORY}/v${version}/CHANGELOG.md`
const releaseApiUrl = (version: string) => `https://api.github.com/repos/${REPOSITORY}/releases/tags/v${version}`
export const SOURCE_PAGE_PREFIX = `https://github.com/${REPOSITORY}/`

const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 20_000
// Release discovery is an addition to the dev changelog: a slow GitHub API must not block the notes.
const EXTRA_TIMEOUT_MS = 10_000
const RELEASE_HEADING = /^##\s+v?(\d+\.\d+\.\d+)\s+[—–-]\s+(\d{4}-\d{2}-\d{2})\s*$/gm
const PR_URL = /\]\(https:\/\/github\.com\/anomalyco\/opencode\/pull\/(\d+)\)/g
export const V2_VERSION = /^2\.\d+\.\d+$/

/** Numeric x.y.z comparison: "2.10.0" is newer than "2.9.9". */
export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number)
  const b = right.split(".").map(Number)
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0)
  return 0
}

function createRelease(version: string, date: string, markdown: string, url: string): Release {
  const section = markdown.replace(/\r\n?/g, "\n").trim()
  const highlightsHeading = /^###\s+Highlights\s*$/m.exec(section)
  let highlights = ""
  if (highlightsHeading) {
    const contentStart = highlightsHeading.index + highlightsHeading[0].length
    const nextHeading = /^###\s+/m.exec(section.slice(contentStart))
    highlights = section.slice(contentStart, nextHeading ? contentStart + nextHeading.index : undefined).trim()
  }
  return {
    version,
    date,
    markdown: section,
    highlights,
    url,
    hash: createHash("sha256").update(section).digest("hex"),
    prs: [...new Set([...section.matchAll(PR_URL)].map((match) => Number(match[1])))],
  }
}

/** Parse a CHANGELOG.md taken at `ref` (a branch or tag); releases are returned newest first. */
export function parseChangelog(markdown: string, ref = "dev"): Release[] {
  if (!markdown.trim() || !/^#\s+Changelog\s*$/m.test(markdown)) {
    throw new Error("Invalid changelog source: missing Changelog heading")
  }

  const headings = [...markdown.matchAll(RELEASE_HEADING)]
  const releases = new Map<string, Release>()

  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]
    const version = heading[1]
    const date = heading[2]
    if (!version.startsWith("2.") || releases.has(version)) continue

    const start = heading.index! + heading[0].length
    const end = headings[index + 1]?.index ?? markdown.length
    const section = markdown.slice(start, end).trim()
    if (!section) continue

    const anchor = `v${version.replaceAll(".", "")}--${date}`
    releases.set(
      version,
      createRelease(version, date, section, `https://github.com/${REPOSITORY}/blob/${ref}/CHANGELOG.md#${anchor}`),
    )
  }

  if (releases.size === 0) throw new Error("Invalid changelog source: no V2 releases found")
  return [...releases.values()].sort((left, right) => compareVersions(right.version, left.version))
}

/** The dev changelog plus versions it does not have yet; dev wins for versions present in both. */
export function buildReleases(source: ChangelogSource): Release[] {
  const releases = new Map(parseChangelog(source.markdown).map((release) => [release.version, release]))
  for (const extra of source.extra) {
    if (!releases.has(extra.version))
      releases.set(extra.version, createRelease(extra.version, extra.date, extra.markdown, extra.url))
  }
  return [...releases.values()].sort((left, right) => compareVersions(right.version, left.version))
}

/** Parse meaningful Markdown blocks without treating headings or list markers in fences as structure. */
export function releaseItems(release: Release): ReleaseItem[] {
  const lines = release.markdown.replace(/\r\n?/g, "\n").split("\n")
  const items: Omit<ReleaseItem, "id">[] = []
  let path: string[] = []
  let block: string[] = []
  let fence: { char: string; length: number } | undefined
  let malformedFence = false
  let currentHighlight = false
  let listIndent: number | undefined

  const save = () => {
    const markdown = block.join("\n").trim()
    block = []
    listIndent = undefined
    if (!markdown) return
    const explicitRisk =
      /\b(?:CVE-\d{4}-\d{4,}|\bsecurity\b|\bvulnerabilit\w*\b|\bexploit\w*\b|\bcritical\s+(?:bug|issue|fix)\b)/i.test(
        markdown,
      )
    const sectionRisk = path.some((part) => /^(?:breaking changes|security(?:\b|$))/i.test(part))
    items.push({
      markdown,
      sectionPath: [...path],
      highlight: currentHighlight,
      mandatory: sectionRisk || explicitRisk,
    })
  }

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      block.push(line)
      const close =
        fenceMatch &&
        fenceMatch[1][0] === fence.char &&
        fenceMatch[1].length >= fence.length &&
        /^\s*$/.test(line.slice(fenceMatch[0].length))
      if (close) fence = undefined
      continue
    }
    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length }
      block.push(line)
      continue
    }

    const heading = /^(#{2,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      save()
      // GitHub bodies can start at ## or skip parents: promote orphan headings without losing their text.
      const depth = Math.min(Math.max(0, heading[1].length - 3), path.length)
      path = [...path.slice(0, depth), heading[2]]
      currentHighlight = /^highlights$/i.test(path[0])
      continue
    }

    if (!line.trim()) {
      // Blank lines separate prose/table blocks, but are retained within a list item.
      if (block.length && listIndent !== undefined) block.push(line)
      else save()
      continue
    }

    const bullet = /^(\s*)(?:[-+*]|\d+[.)])\s/.exec(line)
    if (bullet && (listIndent === undefined || bullet[1].length <= listIndent)) {
      if (block.length) save()
      listIndent = bullet[1].length
    } else if (listIndent !== undefined && !/^\s/.test(line) && block.at(-1)?.trim() === "") {
      save()
    }
    block.push(line)
  }
  if (fence) malformedFence = true
  save()
  if (malformedFence)
    throw new Error(`Cannot build personal selection for ${release.version}: unclosed fenced code block`)

  const counts = new Map<string, number>()
  return items.map((item) => {
    const content = `${JSON.stringify(item.sectionPath)}\n${item.markdown}`
    const ordinal = counts.get(content) ?? 0
    counts.set(content, ordinal + 1)
    const id = createHash("sha256").update(`${content}\n${ordinal}`).digest("hex").slice(0, 16)
    return { ...item, id }
  })
}

/** Render selected source blocks in source order, restoring section headings as needed. */
export function renderItems(items: ReleaseItem[], ids: readonly string[]): string {
  const byId = new Map(items.map((item) => [item.id, item]))
  for (const id of ids) if (!byId.has(id)) throw new Error(`Unknown release item ID: ${id}`)
  const requested = new Set(ids)
  const selected = items.filter((item) => requested.has(item.id))
  const output: string[] = []
  let previous: string[] = []
  for (const item of selected) {
    let common = 0
    while (
      common < previous.length &&
      common < item.sectionPath.length &&
      previous[common] === item.sectionPath[common]
    )
      common++
    for (let index = common; index < item.sectionPath.length; index++) {
      output.push(`${"#".repeat(index + 3)} ${item.sectionPath[index]}`)
    }
    output.push(item.markdown)
    previous = item.sectionPath
  }
  return output.join("\n\n")
}

export function mainItems(items: ReleaseItem[]): ReleaseItem[] {
  return items.filter((item) => item.highlight || item.mandatory)
}

export function candidateItems(items: ReleaseItem[]): ReleaseItem[] {
  const main = mainItems(items)
  const mainMarkdown = new Set(main.map((item) => item.markdown))
  return items.filter((item) => !item.highlight && !item.mandatory && !mainMarkdown.has(item.markdown))
}

/** Bounded UTF-8 download; the caller's signal owns cancellation and its own timeout. */
async function fetchText(url: string, signal: AbortSignal, accept?: string): Promise<string> {
  const response = await fetch(url, { signal, headers: accept ? { accept } : undefined })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`Changelog request failed: HTTP ${response.status} ${response.statusText} (${url})`)
  }
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new Error("Changelog source exceeds the 2 MiB limit")
  }
  if (!response.body) throw new Error("Changelog response has no body")

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_SOURCE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error("Changelog source exceeds the 2 MiB limit")
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error("Invalid changelog source: response is not valid UTF-8")
  }
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  return JSON.parse(
    await fetchText(
      url,
      signal,
      url.startsWith("https://api.github.com/") ? "application/vnd.github+json" : "application/json",
    ),
  )
}

/** A plain x.y.z V2 version from a `{ version }` JSON document. */
async function versionField(url: string, signal: AbortSignal): Promise<string | undefined> {
  const version = ((await fetchJson(url, signal)) as { version?: unknown } | null)?.version
  return typeof version === "string" && V2_VERSION.test(version) ? version : undefined
}

/** Newest plain x.y.z V2 tag. Tags are pushed by the release workflow, so this is what the updater offers. */
async function latestTag(signal: AbortSignal): Promise<string | undefined> {
  const refs = await fetchJson(TAGS_URL, signal)
  if (!Array.isArray(refs)) throw new Error("Unexpected GitHub tags response")
  return refs
    .flatMap((item) => {
      const match = /^refs\/tags\/v(\d+\.\d+\.\d+)$/.exec((item as { ref?: unknown })?.ref as string)
      return match && V2_VERSION.test(match[1]) ? [match[1]] : []
    })
    .sort((left, right) => compareVersions(right, left))[0]
}

/** The published GitHub Release body; upstream fills it with the same Markdown section as CHANGELOG.md. */
async function releaseNotes(version: string, signal: AbortSignal): Promise<ExtraRelease | undefined> {
  const value = (await fetchJson(releaseApiUrl(version), signal)) as Record<string, unknown> | null
  if (
    !value ||
    value.tag_name !== `v${version}` ||
    value.draft !== false ||
    value.prerelease !== false ||
    typeof value.body !== "string" ||
    !value.body.trim() ||
    typeof value.published_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value.published_at) ||
    typeof value.html_url !== "string" ||
    !value.html_url.startsWith(SOURCE_PAGE_PREFIX)
  )
    return
  return { version, date: value.published_at.slice(0, 10), markdown: value.body, url: value.html_url }
}

/**
 * `dev` CHANGELOG.md holds the full history but may lag behind a fresh release (2.2.1 was tagged and
 * published while dev still ended at 2.2.0). The tag's own CHANGELOG.md sometimes lacks its own section
 * (2.1.4 ended at 2.1.3), and some versions have no GitHub Release (2.1.4). So the newest tag is checked
 * and missing versions are filled from its CHANGELOG.md, then from its GitHub Release.
 * Only `dev` is required: GitHub API rate limits or outages leave `latest` unknown, not the notes broken.
 */
export async function loadChangelog(
  signal?: AbortSignal,
  wanted: readonly (string | undefined)[] = [],
): Promise<ChangelogSource & { releases: Release[] }> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError")

  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(signal?.reason)
  signal?.addEventListener("abort", abortFromCaller, { once: true })
  const within = (ms: number) => AbortSignal.any([controller.signal, AbortSignal.timeout(ms)])
  const optional = async <T>(run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run()
    } catch (error) {
      if (controller.signal.aborted) throw error
      return undefined
    }
  }

  try {
    let markdown: string
    try {
      markdown = await fetchText(SOURCE_URL, within(REQUEST_TIMEOUT_MS))
    } catch (error) {
      if (!controller.signal.aborted && error instanceof DOMException && error.name === "TimeoutError")
        throw new Error("Changelog request timed out after 20 seconds")
      throw error
    }
    const base = parseChangelog(markdown)
    const extra: ExtraRelease[] = []
    const known = () => new Set([...base, ...extra].map((release) => release.version))
    // The same answer `/update` gets; GitHub's API (60 requests/hour per IP) is only the last resort.
    let latest: string | undefined
    for (const lookup of [
      () => versionField(UPDATER_URL, within(EXTRA_TIMEOUT_MS)),
      () => versionField(NPM_LATEST_URL, within(EXTRA_TIMEOUT_MS)),
      () => latestTag(within(EXTRA_TIMEOUT_MS)),
    ]) {
      latest = await optional(lookup)
      if (latest) break
    }

    // Newest first: one tag's CHANGELOG.md usually covers the older missing versions too.
    const targets = [...new Set([latest, ...wanted])]
      .filter((version): version is string => !!version && V2_VERSION.test(version))
      .sort((left, right) => compareVersions(right, left))
    for (const target of targets) {
      if (known().has(target)) continue
      const tagged = await optional(async () =>
        parseChangelog(await fetchText(tagChangelogUrl(target), within(EXTRA_TIMEOUT_MS)), `v${target}`),
      )
      for (const release of tagged ?? []) {
        if (!known().has(release.version) && compareVersions(release.version, target) <= 0) {
          const { version, date, markdown, url } = release
          extra.push({ version, date, markdown, url })
        }
      }
      if (known().has(target)) continue
      const published = await optional(() => releaseNotes(target, within(EXTRA_TIMEOUT_MS)))
      if (published) extra.push(published)
    }

    const source = { markdown, extra, latest, checked: targets }
    return { ...source, releases: buildReleases(source) }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError")
    throw error
  } finally {
    signal?.removeEventListener("abort", abortFromCaller)
  }
}

export async function loadReleases(signal?: AbortSignal): Promise<Release[]> {
  return (await loadChangelog(signal)).releases
}

// Presentation only: retain PR labels without terminal Markdown's noisy URL expansion.
// Deliberately narrow: canonical links only; fenced/inline/indented code and escaped syntax stay byte-for-byte intact.
export function readableNotes(markdown: string): string {
  let fence: { marker: string; length: number } | undefined
  let inline = 0
  return markdown
    .split(/(?<=\n)/)
    .map((line) => {
      const boundary = /^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$/.exec(line)
      if (fence) {
        if (boundary && boundary[1][0] === fence.marker && boundary[1].length >= fence.length && !boundary[2].trim())
          fence = undefined
        return line
      }
      if (boundary && (boundary[1][0] !== "`" || !boundary[2].includes("`"))) {
        fence = { marker: boundary[1][0], length: boundary[1].length }
        inline = 0
        return line
      }
      if (/^(?: {4}|\t)/.test(line)) return line
      let result = ""
      for (let index = 0; index < line.length; ) {
        const char = line[index]
        if (!inline && char === "\\") {
          result += line.slice(index, index + 2)
          index += 2
          continue
        }
        if (char === "`") {
          let end = index + 1
          while (line[end] === "`") end++
          const count = end - index
          if (!inline) inline = count
          else if (inline === count) inline = 0
          result += line.slice(index, end)
          index = end
          continue
        }
        if (!inline && char === "[" && line[index - 1] !== "!") {
          const link = /^\[(#([1-9]\d*))\]\(https:\/\/github\.com\/anomalyco\/opencode\/pull\/\2\)/.exec(
            line.slice(index),
          )
          if (link) {
            result += link[1]
            index += link[0].length
            continue
          }
        }
        result += char
        index++
      }
      return result
    })
    .join("")
}
