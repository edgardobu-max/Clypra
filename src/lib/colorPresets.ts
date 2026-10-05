import type { Clip } from "@/types";

/** Per-clip image adjustments the GPU color-grade pass understands (see webglLutProcessor.ts). */
export interface ColorAdjustments {
  /** Additive, -1..1. 0 = no change. */
  brightness?: number;
  /** Multiplier around the midpoint, 0..2. 1 = no change. */
  contrast?: number;
  /** 0..2. 1 = no change. */
  saturation?: number;
  /** Detail enhancement (unsharp mask on luma), 0..1. 0 = off. */
  sharpness?: number;
}

/**
 * "Mejora HD": the look the user applies to every video in CapCut — richer colour and extra
 * perceived resolution. Strong saturation, a little contrast and a luma sharpen; the numbers are
 * a first calibration by eye (tune them against a CapCut before/after of the same frame).
 */
export const MEJORA_HD: Required<ColorAdjustments> = {
  brightness: 0.01,
  contrast: 1.1,
  saturation: 1.25,
  sharpness: 0.6,
};

/** Clearing every adjustment (the stored value is simply removed). */
export const NO_ADJUSTMENTS: ColorAdjustments = { brightness: undefined, contrast: undefined, saturation: undefined, sharpness: undefined };

type AdjustedClip = Pick<Clip, "brightness" | "contrast" | "saturation" | "sharpness">;

export function hasAnyAdjustment(clip: AdjustedClip): boolean {
  return (clip.brightness ?? 0) !== 0 || (clip.contrast ?? 1) !== 1 || (clip.saturation ?? 1) !== 1 || (clip.sharpness ?? 0) !== 0;
}

/** True when the clip carries exactly this preset (small tolerance for slider rounding). */
export function matchesPreset(clip: AdjustedClip, preset: Required<ColorAdjustments>, tolerance = 0.005): boolean {
  const close = (a: number, b: number) => Math.abs(a - b) <= tolerance;
  return close(clip.brightness ?? 0, preset.brightness) && close(clip.contrast ?? 1, preset.contrast) && close(clip.saturation ?? 1, preset.saturation) && close(clip.sharpness ?? 0, preset.sharpness);
}

/** Clamp to the ranges the shader expects, so a bad stored value can never produce a broken frame. */
export function clampAdjustments(a: ColorAdjustments): ColorAdjustments {
  const clamp = (v: number | undefined, min: number, max: number) => (v === undefined || Number.isNaN(v) ? undefined : Math.min(max, Math.max(min, v)));
  return { brightness: clamp(a.brightness, -1, 1), contrast: clamp(a.contrast, 0, 2), saturation: clamp(a.saturation, 0, 2), sharpness: clamp(a.sharpness, 0, 1) };
}
