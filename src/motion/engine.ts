// Animation engine: captures only the reader's own rendered cells, schedules frames and owns cleanup.
// What is painted is delegated to swappable LoadingAnimation / TransitionAnimation objects (see ./index.ts).
// Markdown/layout and the host tree are never rewritten.
import type { Context } from "@opencode/plugin/tui/context"
import { OptimizedBuffer, RGBA } from "@opentui/core"
import { createSignal, getOwner, onCleanup, untrack, type Accessor } from "solid-js"
import {
  random,
  Palette,
  type Canvas,
  type Cell,
  type Entering,
  type Leaving,
  type LoadingAnimation,
  type MotionColors,
  type TransitionAnimation,
  type TransitionFrame,
} from "./kit"

export type BodyRegion = { x: number; y: number; width: number; height: number; scrollTop?: number }
type Phase = "idle" | "waiting" | "reveal"
type Bounds = BodyRegion & { key: string; geometryKey: string }
type Snapshot = {
  buffer: OptimizedBuffer
  cells: Cell[]
  rows: { x: number; y: number; width: number }[]
  readable: Cell[]
  bounds: Bounds
  signature: string
}
type Hidden = { x: number; y: number; bg: RGBA; start: number }

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const TICK_MS = 40
// Start times: random spread skewed early (a tail settles later) with a mild top-to-bottom bias,
// so no diagonal or row wave is visible. Total reveal is about 0.8 s with the bundled transitions.
const REVEAL_SPREAD_MS = 480
const REVEAL_ROW_BIAS = 0.2
const REVEAL_SKEW = 1.3
const REVEAL_LIMIT_MS = 1600

export function createBodyMotion(
  context: Pick<Context, "renderer" | "theme">,
  region: () => BodyRegion | undefined,
  enabled: () => boolean,
  transition: () => TransitionAnimation,
  loading: LoadingAnimation,
): {
  wait(): void
  reveal(update?: () => void): void
  cancel(): void
  dispose(): void
  phase: Accessor<Phase>
  frame: Accessor<number>
  lockedHeight: Accessor<number | undefined>
} {
  const renderer = context.renderer
  const [phase, setPhase] = createSignal<Phase>("idle")
  const [frame, setFrame] = createSignal(0)
  const [lockedHeight, setLockedHeight] = createSignal<number>()
  let old: Snapshot | undefined
  let target: Snapshot | undefined
  let entering: Entering[] = []
  let leaving: Leaving[] = []
  let hidden: Hidden[] = []
  let revealEnd = 0
  let revealSeed = 0
  let revealTransition: TransitionAnimation | undefined
  const palette = new Palette()
  let timer: ReturnType<typeof setTimeout> | undefined
  let installed = false
  let disposed = false
  let waitingStarted = 0
  let revealRequested = 0
  let revealStarted = 0
  let preparationFrames = 0
  let epoch = 0
  let pendingReveal: { update?: () => void; epoch: number; queued: boolean } | undefined

  function bounds(buffer: OptimizedBuffer): Bounds | undefined {
    const rect = region()
    if (!rect || ![rect.x, rect.y, rect.width, rect.height, rect.scrollTop ?? 0].every(Number.isFinite)) return
    const left = Math.max(0, Math.ceil(rect.x))
    const top = Math.max(0, Math.ceil(rect.y))
    const right = Math.min(buffer.width, Math.floor(rect.x + rect.width))
    const bottom = Math.min(buffer.height, Math.floor(rect.y + rect.height))
    if (right <= left || bottom <= top) return
    const geometryKey = [rect.x, rect.y, rect.width, rect.height, buffer.width, buffer.height].join(":")
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      scrollTop: rect.scrollTop,
      geometryKey,
      key: `${geometryKey}:${rect.scrollTop ?? 0}`,
    }
  }

  function releaseSnapshots() {
    old?.buffer.destroy()
    target?.buffer.destroy()
    old = undefined
    target = undefined
    entering = []
    leaving = []
    hidden = []
    palette.clear()
  }

  // Native width lookup costs two FFI calls per grapheme (~100 ms for a full reader); widths never change.
  const widths = new Map<string, number>()
  function glyphWidth(source: OptimizedBuffer, glyph: string): number {
    if (glyph.length === 1) {
      const code = glyph.charCodeAt(0)
      if (code >= 0x20 && code < 0x7f) return 1
    }
    let width = widths.get(glyph)
    if (width !== undefined) return width
    const encoded = source.encodeUnicode(glyph)
    try {
      width = encoded.data.reduce((sum, part) => sum + part.width, 0)
    } finally {
      source.freeUnicode(encoded)
    }
    if (widths.size < 4096) widths.set(glyph, width)
    return width
  }

  function capture(source: OptimizedBuffer, rect: Bounds): Snapshot {
    const buffer = OptimizedBuffer.create(rect.width, rect.height, source.widthMethod, {
      owner: renderer.nativeScene,
      respectAlpha: false,
    })
    try {
      const cells: Cell[] = []
      const lines = source.getSpanLines()
      // 0.6.8 rejects composing a Session source into an owned buffer. Resolve spans instead:
      // no borrowed planes, pooled grapheme IDs or link IDs survive the post-process callback.
      // CapturedSpan retains visual link styling, but does not expose hyperlink destinations.
      for (let y = 0; y < rect.height; y++) {
        let x = 0
        for (const span of lines[rect.y + y]?.spans ?? []) {
          const end = x + span.width
          if (end <= rect.x || x >= rect.x + rect.width) {
            x = end
            continue
          }
          for (const { segment: glyph } of segmenter.segment(span.text)) {
            const width = glyphWidth(source, glyph)
            if (width > 0 && x >= rect.x && x + width <= rect.x + rect.width) {
              const cell: Cell = {
                x: x - rect.x,
                y,
                width,
                glyph,
                fg: span.fg,
                // A transparent space must erase the target glyph during old-frame composition.
                bg: span.bg.a === 0 ? context.theme.surface("dialog").background.base : span.bg,
                attributes: span.attributes,
              }
              cells.push(cell)
              buffer.drawText(glyph, cell.x, y, cell.fg, cell.bg, cell.attributes)
            }
            x += width
          }
          x = end
        }
      }
      return {
        buffer,
        cells,
        rows: rowExtents(cells, rect.height),
        readable: cells.filter((cell) => /[\p{L}\p{N}]/u.test(cell.glyph)),
        bounds: rect,
        signature: JSON.stringify(cells.map((cell) => [cell.x, cell.y, cell.width, cell.glyph])),
      }
    } catch (error) {
      buffer.destroy()
      throw error
    }
  }

  function paintSnapshot(destination: OptimizedBuffer, snapshot: Snapshot) {
    // Compose only complete captured graphemes. A clipped wide glyph at either edge is
    // left to the clean live frame, rather than painting half of it or a neighbouring cell.
    for (const row of snapshot.rows) {
      if (!row.width) continue
      destination.drawFrameBuffer(
        snapshot.bounds.x + row.x,
        snapshot.bounds.y + row.y,
        snapshot.buffer,
        row.x,
        row.y,
        row.width,
        1,
      )
    }
  }

  function paintGlyph(destination: OptimizedBuffer, cell: Cell, glyph: string, rect: Bounds, fg: RGBA = cell.fg) {
    destination.drawText(glyph, rect.x + cell.x, rect.y + cell.y, fg, cell.bg, cell.attributes)
  }

  function colors(): MotionColors {
    const theme = context.theme.surface("dialog")
    // Semantic tokens are `base`/`focused`; a missing optional token must not kill the overlay.
    return { accent: theme.text.action.primary.base, alert: theme.text.feedback?.error?.base, text: theme.text.base }
  }

  function canvas(destination: OptimizedBuffer, rect: Bounds): Canvas {
    return {
      draw: (cell, glyph, fg = cell.fg, bg = cell.bg, attributes = cell.attributes) =>
        destination.drawText(glyph, rect.x + cell.x, rect.y + cell.y, fg, bg, attributes),
    }
  }

  function paintWaiting(destination: OptimizedBuffer, snapshot: Snapshot, now: number) {
    paintSnapshot(destination, snapshot)
    loading.paint({
      canvas: canvas(destination, snapshot.bounds),
      cells: snapshot.readable,
      elapsed: now - waitingStarted,
      colors: colors(),
      palette,
    })
  }

  function prepareReveal(previous: Snapshot, next: Snapshot) {
    const animation = (revealTransition = untrack(transition))
    const width = next.bounds.width
    const height = Math.max(1, next.bounds.height)
    const key = (x: number, y: number) => y * width + x
    const before = new Map(previous.cells.map((cell) => [key(cell.x, cell.y), cell]))
    const stable = (cell: Cell) => {
      const prior = before.get(key(cell.x, cell.y))
      return (
        !!prior &&
        prior.glyph === cell.glyph &&
        prior.width === cell.width &&
        prior.attributes === cell.attributes &&
        prior.fg.equals(cell.fg)
      )
    }
    revealSeed = (Math.random() * 0x7fffffff) | 0
    revealEnd = 0
    const startAt = new Map<number, number>()
    entering = []
    for (const cell of next.cells) {
      if (stable(cell)) continue
      const id = key(cell.x, cell.y)
      const r = random(id, revealSeed, 1) ** REVEAL_SKEW
      const start = Math.round(REVEAL_SPREAD_MS * ((1 - REVEAL_ROW_BIAS) * r + REVEAL_ROW_BIAS * (cell.y / height)))
      for (let offset = 0; offset < cell.width; offset++) startAt.set(id + offset, start)
      const duration = Math.max(0, animation.duration(cell, random(id, revealSeed, 2)))
      entering.push({ cell, start, duration, seed: id })
      revealEnd = Math.max(revealEnd, start + duration)
    }
    const occupied = new Set<number>()
    for (const cell of next.cells)
      for (let offset = 0; offset < cell.width; offset++) occupied.add(key(cell.x, cell.y) + offset)
    hidden = entering.flatMap(({ cell, start }) =>
      Array.from({ length: cell.width }, (_, offset) => ({ x: cell.x + offset, y: cell.y, bg: cell.bg, start })),
    )
    leaving = []
    for (const cell of previous.cells) {
      const id = key(cell.x, cell.y)
      let exit = Infinity
      for (let offset = 0; offset < cell.width; offset++) exit = Math.min(exit, startAt.get(id + offset) ?? Infinity)
      // A stable cell stays drawn by the live frame; an orphaned old cell vanishes at its own random moment.
      if (exit === Infinity) {
        if (occupied.has(id)) continue
        exit = Math.round(random(id, revealSeed, 3) ** REVEAL_SKEW * REVEAL_SPREAD_MS)
      }
      leaving.push({ cell, exit, seed: id })
      revealEnd = Math.max(revealEnd, exit)
    }
  }

  function paintReveal(destination: OptimizedBuffer, rect: Bounds, elapsed: number) {
    const animation = revealTransition!
    for (const cell of hidden) {
      if (elapsed < cell.start) destination.drawText(" ", rect.x + cell.x, rect.y + cell.y, cell.bg, cell.bg, 0)
    }
    const frame: TransitionFrame = { canvas: canvas(destination, rect), colors: colors(), palette, seed: revealSeed }
    for (const item of leaving) if (elapsed < item.exit) animation.leave(frame, item, elapsed)
    for (const item of entering) {
      const local = elapsed - item.start
      if (local >= 0 && local < item.duration) animation.enter(frame, item, local)
    }
  }

  function afterPaint(callback: () => void) {
    const currentEpoch = epoch
    queueMicrotask(() => {
      if (!disposed && currentEpoch === epoch) callback()
    })
  }

  function postProcess(buffer: OptimizedBuffer) {
    untrack(() => {
      if (disposed || phase() === "idle") return
      if (!enabled()) return afterPaint(settle)
      const now = performance.now()
      const rect = bounds(buffer)
      const selection = renderer.getSelection()
      // Core retains an active, empty Selection after a simple click. Protect actual text
      // selections (including word/line clicks) and an ongoing drag, not that inert object.
      const selecting = selection?.isActive && (selection.isDragging || selection.selectedRenderables.length > 0)
      if (!rect || selecting) {
        if (pendingReveal) return afterPaint(settle)
        // Editors and selection never receive an overlay. Re-enter waiting from a clean frame.
        if (phase() === "reveal") return afterPaint(cancel)
        releaseSnapshots()
        afterPaint(() => setLockedHeight(undefined))
        return
      }
      // New content can clamp scrollTop during preparation. Its live viewport becomes the
      // target; only later scrolling invalidates it. Screen geometry must remain unchanged.
      if (
        phase() === "reveal" &&
        (rect.geometryKey !== old?.bounds.geometryKey ||
          (target && rect.key !== target.bounds.key) ||
          now - revealRequested >= REVEAL_LIMIT_MS)
      )
        return afterPaint(cancel)
      try {
        if (phase() === "waiting") {
          // The first native frame can precede Markdown layout. Never pin an empty snapshot
          // over the original for the entire model request; capture again once it is painted.
          if (old?.bounds.key !== rect.key || !old.readable.length) {
            releaseSnapshots()
            old = capture(buffer, rect)
            const height = region()?.height
            afterPaint(() => setLockedHeight(height))
          }
          if (pendingReveal && !pendingReveal.queued) {
            const pending = pendingReveal
            pending.queued = true
            // Solid/layout updates are forbidden inside native paint, including after a borrowed scope.
            queueMicrotask(() => {
              if (disposed || pending.epoch !== epoch || pendingReveal !== pending) return
              pendingReveal = undefined
              if (!untrack(enabled)) {
                cancel()
                pending.update?.()
                return
              }
              pending.update?.()
              if (!disposed && pending.epoch === epoch) beginReveal()
            })
            paintSnapshot(buffer, old!)
            return
          }
          if (old) paintWaiting(buffer, old, now)
          return
        }
        if (!old) return afterPaint(cancel)
        if (preparationFrames > 0) {
          preparationFrames--
          // Layout settles within a frame or two; render them back to back instead of one timer tick apart.
          afterPaint(() => renderer.requestRender())
          if (preparationFrames === 0) {
            target = capture(buffer, rect)
            if (target.signature === old.signature) return afterPaint(cancel)
            prepareReveal(old, target)
            if (!entering.length && !leaving.length) return afterPaint(cancel)
            revealStarted = now
          }
          paintSnapshot(buffer, old)
          return
        }
        if (!target) return afterPaint(cancel)
        const elapsed = now - revealStarted
        if (elapsed >= revealEnd) return afterPaint(cancel)
        paintReveal(buffer, rect, elapsed)
      } catch {
        // Rendering/teardown failure must leave the host's unmodified final frame, never a frozen overlay.
        afterPaint(settle)
      }
    })
  }

  function schedule() {
    if (timer !== undefined || disposed || phase() === "idle") return
    timer = setTimeout(
      () => {
        timer = undefined
        if (disposed || phase() === "idle") return
        if (renderer.isDestroyed) return cancel()
        if (!untrack(enabled)) return settle()
        setFrame((value) => value + 1)
        renderer.requestRender()
        schedule()
      },
      phase() === "waiting" ? loading.tickMs : TICK_MS,
    )
  }

  function install() {
    if (!installed) {
      renderer.addPostProcessFn(postProcess)
      installed = true
    }
    renderer.requestRender()
    schedule()
  }

  function cancel() {
    epoch++
    pendingReveal = undefined
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (installed) renderer.removePostProcessFn(postProcess)
    installed = false
    releaseSnapshots()
    preparationFrames = 0
    setLockedHeight(undefined)
    setPhase("idle")
    if (!renderer.isDestroyed) renderer.requestRender()
  }

  // Skipping a visual effect must not discard a completed model response.
  // Explicit cancellation/disposal still drops callbacks; these fallback paths apply the guarded result.
  function settle() {
    const update = pendingReveal?.update
    cancel()
    update?.()
  }

  function wait() {
    if (disposed || untrack(phase) === "waiting") return
    cancel()
    if (!untrack(enabled) || renderer.isDestroyed) return
    waitingStarted = performance.now()
    setFrame(0)
    setPhase("waiting")
    install()
  }

  function beginReveal() {
    if (!old) return cancel()
    revealRequested = performance.now()
    preparationFrames = 2
    setPhase("reveal")
    install()
  }

  function reveal(update?: () => void) {
    if (disposed) return
    if (untrack(phase) !== "waiting" || !untrack(enabled)) {
      cancel()
      update?.()
      return
    }
    if (!old) {
      pendingReveal = { update, epoch, queued: false }
      install()
      return
    }
    pendingReveal = undefined
    const currentEpoch = epoch
    update?.()
    if (!disposed && currentEpoch === epoch) beginReveal()
  }

  function dispose() {
    if (disposed) return
    disposed = true
    cancel()
    renderer.off("destroy", dispose)
  }

  renderer.on("destroy", dispose)
  if (getOwner()) onCleanup(dispose)
  return { wait, reveal, cancel, dispose, phase, frame, lockedHeight }
}

function rowExtents(cells: readonly Cell[], height: number): Snapshot["rows"] {
  const rows = Array.from({ length: height }, (_, y) => ({ x: 0, y, width: 0, end: -1 }))
  for (const cell of cells) {
    const row = rows[cell.y]!
    if (row.end < 0) row.x = cell.x
    row.end = cell.x + cell.width
  }
  return rows.map(({ x, y, end }) => ({ x, y, width: end < 0 ? 0 : end - x }))
}
