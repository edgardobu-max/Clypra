import { describe, it, expect } from "vitest";
import type { Clip, Track, MediaAsset } from "@/types";
import { MAX_CLIP_SPEED, MIN_CLIP_SPEED, clipSpeed, clampSpeed, sourceTimeAt, durationForTrim, planClipSpeedChange } from "../clipSpeed";
import { buildExportAudioInputs } from "../exportAudio";
import { SplitClipCommand } from "@/core/history/commands/SplitClipCommand";
import { ReplaceClipsCommand } from "@/core/history/commands/ReplaceClipsCommand";

function makeClip(over: Partial<Clip> = {}): Clip {
  return { id: "a", trackId: "t1", mediaId: "m1", startTime: 0, duration: 90, trimIn: 0, trimOut: 90, x: 0, y: 0, width: 1080, height: 1920, opacity: 1, rotation: 0, ...over };
}

describe("speed basics", () => {
  it("defaults to 1 and stays inside the supported range", () => {
    expect(clipSpeed(makeClip())).toBe(1);
    expect(clipSpeed({ speed: Number.NaN })).toBe(1);
    expect(clipSpeed({ speed: -2 })).toBe(1);
    expect(clampSpeed(100)).toBe(MAX_CLIP_SPEED);
    expect(clampSpeed(0.01)).toBe(MIN_CLIP_SPEED);
  });

  it("maps timeline time to source time", () => {
    const clip = makeClip({ startTime: 10, trimIn: 5, trimOut: 65, duration: 30, speed: 2 });
    expect(sourceTimeAt(clip, 10)).toBe(5);
    expect(sourceTimeAt(clip, 20)).toBe(25); // 10 timeline seconds = 20 source seconds
    expect(sourceTimeAt(clip, 40)).toBe(65); // the clip ends at the end of its trim range
    expect(durationForTrim(clip)).toBe(30);
    expect(sourceTimeAt(makeClip({ startTime: 0, trimIn: 0, trimOut: 10, duration: 20, speed: 0.5 }), 10)).toBe(5);
  });
});

describe("planClipSpeedChange", () => {
  it("a 90 s clip at 1.6x lasts 56.25 s", () => {
    const plan = planClipSpeedChange([makeClip()], "a", 1.6)!;
    expect(plan.after[0].duration).toBeCloseTo(56.25, 5);
    expect(plan.after[0].speed).toBe(1.6);
    // the source range is untouched: all of the footage is still used
    expect(plan.after[0].trimIn).toBe(0);
    expect(plan.after[0].trimOut).toBe(90);
  });

  it("moves the clips after it on the same track, not other tracks or earlier clips", () => {
    const clips = [
      makeClip({ id: "before", startTime: 0, duration: 10, trimOut: 10 }),
      makeClip({ id: "a", startTime: 10, duration: 20, trimIn: 0, trimOut: 20 }),
      makeClip({ id: "next", startTime: 30, duration: 5, trimOut: 5 }),
      makeClip({ id: "other-track", trackId: "t2", startTime: 30, duration: 5, trimOut: 5 }),
    ];
    const plan = planClipSpeedChange(clips, "a", 2)!; // 20 s -> 10 s
    const byId = new Map(plan.after.map((c) => [c.id, c]));
    expect(byId.get("a")!.duration).toBe(10);
    expect(byId.get("next")!.startTime).toBe(20);
    expect(byId.has("before")).toBe(false);
    expect(byId.has("other-track")).toBe(false);
  });

  it("slowing down pushes the next clip later so nothing overlaps", () => {
    const clips = [makeClip({ id: "a", duration: 10, trimOut: 10 }), makeClip({ id: "next", startTime: 10, duration: 5, trimOut: 5 })];
    const plan = planClipSpeedChange(clips, "a", 0.5)!;
    expect(plan.after.find((c) => c.id === "a")!.duration).toBe(20);
    expect(plan.after.find((c) => c.id === "next")!.startTime).toBe(20);
  });

  it("returns to normal speed by removing the field, and does nothing when unchanged", () => {
    const sped = makeClip({ speed: 2, duration: 45 });
    const back = planClipSpeedChange([sped], "a", 1)!;
    expect(back.after[0].speed).toBeUndefined();
    expect(back.after[0].duration).toBe(90);
    expect(planClipSpeedChange([makeClip()], "a", 1)).toBeNull();
    expect(planClipSpeedChange([makeClip()], "missing", 2)).toBeNull();
  });

  it("clamps absurd speeds to the supported range", () => {
    const plan = planClipSpeedChange([makeClip()], "a", 50)!;
    expect(plan.after[0].speed).toBe(MAX_CLIP_SPEED);
  });

  it("undo restores every moved clip in one step", () => {
    const clips = [makeClip({ id: "a", duration: 20, trimOut: 20 }), makeClip({ id: "next", startTime: 20, duration: 5, trimOut: 5 })];
    const plan = planClipSpeedChange(clips, "a", 2)!;
    const cmd = new ReplaceClipsCommand("Change Speed", plan.before, plan.after);
    const applied = cmd.apply({ clips, epoch: 0 });
    expect(applied.clips.find((c) => c.id === "next")!.startTime).toBe(10);
    const undone = cmd.invert().apply(applied);
    expect(undone.clips).toEqual(clips);
  });
});

describe("splitting a clip that has a speed", () => {
  it("keeps the two halves continuous in the source and adding up to the original duration", () => {
    const clip = makeClip({ startTime: 0, trimIn: 0, trimOut: 90, duration: 45, speed: 2 });
    const state = new SplitClipCommand("a", 10, clip).apply({ clips: [clip], epoch: 0 });
    const left = state.clips.find((c) => c.id === "a")!;
    const right = state.clips.find((c) => c.id !== "a")!;
    expect(left.duration).toBe(10);
    expect(left.trimOut).toBe(20); // 10 timeline seconds at 2x = 20 source seconds
    expect(right.trimIn).toBe(20);
    expect(right.trimOut).toBe(90);
    expect(right.duration).toBe(35);
    expect(left.duration + right.duration).toBe(45);
    expect(right.speed).toBe(2);
  });
});

describe("export audio with speed", () => {
  const asset: MediaAsset = { id: "m1", name: "v.mp4", path: "/v.mp4", type: "video", duration: 90, size: 1 };
  const track: Track = { id: "t1", type: "video", name: "V", muted: false, locked: false, visible: true, height: 60 } as Track;

  it("reads duration * speed seconds of source and tells ffmpeg the speed", () => {
    const clip = makeClip({ startTime: 0, trimIn: 0, trimOut: 90, duration: 60, speed: 1.5 });
    const [input] = buildExportAudioInputs([clip], [track], [asset], 0, 60);
    expect(input.speed).toBe(1.5);
    expect(input.duration).toBe(60);
    expect(input.trimIn).toBe(0);
  });

  it("an export range that starts inside a sped-up clip starts at the matching source position", () => {
    const clip = makeClip({ startTime: 0, trimIn: 0, trimOut: 90, duration: 45, speed: 2 });
    const [input] = buildExportAudioInputs([clip], [track], [asset], 10, 45);
    expect(input.trimIn).toBe(20);
    expect(input.startTime).toBe(0);
    expect(input.duration).toBe(35);
  });

  it("normal clips are unchanged (speed 1)", () => {
    const [input] = buildExportAudioInputs([makeClip({ duration: 10, trimOut: 10 })], [track], [asset], 0, 10);
    expect(input.speed).toBe(1);
  });
});
