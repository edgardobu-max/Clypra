import { describe, it, expect } from "vitest";
import { EFFECTS, EFFECT_IDS, boostEffects, cleanEffects, hasAnyEffect, withEffect } from "../clipEffects";
import { TRANSITION_TYPES, getTransitionTransform, maskShape } from "@/core/evaluation/transitionState";

describe("clip effects", () => {
  it("lists the eight effects with unique ids", () => {
    expect(EFFECT_IDS).toEqual(["blur", "mono", "sepia", "vignette", "glow", "chromatic", "pixelate", "grain"]);
    expect(new Set(EFFECT_IDS).size).toBe(EFFECTS.length);
  });

  it("keeps only valid, non-zero strengths inside 0..1", () => {
    expect(cleanEffects(undefined)).toBeUndefined();
    expect(cleanEffects({})).toBeUndefined();
    expect(cleanEffects({ blur: 0, sepia: Number.NaN, grain: -1 })).toBeUndefined();
    expect(cleanEffects({ blur: 0.4, vignette: 7 })).toEqual({ blur: 0.4, vignette: 1 });
  });

  it("withEffect adds, changes and removes one effect without touching the others", () => {
    const one = withEffect(undefined, "blur", 0.5);
    expect(one).toEqual({ blur: 0.5 });
    const two = withEffect(one, "sepia", 0.3);
    expect(two).toEqual({ blur: 0.5, sepia: 0.3 });
    expect(withEffect(two, "blur", 0)).toEqual({ sepia: 0.3 });
    expect(withEffect({ sepia: 0.3 }, "sepia", 0)).toBeUndefined(); // nothing left on
    expect(hasAnyEffect(two)).toBe(true);
    expect(hasAnyEffect(undefined)).toBe(false);
  });

  it("boostEffects keeps the stronger value, e.g. a transition's blur over the clip's own", () => {
    expect(boostEffects({ blur: 0.2, grain: 0.5 }, { blur: 0.8 })).toEqual({ blur: 0.8, grain: 0.5 });
    expect(boostEffects({ blur: 0.9 }, { blur: 0.3 })).toEqual({ blur: 0.9 });
    expect(boostEffects(undefined, undefined)).toBeUndefined();
    expect(boostEffects(undefined, { blur: 0.4 })).toEqual({ blur: 0.4 });
  });
});

describe("new transitions", () => {
  const W = 1080;
  const H = 1920;

  it("registers ten transitions", () => {
    expect(TRANSITION_TYPES).toEqual(["fade", "dissolve", "slide", "zoom", "slideUp", "wipe", "wipeUp", "iris", "flash", "blur"]);
  });

  it("slideUp pushes vertically using the canvas height", () => {
    expect(getTransitionTransform("slideUp", "incoming", 0, W, H).dy).toBeCloseTo(H);
    expect(getTransitionTransform("slideUp", "incoming", 1, W, H).dy).toBeCloseTo(0);
    expect(getTransitionTransform("slideUp", "outgoing", 1, W, H).dy).toBeCloseTo(-H);
    expect(getTransitionTransform("slideUp", "incoming", 0.5, W, H).dx).toBe(0);
  });

  it("wipe, wipeUp and iris only mask the incoming layer, from nothing to everything", () => {
    for (const [type, kind] of [["wipe", "wipeRight"], ["wipeUp", "wipeUp"], ["iris", "iris"]] as const) {
      expect(getTransitionTransform(type, "incoming", 0, W, H).mask).toEqual({ kind, progress: 0 });
      expect(getTransitionTransform(type, "incoming", 1, W, H).mask?.progress).toBe(1);
      expect(getTransitionTransform(type, "outgoing", 0.5, W, H).mask).toBeUndefined();
      expect(getTransitionTransform(type, "incoming", 0.3, W, H).opacity).toBe(1);
    }
  });

  it("flash swaps the clips at the midpoint, under a white peak", () => {
    const before = getTransitionTransform("flash", "outgoing", 0.4, W, H);
    const after = getTransitionTransform("flash", "incoming", 0.6, W, H);
    expect(before.opacity).toBe(1);
    expect(getTransitionTransform("flash", "incoming", 0.4, W, H).opacity).toBe(0);
    expect(after.opacity).toBe(1);
    expect(getTransitionTransform("flash", "outgoing", 0.6, W, H).opacity).toBe(0);
    expect(getTransitionTransform("flash", "incoming", 0.5, W, H).flash).toBeCloseTo(1);
    expect(getTransitionTransform("flash", "incoming", 0, W, H).flash).toBeCloseTo(0);
    expect(getTransitionTransform("flash", "incoming", 1, W, H).flash).toBeCloseTo(0);
    // only one layer carries the veil, so it is drawn once
    expect(getTransitionTransform("flash", "outgoing", 0.5, W, H).flash).toBeUndefined();
  });

  it("blur dissolves like a dissolve and blurs both clips most at the middle", () => {
    expect(getTransitionTransform("blur", "incoming", 0.25, W, H).opacity).toBeCloseTo(0.25);
    expect(getTransitionTransform("blur", "outgoing", 0.25, W, H).opacity).toBe(1);
    for (const role of ["incoming", "outgoing"] as const) {
      expect(getTransitionTransform("blur", role, 0, W, H).blur).toBeCloseTo(0);
      expect(getTransitionTransform("blur", role, 1, W, H).blur).toBeCloseTo(0);
      expect(getTransitionTransform("blur", role, 0.5, W, H).blur).toBeCloseTo(0.9);
    }
  });

  it("old transitions keep a zero vertical offset and no mask", () => {
    for (const type of ["fade", "dissolve", "slide", "zoom"] as const) {
      const look = getTransitionTransform(type, "incoming", 0.5, W, H);
      expect(look.dy).toBe(0);
      expect(look.mask).toBeUndefined();
    }
  });
});

describe("maskShape", () => {
  it("wipe right reveals from the left edge", () => {
    expect(maskShape({ kind: "wipeRight", progress: 0.25 }, 400, 200)).toEqual({ kind: "rect", x: -200, y: -100, w: 100, h: 200 });
  });

  it("wipe up reveals from the bottom edge", () => {
    expect(maskShape({ kind: "wipeUp", progress: 0.5 }, 400, 200)).toEqual({ kind: "rect", x: -200, y: 0, w: 400, h: 100 });
  });

  it("iris grows to the corners and then shows everything", () => {
    const half = maskShape({ kind: "iris", progress: 0.5 }, 300, 400);
    expect(half).toEqual({ kind: "circle", radius: 125 }); // 0.5 * hypot(300, 400) / 2
    expect(maskShape({ kind: "iris", progress: 1 }, 300, 400)).toBeNull();
  });

  it("no mask, or a finished one, means the whole layer shows", () => {
    expect(maskShape(undefined, 100, 100)).toBeNull();
    expect(maskShape({ kind: "wipeRight", progress: 1 }, 100, 100)).toBeNull();
  });

  it("nothing is revealed at the start", () => {
    expect(maskShape({ kind: "wipeRight", progress: 0 }, 100, 100)).toEqual({ kind: "rect", x: -50, y: -50, w: 0, h: 100 });
    expect(maskShape({ kind: "iris", progress: 0 }, 100, 100)).toEqual({ kind: "circle", radius: 0 });
  });
});
