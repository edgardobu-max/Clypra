import type { TextClip } from "@/types";
import { createTextClip } from "@/lib/textClip";
import type { ClipIntro } from "@/lib/introAnimation";

/** One-click title look (box, colours, type) plus its default entrance animation. */
export interface TitlePreset {
  id: string;
  name: string;
  description: string;
  fontFamily: string;
  fontWeight: "normal" | "bold";
  color: string;
  uppercase: boolean;
  /** Font size as a share of the canvas width (keeps the look across 9:16 / 16:9 / 1:1). */
  fontSizeRatio: number;
  /** Text box width as a share of the canvas width. */
  boxWidthRatio: number;
  /** Vertical position of the box centre as a share of the canvas height. */
  centerY: number;
  lineHeight: number;
  background: { color: string; padding: number; borderRadius: number; opacity: number; borderColor?: string; borderWidth?: number };
  shadow?: { color: string; blur: number; offsetX: number; offsetY: number };
  intro: ClipIntro;
}

export const BUILT_IN_TITLE_PRESETS: TitlePreset[] = [
  {
    id: "news-navy-gold",
    name: "News — navy box",
    description: "White bold caps on a dark navy box with a gold edge. Slides in from the left with a slight bounce.",
    fontFamily: "Montserrat Variable",
    fontWeight: "bold",
    color: "#FFFFFF",
    uppercase: true,
    fontSizeRatio: 0.05,
    boxWidthRatio: 0.88,
    centerY: 0.2,
    lineHeight: 1.2,
    background: { color: "#0B1F4B", padding: 20, borderRadius: 10, opacity: 92, borderColor: "#E0B84A", borderWidth: 3 },
    intro: { type: "slide-left", duration: 0.6, bounce: true },
  },
  {
    id: "news-black-red",
    name: "News — red alert",
    description: "White bold caps on a black box with a red edge. Slides in from the left.",
    fontFamily: "Montserrat Variable",
    fontWeight: "bold",
    color: "#FFFFFF",
    uppercase: true,
    fontSizeRatio: 0.05,
    boxWidthRatio: 0.88,
    centerY: 0.2,
    lineHeight: 1.2,
    background: { color: "#111111", padding: 20, borderRadius: 6, opacity: 92, borderColor: "#D7263D", borderWidth: 3 },
    intro: { type: "slide-left", duration: 0.6, bounce: true },
  },
  {
    id: "clean-headline",
    name: "Clean headline",
    description: "Large white text with a soft shadow and no box. Fades in.",
    fontFamily: "Montserrat Variable",
    fontWeight: "bold",
    color: "#FFFFFF",
    uppercase: false,
    fontSizeRatio: 0.06,
    boxWidthRatio: 0.88,
    centerY: 0.2,
    lineHeight: 1.15,
    background: { color: "#000000", padding: 0, borderRadius: 0, opacity: 0 },
    shadow: { color: "#000000", blur: 12, offsetX: 0, offsetY: 3 },
    intro: { type: "fade", duration: 0.5 },
  },
];

export interface CreateTitleOptions {
  trackId: string;
  startTime: number;
  duration?: number;
  text: string;
  canvasWidth: number;
  canvasHeight: number;
  preset: TitlePreset;
  /** Overrides the preset's entrance animation. */
  intro?: ClipIntro;
}

/** Builds a title clip from a preset: 10 s by default, styled box, entrance animation, no outro. */
export function createTitleClip({ trackId, startTime, duration = 10, text, canvasWidth, canvasHeight, preset, intro }: CreateTitleOptions): TextClip {
  const fontSize = Math.round(canvasWidth * preset.fontSizeRatio);
  const clip = createTextClip({
    trackId,
    startTime,
    duration,
    text: preset.uppercase ? text.toUpperCase() : text,
    canvasWidth,
    canvasHeight,
    fontSize,
    fontFamily: preset.fontFamily,
    color: preset.color,
    fontWeight: preset.fontWeight,
    boxWidthRatio: preset.boxWidthRatio,
    position: "center",
  });

  const width = canvasWidth * preset.boxWidthRatio;
  const hasBox = preset.background.opacity > 0;
  return {
    ...clip,
    x: (canvasWidth - width) / 2,
    y: canvasHeight * preset.centerY - clip.height / 2,
    width,
    lineHeight: preset.lineHeight,
    background: hasBox ? { ...preset.background } : undefined,
    shadow: preset.shadow,
    intro: intro ?? preset.intro,
  };
}
