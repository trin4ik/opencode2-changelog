// "Split-flap": a split-flap cell turns over 2–4 random faces; each lands dark and brightens, the last is the letter.
import { alphabetFor, leaveDimmed, randomGlyph, type TransitionAnimation } from "./kit"

const STEP_MS = 75
const FACES_MIN = 2
const FACES_MAX = 4

export const flap: TransitionAnimation = {
  id: "flap",
  title: "Split-flap",
  duration: (cell, random) =>
    cell.width === 1 && alphabetFor(cell.glyph)
      ? STEP_MS * (FACES_MIN + Math.floor(random * (FACES_MAX - FACES_MIN + 1)))
      : 0,
  enter(frame, item, local) {
    const face = Math.floor(local / STEP_MS)
    const last = face >= Math.round(item.duration / STEP_MS) - 1
    const phase = (local % STEP_MS) / STEP_MS
    const glyph = last ? item.cell.glyph : randomGlyph(alphabetFor(item.cell.glyph)!, item.seed, frame.seed, face)
    frame.canvas.draw(item.cell, glyph, frame.palette.fade(item.cell.fg, item.cell.bg)[Math.round((1 - phase) * 5)])
  },
  leave: leaveDimmed,
}
