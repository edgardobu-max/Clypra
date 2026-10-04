import { describe, it, expect } from "vitest";
import { getClipAudioGain, clampVolume, clampFade } from "../audioGain";

const clip = (over: Partial<{ duration: number; volume: number; audioFadeIn: number; audioFadeOut: number }> = {}) => ({
  duration: 10,
  ...over,
});

describe("audioGain", () => {
  it("defaults to unity gain when nothing is set", () => {
    expect(getClipAudioGain(clip(), 0)).toBe(1);
    expect(getClipAudioGain(clip(), 5)).toBe(1);
  });

  it("applies volume, capped to [0, 1]", () => {
    expect(getClipAudioGain(clip({ volume: 0.4 }), 5)).toBeCloseTo(0.4);
    expect(getClipAudioGain(clip({ volume: 3 }), 5)).toBe(1);
    expect(getClipAudioGain(clip({ volume: -1 }), 5)).toBe(0);
    expect(clampVolume(undefined)).toBe(1);
    expect(clampVolume(Number.NaN)).toBe(1);
  });

  it("ramps linearly through fade in", () => {
    const c = clip({ audioFadeIn: 2 });
    expect(getClipAudioGain(c, 0)).toBe(0);
    expect(getClipAudioGain(c, 1)).toBeCloseTo(0.5);
    expect(getClipAudioGain(c, 2)).toBe(1);
    expect(getClipAudioGain(c, 6)).toBe(1);
  });

  it("ramps linearly through fade out", () => {
    const c = clip({ audioFadeOut: 4 });
    expect(getClipAudioGain(c, 6)).toBe(1);
    expect(getClipAudioGain(c, 8)).toBeCloseTo(0.5);
    expect(getClipAudioGain(c, 10)).toBe(0);
  });

  it("scales fades by volume and multiplies overlapping fades", () => {
    expect(getClipAudioGain(clip({ volume: 0.5, audioFadeIn: 2 }), 1)).toBeCloseTo(0.25);
    // 4s clip, fade in 4 + fade out 4 → at t=2: 0.5 * 0.5
    expect(getClipAudioGain({ duration: 4, audioFadeIn: 4, audioFadeOut: 4 }, 2)).toBeCloseTo(0.25);
  });

  it("clamps fades to the clip duration and ignores invalid values", () => {
    expect(clampFade(99, 3)).toBe(3);
    expect(clampFade(-2, 3)).toBe(0);
    expect(clampFade(undefined, 3)).toBe(0);
  });
});
