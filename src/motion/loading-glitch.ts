// "Reloaded" loading: a sparse diagonal wave turns letters over, and independent glitches flash across the text:
// O→0, E→3 look-alikes, inverted "key cap" cells, red and bold letters, each snapping back to the original.
import { TextAttributes } from "@opentui/core"
import { hash, intermediates, lookalike, random, type Cell, type LoadingAnimation, type LoadingFrame } from "./kit"

const TICK_MS = 80
// Wave: every third letter on a diagonal; the head is 3 ticks long, a cell repeats every 29 ticks.
const WAVE_PERIOD = 29
const WAVE_LENGTH = 3
// Glitch: each letter gets its own period; a hit lasts GLITCH_TICKS ticks. About 1.5% of letters glitch at once.
const GLITCH_PERIOD_MS = 1200
const GLITCH_PERIOD_JITTER_MS = 1600
const GLITCH_CHANCE = 0.15
const GLITCH_TICKS = 3

function wave(frame: LoadingFrame, cell: Cell, step: number) {
  if ((cell.x * 7 + cell.y) % 3 !== 0) return false
  const age = (((step - cell.x - cell.y * 2) % WAVE_PERIOD) + WAVE_PERIOD) % WAVE_PERIOD
  if (age >= WAVE_LENGTH) return false
  const path = intermediates(cell.glyph)
  if (!path) return false
  const id = hash(cell.x, cell.y, 41)
  // The head prefers a look-alike (O→0), the tail turns over; a fixed third burns red, half the head is bold.
  const glyph = age === 0 ? (lookalike(cell.glyph) ?? path[0]!) : path[age]!
  const red = frame.colors.alert && id % 3 === 0
  const color = red
    ? frame.palette.fade(frame.colors.alert!, cell.bg)[age * 2]
    : frame.palette.fade(cell.fg, cell.bg)[3 + age]
  frame.canvas.draw(
    cell,
    glyph,
    color,
    undefined,
    age < 2 && id % 2 === 0 ? cell.attributes | TextAttributes.BOLD : undefined,
  )
  return true
}

function glitch(frame: LoadingFrame, cell: Cell) {
  const id = cell.y * 4096 + cell.x
  const seed = hash(id, 17)
  const period = GLITCH_PERIOD_MS + (seed % GLITCH_PERIOD_JITTER_MS)
  const time = frame.elapsed + (seed % period)
  const cycle = Math.floor(time / period)
  const tick = Math.floor((time % period) / TICK_MS)
  if (tick >= GLITCH_TICKS || random(id, cycle, 29) >= GLITCH_CHANCE) return
  const swap = lookalike(cell.glyph) ?? intermediates(cell.glyph)?.[hash(id, cycle) % 3]
  if (!swap) return
  const bold = cell.attributes | TextAttributes.BOLD
  // Last tick snaps back to the real letter, still emphasised, so the change reads as "and back".
  const glyph = tick === GLITCH_TICKS - 1 ? cell.glyph : swap
  switch (hash(id, cycle, 5) % 4) {
    case 0: // grey key cap: the letter on a dim grey cell (text colour blended 60% toward the background)
      frame.canvas.draw(cell, glyph, frame.colors.text, frame.palette.fade(frame.colors.text, cell.bg)[5], bold)
      return
    case 1: // red
      frame.canvas.draw(cell, glyph, frame.colors.alert ?? frame.colors.accent, undefined, bold)
      return
    default: // bright look-alike
      frame.canvas.draw(cell, glyph, frame.colors.text, undefined, bold)
  }
}

export const glitchLoading: LoadingAnimation = {
  tickMs: TICK_MS,
  paint(frame) {
    const step = Math.floor(frame.elapsed / TICK_MS)
    for (const cell of frame.cells) {
      if (cell.width !== 1) continue
      if (!wave(frame, cell, step)) glitch(frame, cell)
    }
  },
}
