import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));

import { coverFitRect } from "../coverExport";
import { joinExportPath } from "../exportFolder";

describe("coverFitRect (cover fit, centre crop)", () => {
  it("crops the sides of a wide image drawn into a vertical frame", () => {
    // 1920x1080 into 1080x1920: keep full height, crop width to the target aspect
    const r = coverFitRect(1920, 1080, 1080, 1920);
    expect(r.sh).toBe(1080);
    expect(r.sw).toBeCloseTo(1080 * (1080 / 1920));
    expect(r.sx).toBeCloseTo((1920 - r.sw) / 2);
    expect(r.sy).toBe(0);
  });

  it("crops top and bottom of a tall image drawn into a wide frame", () => {
    const r = coverFitRect(1080, 1920, 1920, 1080);
    expect(r.sw).toBe(1080);
    expect(r.sh).toBeCloseTo(1080 / (1920 / 1080));
    expect(r.sy).toBeCloseTo((1920 - r.sh) / 2);
    expect(r.sx).toBe(0);
  });

  it("uses the whole image when the aspect already matches", () => {
    expect(coverFitRect(1080, 1920, 540, 960)).toEqual({ sx: 0, sy: 0, sw: 1080, sh: 1920 });
  });
});

describe("joinExportPath", () => {
  it("keeps the folder's separator style", () => {
    const bs = String.fromCharCode(92);
    expect(joinExportPath(["D:", "Videos", "Post"].join(bs), "Post", "mp4")).toBe(["D:", "Videos", "Post", "Post.mp4"].join(bs));
    expect(joinExportPath("/home/u/Post", "Post (copia 1)", "mov")).toBe("/home/u/Post/Post (copia 1).mov");
  });
});
