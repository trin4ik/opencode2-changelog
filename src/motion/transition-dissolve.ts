// "Dissolve": no glyph changes; old letters fade out and new ones fade in, each at its own moment.
import type { TransitionAnimation } from "./kit"

const IN_MS = 260
const OUT_MS = 160

export const dissolve: TransitionAnimation = {
  id: "dissolve",
  title: "Dissolve",
  duration: (cell) => (cell.glyph.trim() ? IN_MS : 0),
  enter(frame, item, local) {
    const level = Math.round((1 - local / item.duration) * 6)
    frame.canvas.draw(item.cell, item.cell.glyph, frame.palette.fade(item.cell.fg, item.cell.bg)[level])
  },
  leave(frame, item, elapsed) {
    const level = Math.max(0, Math.min(7, Math.round(((elapsed - (item.exit - OUT_MS)) / OUT_MS) * 7)))
    frame.canvas.draw(item.cell, item.cell.glyph, frame.palette.fade(item.cell.fg, item.cell.bg)[level])
  },
}
