/**
 * Text Clip Creation Utilities
 *
 * Helpers for creating text clips with sensible defaults.
 */

import type { TextClip } from "../types";
import { generateId } from "./id";

export interface CreateTextClipOptions {
  /** Track ID to place the clip on */
  trackId: string;

  /** Start time on timeline */
  startTime: number;

  /** Duration in seconds */
  duration?: number;

  /** Text content */
  text?: string;

  /** Canvas dimensions for positioning */
  canvasWidth: number;
  canvasHeight: number;

  /** Font size */
  fontSize?: number;

  /** Font family */
  fontFamily?: string;

  /** Text color */
  color?: string;

  /** Bold */
  bold?: boolean;

  /** Italic */
  italic?: boolean;

  /** Position preset */
  /** Fixed box width as a share of the canvas width (e.g. 0.9 for captions); text wraps inside it. */
  boxWidthRatio?: number;
  position?: "center" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

  // Additional style parameters for custom presets/effects/templates
  styleId?: string;
  templateId?: string;
  fontWeight?: string | number;
  fontStyle?: "normal" | "italic";
  stroke?: { color: string; width: number };
  shadow?: { color: string; blur: number; offsetX: number; offsetY: number };
  background?: { color: string; padding: number; borderRadius: number };
}

function measureTextWidth(text: string, fontFamily: string, fontSize: number, bold: boolean): number {
  try {
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
    const ctx = canvas.getContext("2d") as any;
    if (!ctx) return text.length * fontSize * 0.6; // Fallback estimate
    ctx.font = `${bold ? "bold" : "normal"} ${fontSize}px ${fontFamily}`;
    const metrics = ctx.measureText(text);
    return metrics.width;
  } catch (e) {
    return text.length * fontSize * 0.6; // Fallback estimate
  }
}

/**
 * Create a text clip with sensible defaults.
 */
export function createTextClip(options: CreateTextClipOptions): TextClip {
  const defaultFontSize = options.styleId ? 96 : 48;
  const {
    trackId,
    startTime,
    duration = 5.0,
    text = "Text",
    canvasWidth,
    canvasHeight,
    fontSize = defaultFontSize,
    fontFamily = "Inter, system-ui, sans-serif",
    color = "#ffffff",
    bold = false,
    italic = false,
    position = "center",
    boxWidthRatio,
    styleId,
    templateId,
    fontWeight,
    fontStyle,
    stroke,
    shadow,
    background,
  } = options;

  // Measure the actual width of the text at the target fontSize to fit the bounding box
  const isBold = bold || fontWeight === "bold" || (typeof fontWeight === "number" && fontWeight >= 700);
  const measuredWidth = measureTextWidth(text, fontFamily, fontSize, isBold);

  // Dynamic Bounding Box: measured width + padding, constrained by canvas width
  const boxWidth = boxWidthRatio ? canvasWidth * boxWidthRatio : Math.min(canvasWidth * 0.95, Math.max(120, measuredWidth + fontSize * 0.8));
  // A fixed-width box holds two wrapped lines; the renderer grows it further if needed.
  const boxHeight = boxWidthRatio ? fontSize * 2.6 : fontSize * 1.5;

  // Calculate position based on preset using the dynamic box sizes
  const { x, y, width, height } = calculateTextPosition(position, canvasWidth, canvasHeight, boxWidth, boxHeight);

  return {
    id: generateId("text-clip"),
    trackId,
    mediaId: "", // Text clips don't have media assets
    startTime,
    duration,
    trimIn: 0,
    trimOut: duration,
    x,
    y,
    width,
    height,
    opacity: 1.0,
    rotation: 0,
    aspectRatioLocked: false,
    text,
    fontSize,
    fontFamily,
    color,
    fontWeight: fontWeight || (bold ? "bold" : "normal"),
    fontStyle: fontStyle || (italic ? "italic" : "normal"),
    align: "center",
    valign: "middle",
    lineHeight: 1.2,
    letterSpacing: 0,
    paddingX: 16,
    paddingY: 16,
    styleId,
    templateId,
    stroke,
    shadow,
    background,
  };
}

/**
 * Calculate text position based on preset.
 */
function calculateTextPosition(
  position: "center" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right",
  canvasWidth: number,
  canvasHeight: number,
  boxWidth: number,
  boxHeight: number
): { x: number; y: number; width: number; height: number } {
  const margin = 40; // Margin from edges

  switch (position) {
    case "center":
      return {
        x: (canvasWidth - boxWidth) / 2,
        y: (canvasHeight - boxHeight) / 2,
        width: boxWidth,
        height: boxHeight,
      };

    case "top":
      return {
        x: (canvasWidth - boxWidth) / 2,
        y: margin,
        width: boxWidth,
        height: boxHeight,
      };

    case "bottom":
      return {
        x: (canvasWidth - boxWidth) / 2,
        y: canvasHeight - boxHeight - margin,
        width: boxWidth,
        height: boxHeight,
      };

    case "top-left":
      return {
        x: margin,
        y: margin,
        width: boxWidth,
        height: boxHeight,
      };

    case "top-right":
      return {
        x: canvasWidth - boxWidth - margin,
        y: margin,
        width: boxWidth,
        height: boxHeight,
      };

    case "bottom-left":
      return {
        x: margin,
        y: canvasHeight - boxHeight - margin,
        width: boxWidth,
        height: boxHeight,
      };

    case "bottom-right":
      return {
        x: canvasWidth - boxWidth - margin,
        y: canvasHeight - boxHeight - margin,
        width: boxWidth,
        height: boxHeight,
      };

    default:
      return {
        x: (canvasWidth - boxWidth) / 2,
        y: (canvasHeight - boxHeight) / 2,
        width: boxWidth,
        height: boxHeight,
      };
  }
}

/**
 * Text preset configurations.
 */
export const TEXT_PRESETS = {
  title: {
    fontSize: 72,
    bold: true,
    position: "center" as const,
  },
  subtitle: {
    fontSize: 48,
    bold: false,
    position: "center" as const,
  },
  lowerThird: {
    fontSize: 32,
    bold: false,
    position: "bottom-left" as const,
  },
  caption: {
    fontSize: 24,
    bold: false,
    position: "bottom" as const,
  },
  headline: {
    fontSize: 64,
    bold: true,
    position: "top" as const,
  },
  quote: {
    fontSize: 36,
    italic: true,
    position: "center" as const,
  },
} as const;
