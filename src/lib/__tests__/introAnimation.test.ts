import { describe, it, expect } from "vitest";
import { easeOutBack, getIntroState } from "../introAnimation";

const box = { x: 100, y: 200, width: 600, height: 120 };

describe("easeOutBack", () => {
  it("starts at 0, ends at 1 and overshoots only slightly in between", () => {
    expect(easeOutBack(0)).toBeCloseTo(0);
    expect(easeOutBack(1)).toBeCloseTo(1);
    const peak = Math.max(...Array.from({ length: 101 }, (_, i) => easeOutBack(i / 100)));
    expect(peak).toBeGreaterThan(1.005);
    expect(peak).toBeLessThan(1.08);
  });
});

describe("getIntroState", () => {
  it("does nothing without an intro, with type none, or after it finished", () => {
    expect(getIntroState(undefined, 0, 10, box)).toEqual({ dx: 0, dy: 0, opacity: 1 });
    expect(getIntroState({ type: "none", duration: 1 }, 0, 10, box)).toEqual({ dx: 0, dy: 0, opacity: 1 });
    expect(getIntroState({ type: "slide-left", duration: 0.6 }, 0.6, 10, box)).toEqual({ dx: 0, dy: 0, opacity: 1 });
    expect(getIntroState({ type: "slide-left", duration: 0.6 }, 5, 10, box)).toEqual({ dx: 0, dy: 0, opacity: 1 });
  });

  it("slide-left starts fully off the left edge and lands on the resting position", () => {
    const start = getIntroState({ type: "slide-left", duration: 0.6, bounce: true }, 0, 10, box);
    expect(box.x + start.dx + box.width).toBeCloseTo(0); // right edge at x = 0
    const nearEnd = getIntroState({ type: "slide-left", duration: 0.6, bounce: true }, 0.59, 10, box);
    expect(Math.abs(nearEnd.dx)).toBeLessThan(20);
  });

  it("bounce overshoots past the resting position before settling", () => {
    const samples = Array.from({ length: 60 }, (_, i) => getIntroState({ type: "slide-left", duration: 0.6, bounce: true }, (i / 60) * 0.6, 10, box).dx);
    expect(Math.max(...samples)).toBeGreaterThan(0); // moved right of rest
    const noBounce = Array.from({ length: 60 }, (_, i) => getIntroState({ type: "slide-left", duration: 0.6 }, (i / 60) * 0.6, 10, box).dx);
    expect(Math.max(...noBounce)).toBeLessThanOrEqual(0);
  });

  it("fade ramps opacity from 0 to 1", () => {
    expect(getIntroState({ type: "fade", duration: 1 }, 0, 10, box).opacity).toBeCloseTo(0);
    expect(getIntroState({ type: "fade", duration: 1 }, 0.5, 10, box).opacity).toBeGreaterThan(0.5);
  });

  it("clamps the duration to the clip length", () => {
    // clip lasts 0.3 s, intro asks for 2 s: at t=0.3 it is already finished
    expect(getIntroState({ type: "fade", duration: 2 }, 0.3, 0.3, box)).toEqual({ dx: 0, dy: 0, opacity: 1 });
  });
});
