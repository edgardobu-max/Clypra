/**
 * Per-layer look of a transition at progress `t` (0 → 1 across the whole blend).
 *
 * The blend borrows time around the cut: the outgoing clip keeps playing past its end
 * and the incoming one starts before its start. The incoming layer is always drawn after
 * (on top of) the outgoing one, so most effects only need to animate the incoming layer.
 */

export type TransitionType = "fade" | "dissolve" | "slide" | "zoom";

export const TRANSITION_TYPES: TransitionType[] = ["fade", "dissolve", "slide", "zoom"];

/** Clips whose edges are this close (gap OR small overlap, in seconds) count as a cut. */
export const TRANSITION_CUT_TOLERANCE = 0.15;

export type TransitionRole = "incoming" | "outgoing";

export interface TransitionTransform {
  /** Added to the layer's x, in project pixels. */
  dx: number;
  /** Scale around the layer's centre. */
  scale: number;
  opacity: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export function getTransitionTransform(type: TransitionType, role: TransitionRole, t: number, canvasWidth: number): TransitionTransform {
  const p = clamp01(t);
  switch (type) {
    case "fade":
      // Through black: outgoing fades out in the first half, incoming fades in in the second.
      return { dx: 0, scale: 1, opacity: role === "incoming" ? clamp01(2 * p - 1) : clamp01(1 - 2 * p) };
    case "slide": {
      // Push: the incoming clip enters from the right while the outgoing one is pushed out to the left.
      const e = easeInOut(p);
      return role === "incoming" ? { dx: (1 - e) * canvasWidth, scale: 1, opacity: 1 } : { dx: -e * canvasWidth, scale: 1, opacity: 1 };
    }
    case "zoom": {
      // The incoming clip fades in while settling from a slight zoom-in.
      if (role === "outgoing") return { dx: 0, scale: 1, opacity: 1 };
      const e = easeInOut(p);
      return { dx: 0, scale: 1.25 - 0.25 * e, opacity: clamp01(p * 1.4) };
    }
    case "dissolve":
    default:
      return { dx: 0, scale: 1, opacity: role === "incoming" ? p : 1 };
  }
}
