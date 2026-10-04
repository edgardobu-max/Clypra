/**
 * Export sizes follow the project's canvas.
 *
 * Presets are defined by their SHORT side (720p, 1080p, 4K = 2160). The long side comes from
 * the canvas aspect ratio, so a 9:16 project exports 1080×1920, a 16:9 one 1920×1080 and a
 * square one 1080×1080 — instead of every preset forcing landscape and distorting vertical
 * projects.
 */

/** Nearest even integer (H.264 with yuv420p needs even dimensions). */
function even(n: number): number {
  return Math.max(2, 2 * Math.round(n / 2));
}

export interface ExportSize {
  width: number;
  height: number;
}

export function exportSizeForShortSide(shortSide: number, canvasWidth: number, canvasHeight: number): ExportSize {
  if (!(canvasWidth > 0) || !(canvasHeight > 0)) {
    return { width: even((shortSide * 16) / 9), height: even(shortSide) };
  }
  const aspect = canvasWidth / canvasHeight;
  if (aspect >= 1) {
    return { width: even(shortSide * aspect), height: even(shortSide) };
  }
  return { width: even(shortSide), height: even(shortSide / aspect) };
}

export type CanvasOrientation = "landscape" | "portrait" | "square";

export function canvasOrientation(canvasWidth: number, canvasHeight: number): CanvasOrientation {
  if (Math.abs(canvasWidth - canvasHeight) <= 1) return "square";
  return canvasWidth > canvasHeight ? "landscape" : "portrait";
}

export function formatSize({ width, height }: ExportSize): string {
  return `${width}×${height}`;
}
