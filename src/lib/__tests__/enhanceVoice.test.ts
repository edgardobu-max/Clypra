import { describe, it, expect } from "vitest";
import type { Clip, MediaAsset } from "@/types";
import { buildEnhancedAsset, buildMediaSwapCommand, sourceAssetFor } from "../enhanceVoice";

const original: MediaAsset = { id: "voz", name: "nota.m4a", path: "C:/v/nota.m4a", type: "audio", duration: 61.2, size: 100, folderId: "base", posterFrame: "poster" };

function clip(id: string, mediaId: string): Clip {
  return { id, trackId: "t", mediaId, startTime: 0, duration: 5, trimIn: 0, trimOut: 5, x: 0, y: 0, width: 1, height: 1, opacity: 1, rotation: 0 };
}

describe("buildEnhancedAsset", () => {
  it("is a new bin entry next to the original: same folder and artwork, new path, linked back to the original", () => {
    const enhanced = buildEnhancedAsset(original, "C:/v/nota_mejorado.m4a", { duration: 61.25 }, 2000);
    expect(enhanced.id).not.toBe(original.id);
    expect(enhanced.name).toBe("nota.m4a (mejorado)");
    expect(enhanced.path).toBe("C:/v/nota_mejorado.m4a");
    expect(enhanced.duration).toBe(61.25);
    expect(enhanced.enhancedFromId).toBe("voz");
    expect(enhanced.folderId).toBe("base");
    expect(enhanced.posterFrame).toBe("poster");
    expect(enhanced.size).toBe(2000);
  });

  it("does not stack suffixes and keeps the original duration when the probe gives none", () => {
    const first = buildEnhancedAsset(original, "x", { duration: 0 });
    expect(first.duration).toBe(61.2);
    const again = buildEnhancedAsset({ ...first, name: "nota.m4a (mejorado)" }, "y", {});
    expect(again.name).toBe("nota.m4a (mejorado)");
  });

  it("takes the new picture size for videos only", () => {
    const video: MediaAsset = { id: "v", name: "a.mp4", path: "a.mp4", type: "video", duration: 5, width: 1080, height: 1920, size: 1 };
    const out = buildEnhancedAsset(video, "a_mejorado.mp4", { duration: 5, width: 1080, height: 1920 });
    expect(out.width).toBe(1080);
    expect(out.height).toBe(1920);
    expect(buildEnhancedAsset(original, "z", { width: 5, height: 5 }).width).toBeUndefined();
  });
});

describe("sourceAssetFor", () => {
  it("always starts from the original recording, so changing the level never processes twice", () => {
    const enhanced = buildEnhancedAsset(original, "p", {});
    expect(sourceAssetFor(enhanced, [original, enhanced]).id).toBe("voz");
    expect(sourceAssetFor(original, [original, enhanced]).id).toBe("voz");
    // original missing from the bin: fall back to what we have
    expect(sourceAssetFor(enhanced, [enhanced]).id).toBe(enhanced.id);
  });
});

describe("buildMediaSwapCommand", () => {
  it("switches every clip of the recording in one undoable step and leaves other clips alone", () => {
    const clips = [clip("a", "voz"), clip("b", "voz"), clip("c", "otro")];
    const cmd = buildMediaSwapCommand(clips, "voz", "voz2", "Mejorar audio")!;
    const state = cmd.apply({ clips, epoch: 0 } as any) as { clips: Clip[] };
    expect(state.clips.map((c) => c.mediaId)).toEqual(["voz2", "voz2", "otro"]);
    const undone = cmd.invert().apply(state as any) as { clips: Clip[] };
    expect(undone.clips.map((c) => c.mediaId)).toEqual(["voz", "voz", "otro"]);
  });

  it("returns null when no clip uses the recording", () => {
    expect(buildMediaSwapCommand([clip("c", "otro")], "voz", "voz2", "x")).toBeNull();
  });
});
