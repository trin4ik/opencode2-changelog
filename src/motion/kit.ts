// Contracts and helpers for swappable reader animations. The engine owns capture, timing and cleanup;
// an animation only decides what to paint in a cell at a given moment.
import { RGBA } from "@opentui/core"

/** One captured grapheme of the reader, in reader-local cell coordinates. */
export type Cell = { x: number; y: number; width: number; glyph: string; fg: RGBA; bg: RGBA; attributes: number }

/** Paint target limited to the reader's own viewport. */
export type Canvas = {
  /** Draw `glyph` over `cell`; omitted colours/attributes keep the cell's own. */
  draw(cell: Cell, glyph: string, fg?: RGBA, bg?: RGBA, attributes?: number): void
}

/** Theme colours resolved by the engine for the current frame. */
export type MotionColors = {
  /** Interactive accent (theme `text.action.primary.base`). */
  accent: RGBA
  /** Alarm colour (theme `text.feedback.error.base`); undefined if the theme lacks it. */
  alert?: RGBA
  /** Main text colour (theme `text.base`), e.g. for an inverted "key cap" cell. */
  text: RGBA
}

export type LoadingFrame = {
  canvas: Canvas
  /** Letters and digits of the frozen old text. */
  cells: readonly Cell[]
  /** Milliseconds since waiting started. */
  elapsed: number
  colors: MotionColors
  palette: Palette
}

/** Shown over the old text while a translation is generated. */
export type LoadingAnimation = {
  /** Repaint interval while waiting. */
  tickMs: number
  paint(frame: LoadingFrame): void
}

/** A changed target cell: hidden until `start`, then animated for `duration` ms, then the live text. */
export type Entering = { cell: Cell; start: number; duration: number; seed: number }
/** An old cell, visible until `exit` (the moment its replacement starts, or its own random moment). */
export type Leaving = { cell: Cell; exit: number; seed: number }
export type TransitionFrame = { canvas: Canvas; colors: MotionColors; palette: Palette; seed: number }

/** Replaces the old text with the new one. Start/exit times are assigned by the engine. */
export type TransitionAnimation = {
  /** Stored in settings. */
  id: string
  /** Shown in settings. */
  title: string
  /** Entry length of a changed cell, from a uniform `random` in [0, 1); 0 shows it as is. */
  duration(cell: Cell, random: number): number
  /** Called while `0 <= local < item.duration`. */
  enter(frame: TransitionFrame, item: Entering, local: number): void
  /** Called while `elapsed < item.exit`. */
  leave(frame: TransitionFrame, item: Leaving, elapsed: number): void
}

/** Stateless integer hash: the same cell and step give the same choice on every repaint. */
export function hash(a: number, b = 0, c = 0): number {
  let h =
    Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^
    Math.imul(b + 0x7f4a7c15, 0xc2b2ae35) ^
    Math.imul(c + 0x165667b1, 0x27d4eb2f)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return h >>> 0
}

/** Hash mapped to [0, 1). */
export const random = (a: number, b = 0, c = 0) => hash(a, b, c) / 0x1_0000_0000

const LATIN = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#?$&"
const CYRILLIC = "абвгдеёжзийклмнопрстуфхцчшщъыьэюяіїєґ"

/** Same-case alphabet of a single-cell letter/digit; complex and wide graphemes are left intact. */
export function alphabetFor(glyph: string): string | undefined {
  const lower = glyph.toLowerCase()
  if (/^[a-z0-9#?$&]$/.test(lower)) return glyph === lower && /[a-z]/.test(lower) ? LATIN.toLowerCase() : LATIN
  if (lower.length === 1 && CYRILLIC.includes(lower)) return glyph === lower ? CYRILLIC : CYRILLIC.toUpperCase()
  return
}

export function randomGlyph(alphabet: string, a: number, b = 0, c = 0): string {
  return alphabet[hash(a, b, c) % alphabet.length]!
}

/** Three far-apart letters of the same alphabet, for a drum-like turn-over. */
export function intermediates(glyph: string): string[] | undefined {
  const alphabet = alphabetFor(glyph)
  if (!alphabet) return
  const index = Math.max(0, alphabet.indexOf(glyph))
  return [7, 14, 21].map((step) => alphabet[(index + step) % alphabet.length]!)
}

// Single-cell ASCII look-alikes (leetspeak) for Latin and Cyrillic letters.
const LOOKALIKES: Record<string, string> = {
  a: "4", b: "8", e: "3", g: "6", i: "1", l: "1", o: "0", s: "5", t: "7", z: "2",
  а: "4", б: "6", в: "8", е: "3", з: "3", о: "0", т: "7", ч: "4", э: "3", ь: "b",
} // prettier-ignore

export function lookalike(glyph: string): string | undefined {
  return LOOKALIKES[glyph.toLowerCase()]
}

/** Old text sinks toward the background within `ms`, staying readable (half-way at most). */
export function leaveDimmed(frame: TransitionFrame, item: Leaving, elapsed: number, ms = 160) {
  const level = Math.min(4, Math.floor((elapsed / ms) * 4))
  frame.canvas.draw(item.cell, item.cell.glyph, frame.palette.fade(item.cell.fg, item.cell.bg)[level])
}

/** Eight steps from a colour (0) toward a background (7, 85% blended); cached per colour pair. */
export class Palette {
  private cache = new Map<string, RGBA[]>()

  fade(fg: RGBA, bg: RGBA): RGBA[] {
    const key = `${fg.toInts()}:${bg.toInts()}`
    let colors = this.cache.get(key)
    if (!colors) {
      colors = Array.from({ length: 8 }, (_, level) => {
        const blend = (level / 7) * 0.85
        return RGBA.fromValues(
          fg.r * (1 - blend) + bg.r * blend,
          fg.g * (1 - blend) + bg.g * blend,
          fg.b * (1 - blend) + bg.b * blend,
          fg.a,
        )
      })
      this.cache.set(key, colors)
    }
    return colors
  }

  clear() {
    this.cache.clear()
  }
}
