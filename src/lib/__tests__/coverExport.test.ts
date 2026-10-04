import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));

import { coverPathForVideo } from "../coverExport";

const BS = String.fromCharCode(92); // backslash
const win = (...parts: string[]) => parts.join(BS);

describe("coverPathForVideo", () => {
  it("replaces the video extension with _cover.png, keeping the folder", () => {
    expect(coverPathForVideo(win("D:", "Videos", "Untitled Project.mp4"))).toBe(win("D:", "Videos", "Untitled Project_cover.png"));
    expect(coverPathForVideo("/home/u/reel.final.mov")).toBe("/home/u/reel.final_cover.png");
  });

  it("handles names without an extension and dots in folder names", () => {
    expect(coverPathForVideo(win("C:", "my.videos", "clip"))).toBe(win("C:", "my.videos", "clip_cover.png"));
    expect(coverPathForVideo("clip")).toBe("clip_cover.png");
  });
});
