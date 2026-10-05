/**
 * Per-clip audio gain (volume + linear fade in/out).
 *
 * Shared by the live preview (PreviewMediaPool) and mirrored by the export
 * mixer (ffmpeg `volume` + `afade`), so what you hear in preview matches the
 * exported file.
 */

import type { Clip } from "@/types";

type AudioGainClip = Pick<Clip, "duration" | "volume" | "audioFadeIn" | "audioFadeOut">;

/**
 * Highest clip volume (4 = 400 %, +12 dB). Above 1 the preview boosts through Web Audio
 * (core/resources/audioBoost.ts) and the export through FFmpeg's `volume` (clamped to the same
 * range in Rust), followed by a limiter so the mix cannot clip.
 */
export const MAX_CLIP_VOLUME = 4;

export function clampVolume(volume: number | undefined): number {
  if (volume === undefined || Number.isNaN(volume)) return 1;
  return Math.min(MAX_CLIP_VOLUME, Math.max(0, volume));
}

/** Fades can't be negative nor longer than the clip itself. */
export function clampFade(fade: number | undefined, clipDuration: number): number {
  if (fade === undefined || Number.isNaN(fade)) return 0;
  return Math.min(Math.max(0, fade), Math.max(0, clipDuration));
}

/**
 * Gain (0..MAX_CLIP_VOLUME) to apply at `localTime` seconds into the clip (0 = clip start).
 * Fade in ramps 0→1 over `audioFadeIn`; fade out ramps 1→0 over the last
 * `audioFadeOut` seconds (fades scale the volume). Overlapping fades multiply.
 */
export function getClipAudioGain(clip: AudioGainClip, localTime: number): number {
  const base = clampVolume(clip.volume);
  const fadeIn = clampFade(clip.audioFadeIn, clip.duration);
  const fadeOut = clampFade(clip.audioFadeOut, clip.duration);

  let gain = base;
  if (fadeIn > 0 && localTime < fadeIn) {
    gain *= Math.max(0, localTime) / fadeIn;
  }
  if (fadeOut > 0 && localTime > clip.duration - fadeOut) {
    gain *= Math.max(0, clip.duration - localTime) / fadeOut;
  }
  return Math.min(MAX_CLIP_VOLUME, Math.max(0, gain));
}
