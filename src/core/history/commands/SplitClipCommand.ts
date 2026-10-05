/**
 * Split Clip Command
 *
 * Splits a clip at a specific time, creating two clips.
 */

import type { Command } from "../Command";
import { generateCommandId } from "../Command";
import type { Clip } from "@/types";
import { generateId } from "@/lib/id";
import { clipSpeed } from "@/lib/clipSpeed";

interface TimelineState {
  clips: Clip[];
  epoch: number;
}

export class SplitClipCommand implements Command {
  readonly id: string;
  readonly label: string;
  readonly timestamp: number;
  readonly undoable: boolean = true;

  private newClipId: string | null = null;

  constructor(
    private readonly clipId: string,
    private readonly splitTime: number,
    private readonly originalClip: Clip,
  ) {
    this.id = generateCommandId();
    this.label = "Split Clip";
    this.timestamp = Date.now();
  }

  apply(state: TimelineState): TimelineState {
    const clip = state.clips.find((c) => c.id === this.clipId);
    if (!clip) return state;

    const clipEndTime = clip.startTime + clip.duration;
    if (this.splitTime <= clip.startTime || this.splitTime >= clipEndTime) {
      return state;
    }

    const timeSinceStart = this.splitTime - clip.startTime;

    // Calculate new trim points and durations
    const speed = clipSpeed(clip);
    const leftTrimOut = clip.trimIn + timeSinceStart * speed;
    const leftDuration = timeSinceStart;

    const rightTrimIn = leftTrimOut;
    const rightDuration = (clip.trimOut - rightTrimIn) / speed;

    // Generate new clip ID if not already done
    if (!this.newClipId) {
      this.newClipId = generateId("clip");
    }

    const newClip: Clip = {
      ...clip,
      id: this.newClipId,
      startTime: this.splitTime,
      duration: rightDuration,
      trimIn: rightTrimIn,
      trimOut: clip.trimOut,
    };

    return {
      ...state,
      clips: [
        ...state.clips.map((c) => {
          if (c.id === this.clipId) {
            return { ...c, duration: leftDuration, trimOut: leftTrimOut };
          }
          return c;
        }),
        newClip,
      ],
      epoch: state.epoch + 1, // ✅ Epoch increment inside command
    };
  }

  invert(): Command {
    // Inverse: merge the two clips back together
    return new MergeSplitClipsCommand(this.clipId, this.newClipId!, this.originalClip);
  }

  toJSON(): Record<string, any> {
    return {
      type: "SplitClip",
      clipId: this.clipId,
      splitTime: this.splitTime,
      originalClip: this.originalClip,
      newClipId: this.newClipId,
    };
  }

  static fromJSON(data: Record<string, any>): SplitClipCommand {
    const cmd = new SplitClipCommand(data.clipId, data.splitTime, data.originalClip);
    cmd.newClipId = data.newClipId;
    return cmd;
  }
}

/**
 * Merge Split Clips Command (inverse of split)
 *
 * Removes the right clip and restores the left clip to its original state.
 */
class MergeSplitClipsCommand implements Command {
  readonly id: string;
  readonly label: string;
  readonly timestamp: number;
  readonly undoable: boolean = true;

  constructor(
    private readonly leftClipId: string,
    private readonly rightClipId: string,
    private readonly originalClip: Clip,
  ) {
    this.id = generateCommandId();
    this.label = "Merge Split Clips";
    this.timestamp = Date.now();
  }

  apply(state: TimelineState): TimelineState {
    return {
      ...state,
      clips: state.clips
        .filter((c) => c.id !== this.rightClipId)
        .map((c) => {
          if (c.id === this.leftClipId) {
            return this.originalClip;
          }
          return c;
        }),
      epoch: state.epoch + 1, // ✅ Epoch increment inside command
    };
  }

  invert(): Command {
    const rightClip = this.originalClip;
    const splitTime = this.originalClip.startTime + this.originalClip.duration / 2; // Approximate
    return new SplitClipCommand(this.leftClipId, splitTime, this.originalClip);
  }

  toJSON(): Record<string, any> {
    return {
      type: "MergeSplitClips",
      leftClipId: this.leftClipId,
      rightClipId: this.rightClipId,
      originalClip: this.originalClip,
    };
  }
}
