// "Decode": a changed letter flickers through random accent-coloured glyphs, then lands.
import { alphabetFor, leaveDimmed, randomGlyph, type TransitionAnimation } from "./kit"

const MIN_MS = 120
const MAX_MS = 300
const STEP_MS = 50

export const decode: TransitionAnimation = {
  id: "decode",
  title: "Decode",
  duration: (cell, random) =>
    cell.width === 1 && alphabetFor(cell.glyph) ? MIN_MS + Math.round(random * (MAX_MS - MIN_MS)) : 0,
  enter(frame, item, local) {
    const glyph = randomGlyph(alphabetFor(item.cell.glyph)!, item.seed, frame.seed, Math.floor(local / STEP_MS))
    frame.canvas.draw(item.cell, glyph, frame.colors.accent)
  },
  leave: leaveDimmed,
}
