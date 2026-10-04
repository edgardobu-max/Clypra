import { describe, it, expect } from "vitest";
import { getInsertIndexForNewTrack, sortTracksVisualFirst } from "../timelineStore";
import type { Track } from "@/types";

const t = (id: string, type: Track["type"]): Track => ({ id, type, name: id, muted: false, locked: false, visible: true, height: 50 });

describe("getInsertIndexForNewTrack", () => {
  it("puts new video and text tracks at the very top", () => {
    const tracks = [t("main", "video"), t("a1", "audio")];
    expect(getInsertIndexForNewTrack(tracks, "video")).toBe(0);
    expect(getInsertIndexForNewTrack(tracks, "text")).toBe(0);
  });

  it("puts the first audio track right under the visual tracks", () => {
    const tracks = [t("overlay", "video"), t("main", "video")];
    expect(getInsertIndexForNewTrack(tracks, "audio")).toBe(2);
  });

  it("puts every further audio track below the previous audio tracks", () => {
    const tracks = [t("overlay", "video"), t("main", "video"), t("voice", "audio")];
    expect(getInsertIndexForNewTrack(tracks, "audio")).toBe(3);
    const withMusic = [...tracks, t("music", "audio")];
    expect(getInsertIndexForNewTrack(withMusic, "audio")).toBe(4);
  });

  it("appends audio on an empty timeline", () => {
    expect(getInsertIndexForNewTrack([], "audio")).toBe(0);
  });
});

describe("sortTracksVisualFirst", () => {
  it("moves audio below video/text keeping relative order", () => {
    const sorted = sortTracksVisualFirst([t("a1", "audio"), t("v1", "video"), t("a2", "audio"), t("tx", "text")]);
    expect(sorted.map((x) => x.id)).toEqual(["v1", "tx", "a1", "a2"]);
  });
});
