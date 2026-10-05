import { describe, it, expect } from "vitest";
import { MEJORA_HD, NO_ADJUSTMENTS, hasAnyAdjustment, matchesPreset, clampAdjustments } from "../colorPresets";

describe("Mejora HD preset", () => {
  it("stays inside the ranges the shader accepts", () => {
    expect(clampAdjustments(MEJORA_HD)).toEqual(MEJORA_HD);
    expect(MEJORA_HD.saturation).toBeGreaterThan(1); // richer colour
    expect(MEJORA_HD.contrast).toBeGreaterThan(1);
    expect(MEJORA_HD.sharpness).toBeGreaterThan(0); // the "more resolution" part
    expect(MEJORA_HD.sharpness).toBeLessThanOrEqual(1);
  });

  it("is recognised on a clip that carries it, including after slider rounding", () => {
    expect(matchesPreset({ ...MEJORA_HD }, MEJORA_HD)).toBe(true);
    expect(matchesPreset({ brightness: 0.01, contrast: 1.1, saturation: 1.25, sharpness: 0.6 }, MEJORA_HD)).toBe(true);
    expect(matchesPreset({ brightness: 0.01, contrast: 1.1, saturation: 1.25, sharpness: 0.62 }, MEJORA_HD)).toBe(false);
    expect(matchesPreset({}, MEJORA_HD)).toBe(false);
  });
});

describe("adjustment helpers", () => {
  it("hasAnyAdjustment sees each adjustment, including sharpness", () => {
    expect(hasAnyAdjustment({})).toBe(false);
    expect(hasAnyAdjustment({ brightness: 0, contrast: 1, saturation: 1, sharpness: 0 })).toBe(false);
    expect(hasAnyAdjustment({ sharpness: 0.3 })).toBe(true);
    expect(hasAnyAdjustment({ saturation: 1.2 })).toBe(true);
  });

  it("NO_ADJUSTMENTS clears every field", () => {
    expect(Object.values(NO_ADJUSTMENTS).every((v) => v === undefined)).toBe(true);
    expect(Object.keys(NO_ADJUSTMENTS).sort()).toEqual(["brightness", "contrast", "saturation", "sharpness"]);
  });

  it("clamps out-of-range and invalid values", () => {
    expect(clampAdjustments({ brightness: 5, contrast: -3, saturation: 9, sharpness: 2 })).toEqual({ brightness: 1, contrast: 0, saturation: 2, sharpness: 1 });
    expect(clampAdjustments({ sharpness: Number.NaN }).sharpness).toBeUndefined();
  });
});
