import { describe, it, expect } from "vitest";
import { buildExportAudioInputs } from "../exportAudio";
import type { Clip, Track, MediaAsset } from "@/types";

const track = (id: string, over: Partial<Track> = {}): Track => ({ id, type: "audio", name: id, muted: false, locked: false, visible: true, height: 60, ...over });
const asset = (id: string, type: MediaAsset["type"], path = `C:\\media\\${id}.mp4`): MediaAsset => ({ id, name: id, path, type, duration: 60, size: 1 });
const clip = (over: Partial<Clip> & { id: string; trackId: string; mediaId: string }): Clip =>
  ({ startTime: 0, duration: 10, trimIn: 0, trimOut: 10, x: 0, y: 0, width: 1, height: 1, opacity: 1, rotation: 0, ...over }) as Clip;

describe("buildExportAudioInputs", () => {
  it("includes audio clips and video clips, skips images and text", () => {
    const clips = [
      clip({ id: "v", trackId: "tv", mediaId: "vid" }),
      clip({ id: "a", trackId: "ta", mediaId: "aud", startTime: 2 }),
      clip({ id: "i", trackId: "tv", mediaId: "img" }),
      { ...clip({ id: "t", trackId: "tt", mediaId: "" }), text: "Hola" } as unknown as Clip,
    ];
    const out = buildExportAudioInputs(clips, [track("tv", { type: "video" }), track("ta"), track("tt", { type: "text" })], [asset("vid", "video"), asset("aud", "audio"), asset("img", "image")], 0, 20);
    expect(out.map((i) => i.path)).toEqual(["C:\\media\\vid.mp4", "C:\\media\\aud.mp4"]);
  });

  it("skips muted and hidden tracks (same rules as the preview)", () => {
    const clips = [clip({ id: "m", trackId: "muted", mediaId: "a" }), clip({ id: "h", trackId: "hidden", mediaId: "a" }), clip({ id: "ok", trackId: "ok", mediaId: "a" })];
    const out = buildExportAudioInputs(clips, [track("muted", { muted: true }), track("hidden", { visible: false }), track("ok")], [asset("a", "audio")], 0, 20);
    expect(out).toHaveLength(1);
  });

  it("carries position, trim, volume and fades", () => {
    const c = clip({ id: "a", trackId: "ta", mediaId: "a", startTime: 3, duration: 8, trimIn: 1.5, volume: 0.4, audioFadeIn: 1, audioFadeOut: 2 });
    const [i] = buildExportAudioInputs([c], [track("ta")], [asset("a", "audio")], 0, 60);
    expect(i).toMatchObject({ startTime: 3, trimIn: 1.5, duration: 8, volume: 0.4, fadeIn: 1, fadeOut: 2 });
  });

  it("clips to the export range, advancing trim and dropping the cut fades", () => {
    // clip 0-10, export 4-8 -> uses source 4..8, starts at 0 in the export
    const c = clip({ id: "a", trackId: "ta", mediaId: "a", startTime: 0, duration: 10, trimIn: 2, audioFadeIn: 1, audioFadeOut: 1 });
    const [i] = buildExportAudioInputs([c], [track("ta")], [asset("a", "audio")], 4, 8);
    expect(i).toMatchObject({ startTime: 0, trimIn: 6, duration: 4, fadeIn: 0, fadeOut: 0 });
  });

  it("drops clips outside the range and defaults volume to 1", () => {
    const before = clip({ id: "b", trackId: "ta", mediaId: "a", startTime: 0, duration: 2 });
    const inside = clip({ id: "i", trackId: "ta", mediaId: "a", startTime: 5, duration: 2 });
    const out = buildExportAudioInputs([before, inside], [track("ta")], [asset("a", "audio")], 3, 30);
    expect(out).toHaveLength(1);
    expect(out[0].volume).toBe(1);
  });

  it("passes a boosted volume (above 100 %) through to the mixer instead of capping it", () => {
    const [loud] = buildExportAudioInputs([clip({ id: "a", trackId: "ta", mediaId: "a", volume: 2.5 })], [track("ta")], [asset("a", "audio")], 0, 60);
    expect(loud.volume).toBe(2.5);
    const [capped] = buildExportAudioInputs([clip({ id: "b", trackId: "ta", mediaId: "a", volume: 12 })], [track("ta")], [asset("a", "audio")], 0, 60);
    expect(capped.volume).toBe(4); // the same ceiling the Rust side enforces
  });

  it("orders inputs by start time", () => {
    const late = clip({ id: "l", trackId: "ta", mediaId: "a", startTime: 9 });
    const early = clip({ id: "e", trackId: "ta", mediaId: "a", startTime: 1 });
    const out = buildExportAudioInputs([late, early], [track("ta")], [asset("a", "audio")], 0, 30);
    expect(out.map((i) => i.startTime)).toEqual([1, 9]);
  });
});
