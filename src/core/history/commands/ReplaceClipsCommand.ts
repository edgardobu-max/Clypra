/**
 * Replace Clips Command
 *
 * Swaps a set of clips (matched by id) for new versions in one undo step. Used for edits that change
 * several clips at once, such as a speed change that also moves the clips after it.
 */

import type { Command } from "../Command";
import { generateCommandId } from "../Command";
import type { Clip } from "@/types";

interface TimelineState {
  clips: Clip[];
  epoch: number;
}

export class ReplaceClipsCommand implements Command {
  readonly id: string;
  readonly label: string;
  readonly timestamp: number;
  readonly undoable: boolean = true;

  constructor(
    label: string,
    private readonly before: Clip[],
    private readonly after: Clip[],
  ) {
    this.id = generateCommandId();
    this.label = label;
    this.timestamp = Date.now();
  }

  apply(state: TimelineState): TimelineState {
    const replacements = new Map(this.after.map((c) => [c.id, c]));
    return {
      ...state,
      clips: state.clips.map((c) => replacements.get(c.id) ?? c),
      epoch: state.epoch + 1,
    };
  }

  invert(): Command {
    return new ReplaceClipsCommand(this.label, this.after, this.before);
  }

  toJSON(): Record<string, any> {
    return { type: "ReplaceClips", label: this.label, before: this.before, after: this.after };
  }

  static fromJSON(data: Record<string, any>): ReplaceClipsCommand {
    return new ReplaceClipsCommand(data.label, data.before, data.after);
  }
}
