/**
 * Intro (entrance) animation for text clips.
 *
 * Applied as an offset on top of the clip's own position/opacity, so the user can
 * move or restyle the clip freely: the animation always ends on wherever the clip
 * sits. There is deliberately no outro — the clip simply disappears at its end.
 */

export type IntroType = "none" | "slide-left" | "slide-up" | "fade";

export interface ClipIntro {
  type: IntroType;
  /** Seconds the entrance takes (clamped to the clip duration). */
  duration: number;
  /** Slight overshoot before settling (slide types only). */
  bounce?: boolean;
}

export const INTRO_LABELS: Record<IntroType, string> = {
  none: "None",
  "slide-left": "Slide from left",
  "slide-up": "Slide up",
  fade: "Fade in",
};

export const DEFAULT_INTRO_DURATION = 0.6;

/** Ease-out with a gentle overshoot (peaks ~4% past the target, then settles). */
export function easeOutBack(t: number): number {
  const c1 = 0.9;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

export function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

export interface IntroBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface IntroState {
  /** Added to the clip's x. */
  dx: number;
  /** Added to the clip's y. */
  dy: number;
  /** Multiplies the clip's opacity. */
  opacity: number;
}

const NO_CHANGE: IntroState = { dx: 0, dy: 0, opacity: 1 };

/**
 * @param offset seconds since the clip started
 * @param box    the clip's resting box (already including keyframes)
 */
export function getIntroState(intro: ClipIntro | undefined, offset: number, clipDuration: number, box: IntroBox): IntroState {
  if (!intro || intro.type === "none") return NO_CHANGE;
  const duration = Math.min(Math.max(0.05, intro.duration), Math.max(0.05, clipDuration));
  if (offset >= duration) return NO_CHANGE;

  const t = Math.max(0, offset) / duration;

  switch (intro.type) {
    case "slide-left": {
      // Start fully off the left edge of the canvas.
      const eased = intro.bounce ? easeOutBack(t) : easeOutCubic(t);
      return { dx: -(box.x + box.width) * (1 - eased), dy: 0, opacity: 1 };
    }
    case "slide-up": {
      const eased = intro.bounce ? easeOutBack(t) : easeOutCubic(t);
      return { dx: 0, dy: box.height * 1.5 * (1 - eased), opacity: easeOutCubic(t) };
    }
    case "fade":
      return { dx: 0, dy: 0, opacity: easeOutCubic(t) };
    default:
      return NO_CHANGE;
  }
}
