import { describe, it, expect } from "vitest";
import { getTransitionTransform } from "../transitionState";

describe("getTransitionTransform", () => {
  it("dissolve fades the incoming layer in over a fully opaque outgoing one", () => {
    expect(getTransitionTransform("dissolve", "incoming", 0.25, 1080).opacity).toBeCloseTo(0.25);
    expect(getTransitionTransform("dissolve", "outgoing", 0.25, 1080).opacity).toBe(1);
  });

  it("fade goes through black: out in the first half, in during the second", () => {
    expect(getTransitionTransform("fade", "outgoing", 0.5, 1080).opacity).toBeCloseTo(0);
    expect(getTransitionTransform("fade", "incoming", 0.5, 1080).opacity).toBeCloseTo(0);
    expect(getTransitionTransform("fade", "incoming", 1, 1080).opacity).toBeCloseTo(1);
  });

  it("slide pushes: incoming starts a full canvas to the right, outgoing ends a full canvas to the left", () => {
    expect(getTransitionTransform("slide", "incoming", 0, 1080).dx).toBeCloseTo(1080);
    expect(getTransitionTransform("slide", "incoming", 1, 1080).dx).toBeCloseTo(0);
    expect(getTransitionTransform("slide", "outgoing", 0, 1080).dx).toBeCloseTo(0);
    expect(getTransitionTransform("slide", "outgoing", 1, 1080).dx).toBeCloseTo(-1080);
    // both layers always fully opaque (no see-through gap while moving)
    expect(getTransitionTransform("slide", "incoming", 0.4, 1080).opacity).toBe(1);
  });

  it("zoom settles the incoming layer to scale 1 while it fades in", () => {
    const start = getTransitionTransform("zoom", "incoming", 0, 1080);
    expect(start.scale).toBeCloseTo(1.25);
    expect(start.opacity).toBeCloseTo(0);
    const end = getTransitionTransform("zoom", "incoming", 1, 1080);
    expect(end.scale).toBeCloseTo(1);
    expect(end.opacity).toBe(1);
  });

  it("clamps progress outside 0..1", () => {
    expect(getTransitionTransform("slide", "incoming", -1, 1080).dx).toBeCloseTo(1080);
    expect(getTransitionTransform("slide", "incoming", 3, 1080).dx).toBeCloseTo(0);
  });
});
