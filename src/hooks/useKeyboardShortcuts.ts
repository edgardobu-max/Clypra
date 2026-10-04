import React, { useEffect } from "react";
import { useTransportControls, useTransportSnapshot } from "./usePlaybackClock";
import { getActiveSessionOrNull } from "@/core/runtime/ProjectSession";
import { useTimelineStore } from "@/store/timelineStore";
import { useUIStore } from "@/store/uiStore";
import { useProjectStore } from "@/store/projectStore";
import { useHistoryStore } from "@/store/historyStore";
import { EditingActions } from "@/core/interactions";
import { generateId } from "@/lib/id";

let copiedClipsClipboard: Array<{
  trackId: string;
  mediaId: string;
  duration: number;
  trimIn: number;
  trimOut: number;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  rotation: number;
  startOffset: number;
  aspectRatioLocked?: boolean;
  sourceAspectRatio?: number;
  fitMode?: "contain" | "cover" | "fill" | "stretch" | "original";
}> = [];

export const useKeyboardShortcuts = () => {
  const { play, pause, seek, setActiveContext } = useTransportControls();
  const { state: transportState, time: transportTime, speed } = useTransportSnapshot();
  const { zoomLevel, setZoom, swapClips, rippleEditEnabled, toggleRippleEdit } = useTimelineStore();
  const { selectedClipIds, selectClip, selectTrack, previewMode, exitSourceMode, markSourceIn, markSourceOut } = useUIStore();
  const { project } = useProjectStore();
  const { undo, redo } = useHistoryStore();
  const [toastMessage, setToastMessage] = React.useState<string | null>(null);

  const isPlaying = transportState === "playing";
  const frameRate = project?.frameRate ?? 30;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture shortcuts when typing in input fields
      const target = e.target as HTMLElement;
      const isTyping = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

      if (isTyping) return;

      const isMeta = e.ctrlKey || e.metaKey;

      // ─── Transport (context-aware) ───────────────────────────────────────

      if (e.code === "Space") {
        e.preventDefault();
        isPlaying ? pause() : play();
        return;
      }

      if (e.key === "k") {
        e.preventDefault();
        pause();
        return;
      }

      // ─── Seeking (context-aware) ─────────────────────────────────────────

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (previewMode === "source") {
          seek?.(Math.max(0, transportTime - 1));
        } else {
          const frameTime = 1 / frameRate;
          seek?.(Math.max(0, transportTime - frameTime));
        }
        return;
      }

      if (e.key === "ArrowRight") {
        e.preventDefault();
        if (previewMode === "source") {
          seek?.(transportTime + 1);
        } else {
          const frameTime = 1 / frameRate;
          seek?.(transportTime + frameTime);
        }
        return;
      }

      // ─── Source mode shortcuts ───────────────────────────────────────────

      if (previewMode === "source") {
        if (e.key === "i") {
          e.preventDefault();
          const session = getActiveSessionOrNull();
          const t = session?.sourceContext?.getTime() ?? 0;
          markSourceIn(t);
          return;
        }

        if (e.key === "o") {
          e.preventDefault();
          const session = getActiveSessionOrNull();
          const t = session?.sourceContext?.getTime() ?? 0;
          markSourceOut(t);
          return;
        }

        if (e.key === "Escape") {
          e.preventDefault();
          exitSourceMode();
          setActiveContext?.("program");
          return;
        }

        // Don't process remaining shortcuts in source mode
        return;
      }

      // ─── Program mode shortcuts ──────────────────────────────────────────

      if (isMeta && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((isMeta && e.shiftKey && e.key === "z") || (isMeta && e.key === "y")) {
        e.preventDefault();
        redo();
      } else if (isMeta && e.key === "s") {
        e.preventDefault();
      } else if (isMeta && e.key === "i") {
        e.preventDefault();
      } else if (isMeta && e.key.toLowerCase() === "d") {
        e.preventDefault();
        const store = useTimelineStore.getState();
        const selected = store.clips.filter((c) => selectedClipIds.includes(c.id)).sort((a, b) => a.startTime - b.startTime);
        if (selected.length === 0) return;
        const minStart = selected[0].startTime;
        const maxEnd = Math.max(...selected.map((c) => c.startTime + c.duration));
        const offset = maxEnd - minStart;
        selected.forEach((clip) => {
          store.addClip({
            ...clip,
            id: generateId("clip"),
            startTime: clip.startTime + offset,
          });
        });
        setToastMessage(`Duplicated ${selected.length} clip${selected.length > 1 ? "s" : ""}`);
        setTimeout(() => setToastMessage(null), 2000);
      } else if (isMeta && e.key.toLowerCase() === "a") {
        e.preventDefault();
        // Select every clip (Ctrl+Shift+A selects only the clips on the same track as the current selection).
        const allClips = useTimelineStore.getState().clips;
        const anchor = allClips.find((c) => selectedClipIds[0] === c.id);
        const pool = e.shiftKey && anchor ? allClips.filter((c) => c.trackId === anchor.trackId) : allClips;
        useUIStore.setState({ selectedClipIds: pool.map((c) => c.id) });
      } else if (isMeta && e.key.toLowerCase() === "c") {
        e.preventDefault();
        const store = useTimelineStore.getState();
        const selected = store.clips.filter((c) => selectedClipIds.includes(c.id)).sort((a, b) => a.startTime - b.startTime);
        if (selected.length === 0) return;
        const minStart = selected[0].startTime;
        copiedClipsClipboard = selected.map((clip) => ({
          trackId: clip.trackId,
          mediaId: clip.mediaId,
          duration: clip.duration,
          trimIn: clip.trimIn,
          trimOut: clip.trimOut,
          x: clip.x,
          y: clip.y,
          width: clip.width,
          height: clip.height,
          opacity: clip.opacity,
          rotation: clip.rotation,
          startOffset: clip.startTime - minStart,
          aspectRatioLocked: clip.aspectRatioLocked,
          sourceAspectRatio: clip.sourceAspectRatio,
          fitMode: clip.fitMode,
        }));
        setToastMessage(`Copied ${copiedClipsClipboard.length} clip${copiedClipsClipboard.length > 1 ? "s" : ""}`);
        setTimeout(() => setToastMessage(null), 1500);
      } else if (isMeta && e.key.toLowerCase() === "v") {
        e.preventDefault();
        if (copiedClipsClipboard.length === 0) return;
        const store = useTimelineStore.getState();
        copiedClipsClipboard.forEach((clip) => {
          store.addClip({
            id: generateId("clip"),
            trackId: clip.trackId,
            mediaId: clip.mediaId,
            startTime: Math.max(0, transportTime + clip.startOffset),
            duration: clip.duration,
            trimIn: clip.trimIn,
            trimOut: clip.trimOut,
            x: clip.x,
            y: clip.y,
            width: clip.width,
            height: clip.height,
            opacity: clip.opacity,
            rotation: clip.rotation,
            aspectRatioLocked: clip.aspectRatioLocked,
            sourceAspectRatio: clip.sourceAspectRatio,
            fitMode: clip.fitMode,
          });
        });
        setToastMessage(`Pasted ${copiedClipsClipboard.length} clip${copiedClipsClipboard.length > 1 ? "s" : ""}`);
        setTimeout(() => setToastMessage(null), 1500);
      } else if (isMeta && e.shiftKey && e.key === "S") {
        e.preventDefault();
        const result = swapClips();
        if (result.error) {
          setToastMessage(result.error);
          setTimeout(() => setToastMessage(null), 3000);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        selectClip(null);
        selectTrack(null);
      } else if (isMeta && e.key === "=") {
        e.preventDefault();
        setZoom(Math.min(5, zoomLevel + 0.1));
      } else if (isMeta && e.key === "-") {
        e.preventDefault();
        setZoom(Math.max(0.5, zoomLevel - 0.1));
      } else if (e.key === "r" && !isMeta) {
        e.preventDefault();
        toggleRippleEdit();
        setToastMessage(rippleEditEnabled ? "Ripple Edit: OFF" : "Ripple Edit: ON");
        setTimeout(() => setToastMessage(null), 2000);
      } else if (e.key === "s" && !isMeta) {
        e.preventDefault();
        const results = EditingActions.splitAllAtPlayhead();

        if (results.length === 0) {
          setToastMessage("No clips under playhead to split");
        } else {
          const successCount = results.filter((r) => r.success).length;
          const failCount = results.length - successCount;

          if (successCount > 0) {
            setToastMessage(`Split ${successCount} clip${successCount > 1 ? "s" : ""}`);
          } else if (failCount > 0) {
            setToastMessage(results[0].error || "Split failed");
          }
        }
        setTimeout(() => setToastMessage(null), 2000);
      } else if (e.key.toLowerCase() === "q" && !isMeta) {
        e.preventDefault();
        const results = EditingActions.deleteLeftAtPlayhead();
        if (results.length === 0) {
          setToastMessage("No clips to delete left at playhead");
        } else {
          const successCount = results.filter((r) => r.success).length;
          setToastMessage(`Delete left applied to ${successCount} clip${successCount > 1 ? "s" : ""}`);
        }
        setTimeout(() => setToastMessage(null), 2000);
      } else if (e.key.toLowerCase() === "w" && !isMeta) {
        e.preventDefault();
        const results = EditingActions.deleteRightAtPlayhead();
        if (results.length === 0) {
          setToastMessage("No clips to delete right at playhead");
        } else {
          const successCount = results.filter((r) => r.success).length;
          setToastMessage(`Delete right applied to ${successCount} clip${successCount > 1 ? "s" : ""}`);
        }
        setTimeout(() => setToastMessage(null), 2000);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPlaying, transportTime, frameRate, zoomLevel, selectedClipIds, previewMode, rippleEditEnabled, play, pause, seek, setActiveContext, setZoom, selectClip, selectTrack, exitSourceMode, markSourceIn, markSourceOut, swapClips, toggleRippleEdit, undo, redo]);

  return { toastMessage };
};
