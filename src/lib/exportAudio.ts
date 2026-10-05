/**
 * Decides which timeline audio goes into an exported video.
 *
 * Mirrors the live preview's rules (PreviewMediaPool): audio clips and the
 * embedded audio of video clips are audible unless their track is muted or
 * hidden. The result is handed to the Rust export, which mixes it with FFmpeg.
 */

import type { Clip, Track, MediaAsset } from "@/types";
import { clampVolume, clampFade } from "@/lib/audioGain";
import { clipSpeed, sourceTimeAt } from "@/lib/clipSpeed";

/** Shape expected by Rust's `AudioInput` (camelCase via serde). */
export interface ExportAudioInput {
  /** Source media file path. */
  path: string;
  /** Seconds into the export where this audio starts. */
  startTime: number;
  /** Seconds into the source file where playback begins. */
  trimIn: number;
  /** Seconds of source audio to use. */
  duration: number;
  /** Playback speed; the source span used is duration * speed (pitch is kept). */
  speed: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
}

/** Ignore slivers shorter than this (seconds) — nothing audible, avoids ffmpeg edge cases. */
const MIN_AUDIBLE_SECONDS = 0.01;

export function buildExportAudioInputs(clips: Clip[], tracks: Track[], assets: MediaAsset[], rangeStart: number, rangeEnd: number): ExportAudioInput[] {
  const trackById = new Map(tracks.map((t) => [t.id, t]));
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const inputs: ExportAudioInput[] = [];

  for (const clip of clips) {
    if ("text" in clip) continue; // text clips carry no audio

    const asset = assetById.get(clip.mediaId);
    if (!asset || (asset.type !== "audio" && asset.type !== "video") || !asset.path) continue;

    const track = trackById.get(clip.trackId);
    if (track?.muted || track?.visible === false) continue;

    const clipStart = clip.startTime;
    const clipEnd = clip.startTime + clip.duration;
    const from = Math.max(clipStart, rangeStart);
    const to = Math.min(clipEnd, rangeEnd);
    if (to - from <= MIN_AUDIBLE_SECONDS) continue;

    const cutAtStart = from > clipStart;
    const cutAtEnd = to < clipEnd;
    const duration = to - from;

    inputs.push({
      path: asset.path,
      startTime: from - rangeStart,
      trimIn: sourceTimeAt(clip, from),
      duration,
      speed: clipSpeed(clip),
      volume: clampVolume(clip.volume),
      // A fade belongs to the clip's own edge; if the export range cuts that
      // edge off, the fade isn't part of what's exported.
      fadeIn: cutAtStart ? 0 : Math.min(clampFade(clip.audioFadeIn, clip.duration), duration),
      fadeOut: cutAtEnd ? 0 : Math.min(clampFade(clip.audioFadeOut, clip.duration), duration),
    });
  }

  // Deterministic order (earliest first) keeps ffmpeg input indexes stable.
  return inputs.sort((a, b) => a.startTime - b.startTime);
}
