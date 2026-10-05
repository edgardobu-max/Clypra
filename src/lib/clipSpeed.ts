/**
 * Clip speed.
 *
 * A clip's `trimIn`/`trimOut` are always positions in the SOURCE file; `duration` is how long the clip
 * lasts on the TIMELINE. With speed 1 the two spans are equal. At speed s the clip plays `s` seconds
 * of source per timeline second, so:
 *
 *   duration = (trimOut - trimIn) / speed
 *   sourceTime(t) = trimIn + (t - startTime) * speed
 *
 * Every place that turns timeline time into source time must go through `sourceTimeAt`.
 */

import type { Clip } from "@/types";

export const MIN_CLIP_SPEED = 0.25;
export const MAX_CLIP_SPEED = 8;

type SpeedClip = Pick<Clip, "speed">;

/** The clip's speed, defaulting to 1 and clamped to the supported range. */
export function clipSpeed(clip: SpeedClip | undefined | null): number {
  const speed = clip?.speed;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0) return 1;
  return Math.min(MAX_CLIP_SPEED, Math.max(MIN_CLIP_SPEED, speed));
}

export function clampSpeed(speed: number): number {
  return clipSpeed({ speed });
}

/** Source position (seconds into the file) shown at timeline time `time`. */
export function sourceTimeAt(clip: Pick<Clip, "startTime" | "trimIn" | "speed">, time: number): number {
  return Math.max(0, (clip.trimIn || 0) + (time - clip.startTime) * clipSpeed(clip));
}

/** Timeline seconds that a stretch of `sourceSpan` source seconds lasts at this speed. */
export function timelineSpan(sourceSpan: number, speed: number): number {
  return sourceSpan / clampSpeed(speed);
}

/** Source seconds consumed by `timelineSeconds` of timeline at this speed. */
export function sourceSpan(timelineSeconds: number, speed: number): number {
  return timelineSeconds * clampSpeed(speed);
}

/** Timeline duration of a clip given its trim range and speed. */
export function durationForTrim(clip: Pick<Clip, "trimIn" | "trimOut" | "speed">): number {
  return timelineSpan(clip.trimOut - clip.trimIn, clipSpeed(clip));
}

export interface SpeedChangePlan {
  /** Clips as they were (for undo). */
  before: Clip[];
  /** Clips as they become (for redo / apply). */
  after: Clip[];
}

/**
 * Changes one clip's speed so it lasts more or less on the timeline, and moves the clips that follow it
 * on the same track by the difference (so a slowed-down clip never overlaps the next one and a sped-up
 * clip leaves no hole). Returns null when nothing would change.
 */
export function planClipSpeedChange(clips: Clip[], clipId: string, requestedSpeed: number): SpeedChangePlan | null {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return null;

  const speed = clampSpeed(requestedSpeed);
  if (Math.abs(speed - clipSpeed(clip)) < 1e-9) return null;

  const newDuration = timelineSpan(clip.trimOut - clip.trimIn, speed);
  const delta = newDuration - clip.duration;
  const oldEnd = clip.startTime + clip.duration;

  const before: Clip[] = [clip];
  const after: Clip[] = [{ ...clip, speed: speed === 1 ? undefined : speed, duration: newDuration }];

  for (const other of clips) {
    if (other.id === clip.id || other.trackId !== clip.trackId) continue;
    if (other.startTime >= oldEnd - 1e-6) {
      before.push(other);
      after.push({ ...other, startTime: Math.max(0, other.startTime + delta) });
    }
  }

  return { before, after };
}
