import { describe, it, expect } from "vitest";
import { exportSizeForShortSide, canvasOrientation, formatSize } from "../exportSizes";

describe("exportSizeForShortSide", () => {
  it("keeps landscape projects landscape", () => {
    expect(exportSizeForShortSide(1080, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(exportSizeForShortSide(720, 1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(exportSizeForShortSide(2160, 1920, 1080)).toEqual({ width: 3840, height: 2160 });
  });

  it("exports 9:16 projects vertically (1080x1920), not forced landscape", () => {
    expect(exportSizeForShortSide(1080, 1080, 1920)).toEqual({ width: 1080, height: 1920 });
    expect(exportSizeForShortSide(720, 1080, 1920)).toEqual({ width: 720, height: 1280 });
    expect(exportSizeForShortSide(2160, 1080, 1920)).toEqual({ width: 2160, height: 3840 });
  });

  it("exports square projects as 1080x1080", () => {
    expect(exportSizeForShortSide(1080, 1080, 1080)).toEqual({ width: 1080, height: 1080 });
  });

  it("handles 4:5 and always returns even dimensions", () => {
    const s = exportSizeForShortSide(1080, 1080, 1350);
    expect(s).toEqual({ width: 1080, height: 1350 });
    for (const [w, h] of [[1000, 777], [777, 1000], [1234, 567]]) {
      const r = exportSizeForShortSide(1080, w, h);
      expect(r.width % 2).toBe(0);
      expect(r.height % 2).toBe(0);
    }
  });

  it("falls back to 16:9 when the canvas is unknown", () => {
    expect(exportSizeForShortSide(1080, 0, 0)).toEqual({ width: 1920, height: 1080 });
  });
});

describe("canvasOrientation / formatSize", () => {
  it("classifies canvases", () => {
    expect(canvasOrientation(1080, 1920)).toBe("portrait");
    expect(canvasOrientation(1920, 1080)).toBe("landscape");
    expect(canvasOrientation(1080, 1080)).toBe("square");
    expect(formatSize({ width: 1080, height: 1920 })).toBe("1080×1920");
  });
});
