// Animation registry: add a file implementing LoadingAnimation / TransitionAnimation and list it here.
import type { LoadingAnimation, TransitionAnimation } from "./kit"
import { glitchLoading } from "./loading-glitch"
import { decode } from "./transition-decode"
import { dissolve } from "./transition-dissolve"
import { flap } from "./transition-flap"

export type { LoadingAnimation, TransitionAnimation } from "./kit"

export const loading: LoadingAnimation = glitchLoading

/** The first entry is the default. Settings store the `id`. */
export const transitions: readonly TransitionAnimation[] = [decode, flap, dissolve]

export function transitionById(id: string | undefined): TransitionAnimation {
  return transitions.find((item) => item.id === id) ?? transitions[0]!
}
