/**
 * Timeline Store
 *
 * OWNERSHIP: Editable timeline domain state (single source of truth)
 * PERSISTENCE: Persistent (saved/loaded by projectStore)
 * MUTABILITY: Mutable (user edits, operations)
 *
 * Responsibilities:
 * - Own all timeline composition state (tracks, clips, selections)
 * - Provide mutation operations (add/remove/update clips/tracks)
 * - Maintain timeline view state (zoom, scroll)
 * - Emit epoch changes for render invalidation
 *
 * Does NOT:
 * - Persist to disk (projectStore handles serialization)
 * - Manage runtime resources (ProjectSession handles playback/scheduler)
 * - Reset itself (only projectStore loads/clears on project switch)
 *
 * Architecture principle:
 * This is the authoritative source for "what is on the timeline right now"
 * All other systems (render, playback, export) consume this as immutable input
 */

import { create } from "zustand";
import type { Track, Clip } from "@/types";
import { generateId, getCounter } from "@/lib/id";
import { useUIStore } from "./uiStore";
import { useProjectStore } from "./projectStore";
import { clampTimelinePixelsPerSecond, clampTimelineZoom, TIMELINE_PPS_PER_ZOOM, TIMELINE_ZOOM_DEFAULT } from "../lib/timelineZoom";
import { getTimelineContentEnd, normalizeClipTiming } from "@/lib/timelineClip";
import { autoSaveMiddleware } from "./middleware/autoSaveMiddleware";

interface TimelineStore {
  tracks: Track[];
  clips: Clip[];
  /**
   * First created video track - UI metadata only.
   * Used for: default drop target, visual highlighting, user expectations.
   * NOT used for: enforcement, validation, or blocking operations.
   * The compositor resolves frames by time, not by track constraints.
   */
  mainVideoTrackId: string | null;
  /**
   * Timeline epoch - increments on every timeline mutation.
   * Used for cache invalidation in render engine and evaluation.
   */
  epoch: number;
  zoomLevel: number;
  scrollLeft: number;
  pixelsPerSecond: number;
  rippleEditEnabled: boolean;
  clipDragMode: "free" | "insert" | "ripple";
  snapEnabled: boolean;
  /** @internal Batch nesting depth — do not read directly */
  _batchDepth: number;
  /** @internal Deferred epoch flag — do not read directly */
  _pendingEpochIncrement: boolean;
  /** Execute a batch of mutations safely. Epoch increment is deferred until the block completes. */
  withBatch: (fn: () => void) => void;
  /** Increment epoch (for cache invalidation) */
  incrementEpoch: () => void;
  /** Hydrate timeline state from project load (atomic operation) */
  hydrateFromProject: (payload: { tracks?: any[]; clips?: any[] }) => void;
  addTrack: (type: "video" | "audio" | "text") => void;
  /** Inserts a track at index (clamped); returns the new track id. */
  insertTrackAt: (type: "video" | "audio" | "text", index: number) => string;
  removeTrack: (trackId: string) => void;
  /** Put video/text tracks above and audio tracks below, keeping relative order. */
  arrangeTracks: () => void;
  toggleTrackLock: (trackId: string) => void;
  toggleTrackMute: (trackId: string) => void;
  toggleTrackVisibility: (trackId: string) => void;
  addClip: (clip: Clip) => void;
  removeClip: (clipId: string) => void;
  updateClip: (clipId: string, updates: Partial<Clip>) => void;
  moveClip: (clipId: string, startTime: number) => void;
  setZoom: (level: number) => void;
  /** Clamps to the SRP zoom range and syncs `zoomLevel` to `pixelsPerSecond / 100`. */
  setPixelsPerSecond: (pps: number) => void;
  setScrollLeft: (left: number) => void;
  getTimelineEndTime: () => number;
  swapClips: () => { error: string | null };
  toggleRippleEdit: () => void;
  setClipDragMode: (mode: "free" | "insert" | "ripple") => void;
  toggleSnapEnabled: () => void;
  rippleTrimClip: (clipId: string, side: "left" | "right", deltaTime: number) => void;
  // Sequence-based operations
  insertClipAtIndex: (clipId: string, trackId: string, index: number) => void;
  normalizeTrack: (trackId: string) => void;
  getTrackClips: (trackId: string) => Clip[];
  removeEmptyNonMainTracks: (candidateTrackIds?: string[]) => void;
}

const trackHeights: Record<string, number> = {
  video: 68,
  audio: 52,
  text: 30,
};
const MIN_TRIM_DURATION_SEC = 1;

/**
 * Where to insert a new row. Layout: video/text/overlay tracks on top (the main video
 * track at the bottom of that group), audio tracks below. New video/text tracks go to
 * the very top; new audio tracks go under every existing track, i.e. below the last
 * audio track so each added audio (voice-over, then music…) sits under the previous one.
 */
export function getInsertIndexForNewTrack(tracks: Track[], trackType: "video" | "audio" | "text"): number {
  if (trackType === "video" || trackType === "text") {
    return 0;
  }
  const lastAudio = tracks.map((t) => t.type).lastIndexOf("audio");
  if (lastAudio >= 0) return lastAudio + 1;
  const lastVisual = tracks.length - 1;
  return lastVisual + 1;
}

/** Stable reorder: visual (video/text) tracks first, audio tracks last. */
export function sortTracksVisualFirst(tracks: Track[]): Track[] {
  return [...tracks.filter((t) => t.type !== "audio"), ...tracks.filter((t) => t.type === "audio")];
}

export const useTimelineStore = create<TimelineStore>(
  autoSaveMiddleware((set, get) => ({
    tracks: [],
    clips: [],
    mainVideoTrackId: null,
    epoch: 0,
    zoomLevel: TIMELINE_ZOOM_DEFAULT,
    scrollLeft: 0,
    pixelsPerSecond: TIMELINE_ZOOM_DEFAULT * TIMELINE_PPS_PER_ZOOM,
    rippleEditEnabled: false,
    clipDragMode: "free",
    snapEnabled: true,
    _batchDepth: 0,
    _pendingEpochIncrement: false,

    withBatch: (fn) => {
      set((state) => ({ _batchDepth: state._batchDepth + 1 }));
      try {
        fn();
      } finally {
        set((state) => {
          const newDepth = Math.max(0, state._batchDepth - 1);
          if (newDepth === 0 && state._pendingEpochIncrement) {
            return { _batchDepth: 0, _pendingEpochIncrement: false, epoch: state.epoch + 1 };
          }
          return { _batchDepth: newDepth };
        });
      }
    },

    incrementEpoch: () => {
      set((state) => {
        if (state._batchDepth > 0) {
          return { _pendingEpochIncrement: true };
        }
        return { epoch: state.epoch + 1 };
      });
    },

    hydrateFromProject: (payload) => {
      const finalTracks = payload?.tracks ?? [];
      const finalClipsRaw = payload?.clips ?? [];

      // Normalize clip timing with media asset data
      const mediaAssets = useProjectStore.getState().mediaAssets;

      const normalizedClips = finalClipsRaw.map((clip: Clip) => {
        const asset = mediaAssets.find((a) => a.id === clip.mediaId);
        return normalizeClipTiming(clip, asset);
      });

      // Atomic state update - all or nothing
      set({
        tracks: finalTracks,
        clips: normalizedClips,
        scrollLeft: 0,
        zoomLevel: TIMELINE_ZOOM_DEFAULT,
        pixelsPerSecond: TIMELINE_ZOOM_DEFAULT * TIMELINE_PPS_PER_ZOOM,
        epoch: 0, // Reset epoch on project load
      });
    },

    addTrack: (type) => {
      const newTrack: Track = {
        id: generateId("track"),
        type,
        name: `${type.charAt(0).toUpperCase() + type.slice(1)} ${getCounter() % 100}`,
        muted: false,
        locked: false,
        visible: true,
        height: trackHeights[type],
      };
      set((state) => ({
        tracks: [...state.tracks, newTrack],
        mainVideoTrackId: state.mainVideoTrackId ?? (type === "video" ? newTrack.id : null),
      }));
    },

    insertTrackAt: (type, index) => {
      const newTrack: Track = {
        id: generateId("track"),
        type,
        name: `${type.charAt(0).toUpperCase() + type.slice(1)} ${getCounter() % 100}`,
        muted: false,
        locked: false,
        visible: true,
        height: trackHeights[type],
      };
      const id = newTrack.id;
      set((state) => {
        const clamped = Math.max(0, Math.min(index, state.tracks.length));
        const next = [...state.tracks];
        next.splice(clamped, 0, newTrack);
        return {
          tracks: next,
          mainVideoTrackId: state.mainVideoTrackId ?? (type === "video" ? newTrack.id : null),
        };
      });
      return id;
    },

    arrangeTracks: () => {
      set((state) => ({ tracks: sortTracksVisualFirst(state.tracks), epoch: state.epoch + 1 }));
    },

    removeTrack: (trackId) => {
      set((state) => ({
        tracks: state.tracks.filter((t) => t.id !== trackId),
        clips: state.clips.filter((c) => c.trackId !== trackId),
      }));
    },

    toggleTrackLock: (trackId) => {
      set((state) => ({
        tracks: state.tracks.map((track) => (track.id === trackId ? { ...track, locked: !track.locked } : track)),
      }));
    },

    toggleTrackMute: (trackId) => {
      set((state) => ({
        tracks: state.tracks.map((track) => (track.id === trackId ? { ...track, muted: !track.muted } : track)),
      }));
    },

    toggleTrackVisibility: (trackId) => {
      set((state) => ({
        tracks: state.tracks.map((track) => (track.id === trackId ? { ...track, visible: !track.visible } : track)),
      }));
    },

    addClip: (clip) => {
      set((state) => {
        const wasEmpty = state.clips.length === 0;

        // If timeline was empty, switch to program preview and seek to zero
        if (wasEmpty) {
          // Import dynamically to avoid circular dependency
          import("@/core/runtime/ProjectSession").then(({ getActiveSessionOrNull }) => {
            const session = getActiveSessionOrNull();
            if (session?.transportAuthority) {
              session.transportAuthority.setActiveContext("program");
              session.transportAuthority.seek(0);
            }
          });

          // Exit source mode in UI
          import("./uiStore").then(({ useUIStore }) => {
            useUIStore.getState().exitSourceMode();
          });
        }

        return {
          clips: [...state.clips, clip],
          epoch: state.epoch + 1,
        };
      });
    },

    removeClip: (clipId) => {
      set((state) => {
        const remainingClips = state.clips.filter((c) => c.id !== clipId);

        // If removing the last clip, reset playhead to 00:00
        if (remainingClips.length === 0) {
          // Import dynamically to avoid circular dependency
          import("@/core/runtime/ProjectSession").then(({ getActiveSessionOrNull }) => {
            const session = getActiveSessionOrNull();
            if (session?.transportAuthority) {
              session.transportAuthority.seek(0);
            }
          });
        }

        const next: Partial<TimelineStore> = {
          clips: remainingClips,
        };
        if (state._batchDepth > 0) {
          next._pendingEpochIncrement = true;
        } else {
          next.epoch = state.epoch + 1;
        }
        return next;
      });
    },

    updateClip: (clipId, updates) => {
      set((state) => {
        const next: Partial<TimelineStore> = {
          clips: state.clips.map((c) => (c.id === clipId ? { ...c, ...updates } : c)),
        };
        if (state._batchDepth > 0) {
          next._pendingEpochIncrement = true;
        } else {
          next.epoch = state.epoch + 1;
        }
        return next;
      });
    },

    moveClip: (clipId, startTime) => {
      set((state) => {
        const next: Partial<TimelineStore> = {
          clips: state.clips.map((c) => (c.id === clipId ? { ...c, startTime } : c)),
        };
        if (state._batchDepth > 0) {
          next._pendingEpochIncrement = true;
        } else {
          next.epoch = state.epoch + 1;
        }
        return next;
      });
    },

    setPixelsPerSecond: (pps) => {
      const clamped = clampTimelinePixelsPerSecond(pps);
      set({
        pixelsPerSecond: clamped,
        zoomLevel: clamped / TIMELINE_PPS_PER_ZOOM,
      });
    },

    setZoom: (level) => {
      get().setPixelsPerSecond(TIMELINE_PPS_PER_ZOOM * clampTimelineZoom(level));
    },

    setScrollLeft: (left) => {
      set({ scrollLeft: left });
    },

    getTimelineEndTime: () => {
      const state = get();
      return getTimelineContentEnd(state.clips);
    },

    swapClips: () => {
      const { selectedClipIds } = useUIStore.getState();

      // Guard: exactly 2 clips must be selected
      if (selectedClipIds.length !== 2) {
        return { error: "Select exactly 2 clips to swap" };
      }

      const state = get();
      const clipA = state.clips.find((c) => c.id === selectedClipIds[0]);
      const clipB = state.clips.find((c) => c.id === selectedClipIds[1]);

      if (!clipA || !clipB) {
        return { error: "Selected clips not found" };
      }

      // Case: different tracks — simple position + track swap
      if (clipA.trackId !== clipB.trackId) {
        set((state) => ({
          clips: state.clips.map((c) => {
            if (c.id === clipA.id) {
              return { ...c, startTime: clipB.startTime, trackId: clipB.trackId };
            }
            if (c.id === clipB.id) {
              return { ...c, startTime: clipA.startTime, trackId: clipA.trackId };
            }
            return c;
          }),
        }));

        return { error: null };
      }

      // Case: same track — recalculate positions flush
      // Ensure left is always the leftmost clip
      const [left, right] = clipA.startTime < clipB.startTime ? [clipA, clipB] : [clipB, clipA];

      const newLeftStart = left.startTime; // right clip takes left's old start
      const newRightStart = left.startTime + right.duration; // left clip follows immediately after right
      const newLeftEnd = newLeftStart + right.duration;
      const newRightEnd = newRightStart + left.duration;

      // Collision check: do the swapped clips overlap any other clips?
      const trackClips = state.clips.filter((c) => c.trackId === left.trackId && c.id !== left.id && c.id !== right.id);

      // Check if either swapped clip overlaps with other clips on the track
      const collision = trackClips.some((c) => {
        const cEnd = c.startTime + c.duration;
        // Check if clip C overlaps with new left position (right clip moved to left)
        const overlapsNewLeft = Math.max(newLeftStart, c.startTime) < Math.min(newLeftEnd, cEnd);
        // Check if clip C overlaps with new right position (left clip moved to right)
        const overlapsNewRight = Math.max(newRightStart, c.startTime) < Math.min(newRightEnd, cEnd);
        return overlapsNewLeft || overlapsNewRight;
      });

      if (collision) {
        return { error: "Not enough space to swap — clips would overlap" };
      }

      set((state) => ({
        clips: state.clips.map((c) => {
          if (c.id === left.id) return { ...c, startTime: newRightStart };
          if (c.id === right.id) return { ...c, startTime: newLeftStart };
          return c;
        }),
      }));

      return { error: null };
    },

    toggleRippleEdit: () => {
      set((state) => ({ rippleEditEnabled: !state.rippleEditEnabled }));
    },

    setClipDragMode: (mode) => {
      set({ clipDragMode: mode });
    },

    toggleSnapEnabled: () => {
      set((state) => ({ snapEnabled: !state.snapEnabled }));
    },

    rippleTrimClip: (clipId, side, deltaTime) => {
      const state = get();
      const clip = state.clips.find((c) => c.id === clipId);
      if (!clip) return;

      const track = state.tracks.find((t) => t.id === clip.trackId);
      if (track?.locked) return;

      // Clamp trimming to underlying media duration when available.
      // Falls back to Infinity (no cap) when the media asset cannot be resolved.
      let mediaDurationBound = Infinity;
      let mediaType: "video" | "audio" | "image" | null = null;
      try {
        // Lazy import to avoid circular deps during store init.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const asset = useProjectStore.getState().mediaAssets?.find((a: any) => a.id === clip.mediaId);
        mediaType = asset?.type ?? null;
        if (asset?.duration && Number.isFinite(asset.duration) && asset.duration > 0) {
          mediaDurationBound = asset.duration;
        }
      } catch {
        // ignore; keep Infinity bound
      }
      if (mediaType === "image") {
        mediaDurationBound = Math.max(mediaDurationBound, 60 * 60); // 1 hour guardrail
      }

      const minDuration = MIN_TRIM_DURATION_SEC;

      // Calculate the new clip dimensions
      let newStartTime = clip.startTime;
      let newDuration = clip.duration;
      let rippleAmount = 0;

      if (side === "right") {
        // Trimming right edge - changes duration
        const maxDuration = Math.max(minDuration, mediaDurationBound - clip.trimIn);
        const desiredDuration = clip.duration + deltaTime;
        newDuration = Math.max(minDuration, Math.min(desiredDuration, maxDuration));
        rippleAmount = newDuration - clip.duration;
      } else {
        // Trimming left edge - changes both start time and duration
        const maxTrimIn = Math.min(mediaDurationBound, clip.trimOut - 0.001);
        const desiredStartTime = clip.startTime + deltaTime;
        const desiredDelta = desiredStartTime - clip.startTime;
        const previousClipEnd = state.clips
          .filter((c) => c.id !== clipId && c.trackId === clip.trackId)
          .reduce((maxEnd, c) => {
            const end = c.startTime + c.duration;
            if (end <= clip.startTime + 1e-6) return Math.max(maxEnd, end);
            return maxEnd;
          }, 0);

        const minDelta = Math.max(-clip.startTime, previousClipEnd - clip.startTime);
        const maxDeltaByDuration = clip.duration - minDuration;
        const maxDeltaByMedia = maxTrimIn - clip.trimIn;
        const clampedDelta = Math.max(minDelta, Math.min(desiredDelta, maxDeltaByDuration, maxDeltaByMedia));

        newStartTime = clip.startTime + clampedDelta;
        newDuration = clip.duration - clampedDelta;
        rippleAmount = clampedDelta;
      }

      // Find all clips downstream on the same track
      const downstreamClips = state.clips
        .filter((c) => {
          if (c.id === clipId) return false;
          if (c.trackId !== clip.trackId) return false;

          // For right edge trim: clips that start after the clip's end
          if (side === "right") {
            return c.startTime >= clip.startTime + clip.duration;
          }
          // For left edge trim: clips that start after the clip's start
          return c.startTime >= clip.startTime;
        })
        .sort((a, b) => a.startTime - b.startTime);

      // Update the trimmed clip and all downstream clips
      set((state) => ({
        clips: state.clips.map((c) => {
          if (c.id === clipId) {
            // Update the clip being trimmed
            const updates: Partial<Clip> = {
              startTime: newStartTime,
              duration: newDuration,
            };

            // Update trim points for media
            if (side === "left") {
              updates.trimIn = clip.trimIn + (newStartTime - clip.startTime);
              updates.duration = clip.trimOut - updates.trimIn;
            } else {
              updates.trimOut = Math.min(clip.trimIn + newDuration, mediaDurationBound);
              updates.duration = updates.trimOut - clip.trimIn;
            }

            return { ...c, ...updates };
          }

          // Shift downstream clips
          const downstream = downstreamClips.find((dc) => dc.id === c.id);
          if (downstream) {
            return {
              ...c,
              startTime: c.startTime + rippleAmount,
            };
          }

          return c;
        }),
      }));
    },

    // Sequence-based operations for gap engine
    getTrackClips: (trackId) => {
      const state = get();
      return state.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.startTime - b.startTime);
    },

    insertClipAtIndex: (clipId, trackId, index) => {
      const state = get();
      const clip = state.clips.find((c) => c.id === clipId);
      if (!clip) return;

      // Get all clips on target track (excluding the dragged clip)
      const trackClips = state.clips.filter((c) => c.trackId === trackId && c.id !== clipId).sort((a, b) => a.startTime - b.startTime);

      // Insert clip at index
      trackClips.splice(index, 0, clip);

      // Recalculate all positions (no gaps, no overlaps)
      let currentTime = 0;
      const updatedClips = trackClips.map((c) => {
        const updated = { ...c, startTime: currentTime, trackId };
        currentTime += c.duration;
        return updated;
      });

      // Update state with normalized positions
      set((state) => ({
        clips: state.clips.map((c) => {
          const updated = updatedClips.find((uc) => uc.id === c.id);
          return updated || c;
        }),
      }));
    },

    normalizeTrack: (trackId) => {
      const state = get();
      const trackClips = state.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.startTime - b.startTime);

      let currentTime = 0;
      const normalized = trackClips.map((clip) => {
        const updated = { ...clip, startTime: currentTime };
        currentTime += clip.duration;
        return updated;
      });

      set((state) => ({
        clips: state.clips.map((c) => {
          const norm = normalized.find((n) => n.id === c.id);
          return norm || c;
        }),
      }));
    },

    removeEmptyNonMainTracks: (candidateTrackIds) => {
      set((state) => {
        const mainVideoTrackId = state.mainVideoTrackId ?? state.tracks.find((t) => t.type === "video")?.id ?? null;
        const candidateSet = candidateTrackIds ? new Set(candidateTrackIds) : null;
        const nextTracks = state.tracks.filter((track) => {
          if (track.id === mainVideoTrackId) return true;
          if (candidateSet && !candidateSet.has(track.id)) return true;
          return state.clips.some((c) => c.trackId === track.id);
        });
        return {
          tracks: nextTracks,
          mainVideoTrackId,
        };
      });
    },
  })),
);
