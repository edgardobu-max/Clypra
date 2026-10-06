/**
 * Per-layer look of a transition at progress `t` (0 → 1 across the whole blend).
 *
 * The blend borrows time around the cut: the outgoing clip keeps playing past its end
 * and the incoming one starts before its start. The incoming layer is always drawn after
 * (on top of) the outgoing one, so most effects only need to animate the incoming layer.
 */

export type TransitionType = "fade" | "dissolve" | "slide" | "zoom" | "slideUp" | "wipe" | "wipeUp" | "iris" | "flash" | "blur";

export const TRANSITION_TYPES: TransitionType[] = ["fade", "dissolve", "slide", "zoom", "slideUp", "wipe", "wipeUp", "iris", "flash", "blur"];

/** Clips whose edges are this close (gap OR small overlap, in seconds) count as a cut. */
export const TRANSITION_CUT_TOLERANCE = 0.15;

export type TransitionRole = "incoming" | "outgoing";

/** Reveals the incoming layer through a moving edge (wipes) or a growing circle (iris). */
export interface TransitionMask {
  kind: "wipeRight" | "wipeUp" | "iris";
  /** 0 = nothing of the incoming layer visible, 1 = all of it. */
  progress: number;
}

export interface TransitionTransform {
  /** Added to the layer's x, in project pixels. */
  dx: number;
  /** Added to the layer's y, in project pixels. */
  dy: number;
  /** Scale around the layer's centre. */
  scale: number;
  opacity: number;
  /** Extra blur strength (0-1) for this layer. */
  blur?: number;
  /** White flash laid over the picture, 0-1 (flash transition). */
  flash?: number;
  mask?: TransitionMask;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export function getTransitionTransform(type: TransitionType, role: TransitionRole, t: number, canvasWidth: number, canvasHeight: number = canvasWidth): TransitionTransform {
  const p = clamp01(t);
  const incoming = role === "incoming";
  switch (type) {
    case "fade":
      // Through black: outgoing fades out in the first half, incoming fades in in the second.
      return { dx: 0, dy: 0, scale: 1, opacity: incoming ? clamp01(2 * p - 1) : clamp01(1 - 2 * p) };
    case "slide": {
      // Push: the incoming clip enters from the right while the outgoing one is pushed out to the left.
      const e = easeInOut(p);
      return incoming ? { dx: (1 - e) * canvasWidth, dy: 0, scale: 1, opacity: 1 } : { dx: -e * canvasWidth, dy: 0, scale: 1, opacity: 1 };
    }
    case "slideUp": {
      // Push upwards: the incoming clip rises from the bottom while the outgoing one is pushed up and out.
      const e = easeInOut(p);
      return incoming ? { dx: 0, dy: (1 - e) * canvasHeight, scale: 1, opacity: 1 } : { dx: 0, dy: -e * canvasHeight, scale: 1, opacity: 1 };
    }
    case "zoom": {
      // The incoming clip fades in while settling from a slight zoom-in.
      if (!incoming) return { dx: 0, dy: 0, scale: 1, opacity: 1 };
      const e = easeInOut(p);
      return { dx: 0, dy: 0, scale: 1.25 - 0.25 * e, opacity: clamp01(p * 1.4) };
    }
    case "wipe":
      // The incoming clip is uncovered from left to right over the outgoing one.
      return { dx: 0, dy: 0, scale: 1, opacity: 1, mask: incoming ? { kind: "wipeRight", progress: easeInOut(p) } : undefined };
    case "wipeUp":
      return { dx: 0, dy: 0, scale: 1, opacity: 1, mask: incoming ? { kind: "wipeUp", progress: easeInOut(p) } : undefined };
    case "iris":
      // A circle opens from the centre and shows the incoming clip.
      return { dx: 0, dy: 0, scale: 1, opacity: 1, mask: incoming ? { kind: "iris", progress: easeInOut(p) } : undefined };
    case "flash": {
      // Hard cut at the midpoint, hidden by a white flash that peaks exactly there.
      const flash = Math.sin(Math.PI * p) ** 2;
      return { dx: 0, dy: 0, scale: 1, opacity: incoming ? (p < 0.5 ? 0 : 1) : p < 0.5 ? 1 : 0, flash: incoming ? flash : undefined };
    }
    case "blur":
      // A dissolve that blurs both clips at the middle, so the swap happens while the picture is soft.
      return { dx: 0, dy: 0, scale: 1, opacity: incoming ? p : 1, blur: Math.sin(Math.PI * p) * 0.9 };
    case "dissolve":
    default:
      return { dx: 0, dy: 0, scale: 1, opacity: incoming ? p : 1 };
  }
}

/**
 * Canvas-space shape (in the layer's own centred coordinates) that the incoming layer is limited to.
 * `width`/`height` are the layer's size. Returns null when the whole layer shows.
 */
export type MaskShape = { kind: "rect"; x: number; y: number; w: number; h: number } | { kind: "circle"; radius: number };

export function maskShape(mask: TransitionMask | undefined, width: number, height: number): MaskShape | null {
  if (!mask) return null;
  const p = clamp01(mask.progress);
  if (p >= 1) return null;
  switch (mask.kind) {
    case "wipeRight":
      return { kind: "rect", x: -width / 2, y: -height / 2, w: width * p, h: height };
    case "wipeUp":
      return { kind: "rect", x: -width / 2, y: height / 2 - height * p, w: width, h: height * p };
    case "iris":
      // Reaches the corners (half the diagonal) exactly when p = 1.
      return { kind: "circle", radius: p * Math.hypot(width, height) / 2 };
  }
}
