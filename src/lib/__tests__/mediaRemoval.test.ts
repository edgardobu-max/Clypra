import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn().mockResolvedValue(undefined) }));

import { removeMediaFromProject } from "../mediaRemoval";
import { useProjectStore } from "@/store/projectStore";
import { useTimelineStore } from "@/store/timelineStore";
import { useUIStore } from "@/store/uiStore";
import type { Clip, MediaAsset, Track } from "@/types";

const track = (id: string, type: Track["type"]): Track => ({ id, type, name: id, muted: false, locked: false, visible: true, height: 60 });
const asset = (id: string, type: MediaAsset["type"]): MediaAsset => ({ id, name: id, path: `C:/m/${id}.mp4`, type, duration: 10, size: 1 });
const clip = (id: string, trackId: string, mediaId: string, startTime = 0): Clip => ({ id, trackId, mediaId, startTime, duration: 5, trimIn: 0, trimOut: 5, x: 0, y: 0, width: 1, height: 1, opacity: 1, rotation: 0 }) as Clip;

describe("removeMediaFromProject", () => {
  beforeEach(() => {
    useProjectStore.setState({ mediaAssets: [asset("a", "video"), asset("b", "audio"), asset("c", "video")] });
    useTimelineStore.setState({
      tracks: [track("tv", "video"), track("ta", "audio")],
      clips: [clip("c1", "tv", "a", 0), clip("c2", "tv", "c", 5), clip("c3", "ta", "b", 0)],
      mainVideoTrackId: "tv",
      epoch: 0,
    });
    useUIStore.setState({ previewMediaId: null, previewMode: "program", selectedClipIds: [] });
  });

  it("removes the asset AND every timeline clip that uses it", () => {
    const result = removeMediaFromProject(["a"]);
    expect(result).toEqual({ assets: 1, clips: 1 });
    expect(useProjectStore.getState().mediaAssets.map((x) => x.id)).toEqual(["b", "c"]);
    expect(useTimelineStore.getState().clips.some((c) => c.mediaId === "a")).toBe(false);
    expect(useTimelineStore.getState().clips.map((c) => c.id)).toEqual(expect.arrayContaining(["c2", "c3"]));
  });

  it("removes several assets at once", () => {
    const result = removeMediaFromProject(["a", "b"]);
    expect(result).toEqual({ assets: 2, clips: 2 });
    expect(useProjectStore.getState().mediaAssets.map((x) => x.id)).toEqual(["c"]);
    expect(useTimelineStore.getState().clips.map((c) => c.mediaId)).toEqual(["c"]);
  });

  it("clears the source monitor and the selection when they pointed at removed media", () => {
    useUIStore.setState({ previewMediaId: "a", previewMode: "source", selectedClipIds: ["c1", "c2"] });
    removeMediaFromProject(["a"]);
    const ui = useUIStore.getState();
    expect(ui.previewMediaId).toBeNull();
    expect(ui.previewMode).toBe("program");
    expect(ui.selectedClipIds).toEqual(["c2"]);
  });

  it("keeps the preview when a different asset is removed, and handles unused assets", () => {
    useUIStore.setState({ previewMediaId: "c", previewMode: "source" });
    useProjectStore.setState({ mediaAssets: [...useProjectStore.getState().mediaAssets, asset("unused", "image")] });
    expect(removeMediaFromProject(["unused"])).toEqual({ assets: 1, clips: 0 });
    expect(useUIStore.getState().previewMediaId).toBe("c");
  });

  it("does nothing for an empty list", () => {
    expect(removeMediaFromProject([])).toEqual({ assets: 0, clips: 0 });
    expect(useProjectStore.getState().mediaAssets).toHaveLength(3);
  });
});
