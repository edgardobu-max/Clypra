/**
 * Canonical Timeline Scene Evaluator
 *
 * This is the SINGLE SOURCE OF TRUTH for NLE timeline evaluation.
 * All rendering paths use this:
 * - Preview
 * - Export
 * - Thumbnails
 * - Proxies
 *
 * NOTE: The function is named evaluateTimelineScene (not evaluateScene) to
 * avoid collision with @clypra/engine's evaluateScene, which takes a
 * SceneDocument and draws directly to a Canvas 2D context. These two
 * functions operate at different layers:
 *
 *   evaluateTimelineScene  → reads Clips/Tracks/Assets → produces EvaluatedScene
 *   engine.evaluateScene   → reads SceneDocument       → draws pixels
 */

import type { Clip, Track, MediaAsset, Project, TextClip } from "@/types";
import type { EvaluatedScene, EvaluatedVisualLayer, EvaluatedMediaLayer, EvaluatedTextLayer, EvaluatedAudioLayer, EvaluatedTransition, SceneMetadata, BlendMode } from "./types";
import { toCompositorClips } from "../timeline/adapter";
import { getClipEndTime } from "@/lib/timelineClip";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getEvaluationCache, computeClipVersion } from "./cache";
import { evaluateProperty } from "./animation";

/**
 * Evaluate the NLE timeline at a specific time.
 * Returns a complete EvaluatedScene ready for rasterization.
 *
 * @param time    - Timeline time in seconds
 * @param clips   - All clips in timeline
 * @param tracks  - All tracks
 * @param assets  - All media assets
 * @param project - Project settings
 */
export function evaluateTimelineScene(time: number, clips: Clip[], tracks: Track[], assets: MediaAsset[], project: Project | null): EvaluatedScene {
  // Convert to compositor clips (adds roles, priorities)
  const compositorClips = toCompositorClips(clips, tracks);

  // Build lookup maps for performance
  const trackMap = new Map(tracks.map((track) => [track.id, track]));
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));

  // ─── 1. Active Clip Resolution (Contract §1) ─────────────────────────────

  const activeClips = compositorClips.filter((clip) => {
    const clipEnd = getClipEndTime(clip);
    const isInTimeBounds = clip.startTime <= time && time < clipEnd;
    const track = trackMap.get(clip.trackId);
    const isVisible = track?.visible ?? true;
    return isInTimeBounds && isVisible;
  });

  // ─── 2. Compositing Order (Contract §2) ───────────────────────────────────

  const sortedClips = activeClips.sort((a, b) => {
    const roleOrder = getRoleOrder(a.role) - getRoleOrder(b.role);
    if (roleOrder !== 0) return roleOrder;
    // Higher track index renders below lower index (top track in UI = on top)
    const trackOrder = b.trackIndex - a.trackIndex;
    if (trackOrder !== 0) return trackOrder;
    const zOrder = a.zIndex - b.zIndex;
    if (zOrder !== 0) return zOrder;
    return a.evaluationPriority - b.evaluationPriority;
  });

  // ─── 3. Evaluate Visual Layers ────────────────────────────────────────────

  const visualLayers: EvaluatedVisualLayer[] = [];

  for (let i = 0; i < sortedClips.length; i++) {
    const clip = sortedClips[i];
    const offset = time - clip.startTime;
    const kf = (clip as any).keyframes || {};

    const evalX = kf.x !== undefined ? evaluateProperty(kf.x, offset, clip.duration) : clip.x;
    const evalY = kf.y !== undefined ? evaluateProperty(kf.y, offset, clip.duration) : clip.y;
    const evalW = kf.width !== undefined ? evaluateProperty(kf.width, offset, clip.duration) : clip.width;
    const evalH = kf.height !== undefined ? evaluateProperty(kf.height, offset, clip.duration) : clip.height;
    const evalRot = kf.rotation !== undefined ? evaluateProperty(kf.rotation, offset, clip.duration) : clip.rotation;
    const evalOpacity = kf.opacity !== undefined ? evaluateProperty(kf.opacity, offset, clip.duration) : clip.opacity;

    const isTextClip = "text" in clip;

    if (isTextClip) {
      const textClip = clip as unknown as TextClip;
      const transitionState = evaluateTransitionState(clip, time, sortedClips);

      const evalFontSize = kf.fontSize !== undefined ? evaluateProperty(kf.fontSize, offset, clip.duration) : textClip.fontSize || 48;
      const evalColor = kf.color !== undefined ? evaluateProperty(kf.color, offset, clip.duration) : textClip.color || "#ffffff";
      const evalLetterSpacing = kf.letterSpacing !== undefined ? evaluateProperty(kf.letterSpacing, offset, clip.duration) : textClip.letterSpacing || 0;
      const evalLineHeight = kf.lineHeight !== undefined ? evaluateProperty(kf.lineHeight, offset, clip.duration) : textClip.lineHeight || 1.2;

      const textLayer: EvaluatedTextLayer = {
        layerId: `${clip.id}-${time}`,
        clipId: clip.id,
        role: clip.role,
        zIndex: i,
        layerType: "text",
        time,
        clipStartTime: clip.startTime,
        clipDuration: clip.duration,
        x: evalX,
        y: evalY,
        width: evalW,
        height: evalH,
        rotation: evalRot,
        opacity: evalOpacity * (transitionState.opacity ?? 1.0),
        inTransition: transitionState.inTransition,
        transitionType: transitionState.type,
        transitionProgress: transitionState.progress,
        blendMode: (clip as any).blendMode || "normal",
        text: textClip.text || "Text",
        fontFamily: normalizeFontFamily(textClip.fontFamily || "Inter Variable"),
        fontSize: evalFontSize,
        color: evalColor,
        fontWeight: (textClip.fontWeight || "normal") as "normal" | "bold" | number,
        fontStyle: textClip.fontStyle || "normal",
        textAlign: textClip.align || "center",
        verticalAlign: textClip.valign || "middle",
        lineHeight: evalLineHeight,
        letterSpacing: evalLetterSpacing,
        stroke: textClip.stroke,
        shadow: textClip.shadow,
        background: textClip.background,
        styleId: textClip.styleId,
      };

      visualLayers.push(textLayer);
      continue;
    }

    // ── Media layers ──────────────────────────────────────────────────────────
    const asset = assetMap.get(clip.mediaId);
    if (!asset || (asset.type !== "video" && asset.type !== "image")) continue;

    const sourceTime = clip.trimIn + (time - clip.startTime);
    const sourcePath = asset.path ? convertFileSrc(asset.path) : asset.posterFrame || "";
    if (!sourcePath) continue;

    const transitionState = evaluateTransitionState(clip, time, sortedClips);

    const mediaLayer: EvaluatedMediaLayer = {
      layerId: `${clip.id}-${time}`,
      clipId: clip.id,
      role: clip.role,
      zIndex: i,
      layerType: "media",
      mediaId: clip.mediaId,
      mediaType: asset.type === "video" ? "video" : "image",
      sourcePath,
      posterFrame: asset.posterFrame,
      sourceTime,
      x: evalX,
      y: evalY,
      width: evalW,
      height: evalH,
      rotation: evalRot,
      opacity: evalOpacity * (transitionState.opacity ?? 1.0),
      inTransition: transitionState.inTransition,
      transitionType: transitionState.type,
      transitionProgress: transitionState.progress,
      blendMode: (clip as any).blendMode || "normal",
      lutId: (clip as any).lutId,
      lutIntensity: (clip as any).lutIntensity ?? 1.0,
    };

    visualLayers.push(mediaLayer);
  }

  // ─── 4. Evaluate Audio Layers ─────────────────────────────────────────────

  const audioLayers: EvaluatedAudioLayer[] = [];

  for (const clip of sortedClips) {
    const asset = assetMap.get(clip.mediaId);
    const track = trackMap.get(clip.trackId);
    const hasAudio = clip.role === "audio" || (asset?.type === "video" && clip.role === "primary");
    if (!hasAudio || !asset) continue;
    if (track?.muted ?? false) continue;

    const sourceTime = clip.trimIn + (time - clip.startTime);
    const sourcePath = asset.path ? convertFileSrc(asset.path) : "";
    if (!sourcePath) continue;

    audioLayers.push({
      layerId: `${clip.id}-audio-${time}`,
      clipId: clip.id,
      mediaId: clip.mediaId,
      sourcePath,
      sourceTime,
      volume: 1.0,
      pan: 0.0,
      priority: clip.trackIndex,
      muted: false,
    });
  }

  audioLayers.sort((a, b) => b.priority - a.priority);

  // ─── 5. Transitions (placeholder) ─────────────────────────────────────────
  const transitions: EvaluatedTransition[] = [];

  // ─── 6. Metadata ──────────────────────────────────────────────────────────

  const activeMediaHash = visualLayers
    .filter((l) => l.layerType === "media")
    .map((l) => l.clipId)
    .sort()
    .join("|");

  const metadata: SceneMetadata = {
    time,
    canvasWidth: project?.canvasWidth ?? 1920,
    canvasHeight: project?.canvasHeight ?? 1080,
    frameRate: project?.frameRate ?? 30,
    isGap: visualLayers.length === 0,
    fallbackStrategy: visualLayers.length === 0 ? "black" : undefined,
    activeMediaHash,
  };

  return { visualLayers, audioLayers, transitions, metadata };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRoleOrder(role: string): number {
  const order: Record<string, number> = {
    background: 0,
    primary: 1,
    overlay: 2,
    text: 3,
    effect: 4,
    audio: -1,
  };
  return order[role] ?? 1;
}

function evaluateTransitionState(clip: any, time: number, allClips: any[]): { inTransition: boolean; type?: "fade" | "dissolve"; progress?: number; opacity?: number } {
  // Placeholder — full transition detection tracked in issue #transitions
  return { inTransition: false, opacity: 1.0 };
}

// ─── Cached variant ───────────────────────────────────────────────────────────

/**
 * Evaluate the NLE timeline with LRU caching and epoch-based invalidation.
 * This is the recommended entry point for all preview/render paths.
 */
export function evaluateTimelineSceneCached(time: number, clips: Clip[], tracks: Track[], assets: MediaAsset[], project: Project | null, epoch: number = 0): EvaluatedScene {
  const cache = getEvaluationCache();
  const clipVersion = computeClipVersion(clips);
  const cacheKey = { time, epoch, clipVersion };

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const scene = evaluateTimelineScene(time, clips, tracks, assets, project);
  cache.set(cacheKey, scene);
  return scene;
}

export function getEvaluationCacheStats() {
  return getEvaluationCache().getStats();
}

export function clearEvaluationCache() {
  getEvaluationCache().clear();
}

export function invalidateEvaluationCache(epoch: number) {
  getEvaluationCache().invalidateEpoch(epoch);
}

/**
 * Resolve and normalize font family strings to exact loaded Fontsource font stacks.
 */
export function normalizeFontFamily(family: string): string {
  const f = family.toLowerCase();
  if (f === "inter") return "Inter";
  if (f.includes("inter")) return "Inter Variable";
  if (f.includes("montserrat")) return "Montserrat Variable";
  if (f.includes("geist")) return "Geist Variable";
  if (f.includes("space grotesk") || f.includes("grotesk")) return "Space Grotesk Variable";
  if (f.includes("outfit")) return "Outfit Variable";
  if (f.includes("roboto condensed")) return "Roboto Condensed";
  if (f.includes("roboto variable")) return "Roboto Variable";
  if (f === "roboto") return "Roboto Variable";
  if (f.includes("open sans")) return "Open Sans Variable";
  if (f.includes("raleway")) return "Raleway Variable";
  if (f.includes("oswald")) return "Oswald Variable";
  if (f.includes("playfair display")) return "Playfair Display Variable";
  if (f.includes("nunito")) return "Nunito Variable";
  if (f.includes("dancing script")) return "Dancing Script Variable";
  return family;
}
