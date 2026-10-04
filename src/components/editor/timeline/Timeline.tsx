import React, { useRef, useEffect, useCallback, useState } from "react";
import { useTimelineStore } from "@/store/timelineStore";
import { useUIStore } from "@/store/uiStore";
import { useHistoryStore } from "@/store/historyStore";
import { DeleteClipCommand } from "@/core/history/commands/DeleteClipCommand";
import { usePlayback } from "@/hooks/usePlayback";
import { getTimelineViewportEnd } from "@/lib/timelineClip";
import { getActiveSessionOrNull } from "@/core/runtime/ProjectSession";
import { useTimelineDrag } from "@/hooks/useTimelineDrag";
import { useTimelineTauriDrop } from "@/hooks/useTimelineTauriDrop";
import { useTimelineZoom } from "@/hooks/useTimelineZoom";
import { useRenderRuntime } from "@/hooks/useRenderRuntime";

import { TimelineToolbar } from "./TimelineToolbar";
import { TimelineRuler } from "./TimelineRuler";
import { TrackList } from "./TrackList";
import { Track } from "./Track";
import { Playhead } from "./Playhead";
import { EmptyTimelineDropZone } from "./EmptyTimelineDropZone";

const SELECT_TRACE = import.meta.env.DEV;
const traceSelect = (...args: unknown[]) => {
  if (!SELECT_TRACE) return;
  console.log("[SelectTrace][Timeline]", ...args);
};

export const Timeline: React.FC = () => {
  const { tracks, clips, pixelsPerSecond, scrollLeft, setScrollLeft, getTimelineEndTime } = useTimelineStore();

  const { previewMode, exitSourceMode, clearSelection } = useUIStore();
  const { currentTime, duration, isPlaying, seek, setDuration } = usePlayback();
  const containerRef = useRef<HTMLDivElement>(null);
  const runtime = useRenderRuntime();

  // Consume extracted hooks
  useTimelineZoom(containerRef);
  const { isDraggingOver, isDraggingMedia } = useTimelineTauriDrop(containerRef);
  const { dragState, handleClipDragStart, handleClipDragMove, handleClipDragEnd } = useTimelineDrag(containerRef);

  // Attach scroll/pointer listeners to the timeline scroll container
  useEffect(() => {
    const container = containerRef.current;
    if (!runtime || !container) return;
    return runtime.attach(container);
  }, [runtime]);

  // Notify runtime when zoom scale changes
  useEffect(() => {
    if (!runtime) return;
    runtime.notifyZoom(pixelsPerSecond / 100);
  }, [runtime, pixelsPerSecond]);

  // ── Set playback duration based on actual sequence content ──────────────────
  useEffect(() => {
    const sequenceDuration = getTimelineEndTime();
    setDuration(sequenceDuration);
  }, [clips, getTimelineEndTime, setDuration]);

  // ── Clamp playhead to sequence bounds ──────────────────────────────────────
  useEffect(() => {
    if (currentTime > duration) {
      seek(duration);
    }
  }, [duration, currentTime, seek]);

  // Auto-scroll during playback: viewport tracking
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isPlaying) return;

    const viewportWidth = container.clientWidth;
    const contentWidthActual = container.scrollWidth;
    const maxScrollLeft = Math.max(0, contentWidthActual - viewportWidth);

    const playheadX = Math.round(currentTime * pixelsPerSecond);
    let newScrollLeft = container.scrollLeft;

    const isAtAbsoluteEnd = currentTime >= duration - 0.01;

    if (isAtAbsoluteEnd) {
      newScrollLeft = maxScrollLeft;
    } else {
      const bufferPx = viewportWidth * 0.1;
      const rightEdge = newScrollLeft + viewportWidth;

      if (playheadX >= rightEdge - bufferPx) {
        newScrollLeft = playheadX;
      }

      const currentRightEdge = newScrollLeft + viewportWidth;
      if (playheadX > currentRightEdge) {
        newScrollLeft = Math.min(playheadX, maxScrollLeft);
      }
    }

    newScrollLeft = Math.max(0, Math.min(newScrollLeft, maxScrollLeft));

    const epsilon = 2; // px
    if (maxScrollLeft - newScrollLeft < epsilon) {
      newScrollLeft = maxScrollLeft;
    }

    if (Math.abs(container.scrollLeft - newScrollLeft) > 0.5) {
      container.scrollLeft = newScrollLeft;
      setScrollLeft(newScrollLeft);
    }
  }, [currentTime, pixelsPerSecond, isPlaying, duration, setScrollLeft]);

  // Handle Delete/Backspace key to remove selected clips
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;

      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }

      const { selectedClipIds } = useUIStore.getState();
      if (selectedClipIds.length === 0) return;

      const store = useTimelineStore.getState();
      const { normalizeTrack, removeEmptyNonMainTracks, withBatch } = store;
      const { execute, beginTransaction, commitTransaction } = useHistoryStore.getState();
      const affectedTracks = new Set<string>();

      beginTransaction("Delete Clips");

      selectedClipIds.forEach((clipId) => {
        const clip = store.clips.find((c) => c.id === clipId);
        if (clip) {
          affectedTracks.add(clip.trackId);
          execute(new DeleteClipCommand(clipId));
        }
      });

      commitTransaction();

      withBatch(() => {
        affectedTracks.forEach((trackId) => normalizeTrack(trackId));
        removeEmptyNonMainTracks(Array.from(affectedTracks));
      });

      useUIStore.getState().clearSelection();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Rubber-band selection: press on empty track space and drag to select every clip
  // the rectangle touches (Shift/Ctrl adds to the current selection).
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const suppressNextClickRef = useRef(false);
  const RULER_HEIGHT_PX = 24;
  const MARQUEE_DRAG_THRESHOLD_PX = 4;

  const startMarquee = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    const toContent = (clientX: number, clientY: number) => ({ x: clientX - bounds.left + container.scrollLeft, y: clientY - bounds.top + container.scrollTop });
    const origin = toContent(event.clientX, event.clientY);
    if (origin.y <= RULER_HEIGHT_PX) return; // the ruler keeps its seek behaviour
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const baseSelection = additive ? [...useUIStore.getState().selectedClipIds] : [];
    let active = false;

    const onMove = (ev: PointerEvent) => {
      const now = toContent(ev.clientX, ev.clientY);
      if (!active && Math.hypot(now.x - origin.x, now.y - origin.y) < MARQUEE_DRAG_THRESHOLD_PX) return;
      active = true;
      const rect = { x: Math.min(origin.x, now.x), y: Math.min(origin.y, now.y), w: Math.abs(now.x - origin.x), h: Math.abs(now.y - origin.y) };
      setMarquee(rect);

      const hit = new Set(baseSelection);
      container.querySelectorAll<HTMLElement>("[data-clip-id]").forEach((el) => {
        const r = el.getBoundingClientRect();
        const a = toContent(r.left, r.top);
        if (a.x < rect.x + rect.w && a.x + r.width > rect.x && a.y < rect.y + rect.h && a.y + r.height > rect.y) {
          const id = el.getAttribute("data-clip-id");
          if (id) hit.add(id);
        }
      });
      useUIStore.setState({ selectedClipIds: Array.from(hit) });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setMarquee(null);
      // The click that follows a drag must not clear the selection or move the playhead.
      if (active) suppressNextClickRef.current = true;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, []);

  const handleTimelinePointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (dragState?.draggingClipId) return;
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-timeline-interactive="true"]')) return;
      startMarquee(event);
      traceSelect("timeline pointerdown -> clearSelection", {
        target: target.tagName,
        className: target.className,
        selectedBefore: useUIStore.getState().selectedClipIds,
      });
      useUIStore.getState().clearSelection();
    },
    [dragState, startMarquee],
  );

  const contentEnd = duration;
  const viewportEnd = getTimelineViewportEnd(contentEnd);
  const contentWidth = Math.round(viewportEnd * pixelsPerSecond);

  const seekFromPointer = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false;
        return;
      }
      const target = event.target as HTMLElement;
      if (target.closest('[data-timeline-interactive="true"]')) return;

      clearSelection();

      if (previewMode === "source") {
        exitSourceMode();
        getActiveSessionOrNull()?.transportAuthority?.setActiveContext("program");
      }

      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left + container.scrollLeft;
      const time = Math.max(0, Math.min(x / pixelsPerSecond, duration));
      seek(time);
    },
    [duration, pixelsPerSecond, seek, previewMode, exitSourceMode, clearSelection],
  );

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    setScrollLeft(target.scrollLeft);
  };

  return (
    <div className="h-60 md:h-80 flex flex-col select-none bg-[#141920] relative">
      <TimelineToolbar />

      <div className="flex-1 flex overflow-hidden">
        {clips.length > 0 && <TrackList />}

        <div ref={containerRef} onScroll={handleScroll} onPointerDownCapture={handleTimelinePointerDownCapture} onClick={seekFromPointer} id="timeline-tracks-container" className={`flex-1 overflow-x-auto overflow-y-auto scrollbar-thin px-1 relative transition-colors border-l border-[#2b3442] ${isDraggingOver ? "bg-cyan-500/10 ring-2 ring-cyan-500/50 ring-inset" : ""}`}>
          {marquee && <div className="absolute z-50 pointer-events-none border border-accent bg-accent/15" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
          {clips.length === 0 && <div className="absolute top-1/2 left-3 text-xl text-white pointer-events-none font-mono">Drop media here • I to import</div>}

          <div
            style={{
              width: `${contentWidth}px`,
              minHeight: "100%",
            }}
            className="relative flex flex-col"
          >
            <TimelineRuler pixelsPerSecond={pixelsPerSecond} scrollLeft={scrollLeft} />

            <div className="relative flex-1 flex flex-col min-h-0">
              {clips.length === 0 ? (
                <EmptyTimelineDropZone isDragging={isDraggingMedia} />
              ) : (
                <>
                  {dragState?.willCreateNewTrack && dragState?.newTrackPosition === "above" && (
                    <div
                      className="absolute left-0 right-0 pointer-events-none z-50"
                      style={{
                        top: 0,
                        height: "2px",
                        background: "#3b82f6",
                        boxShadow: "0 0 8px rgba(59, 130, 246, 0.6)",
                      }}
                    />
                  )}

                  {tracks.map((track) => (
                    <React.Fragment key={track.id}>
                      <Track
                        track={track}
                        pixelsPerSecond={pixelsPerSecond}
                        clips={clips}
                        onClipDragStart={handleClipDragStart}
                        onClipDragMove={handleClipDragMove}
                        onClipDragEnd={handleClipDragEnd}
                        dragState={
                          dragState
                            ? {
                                draggingClipId: dragState.draggingClipId,
                                offsetX: dragState.offsetX,
                                offsetY: dragState.offsetY,
                                isInvalidPosition: dragState.isInvalidPosition,
                                targetTrackId: dragState.targetTrackId,
                                insertionIndex: dragState.insertionIndex,
                                gapStartTime: dragState.gapStartTime,
                                gapDuration: dragState.gapDuration,
                              }
                            : undefined
                        }
                      />
                    </React.Fragment>
                  ))}

                  {dragState?.willCreateNewTrack && dragState?.newTrackPosition === "below" && (
                    <div
                      className="absolute left-0 right-0 pointer-events-none z-50"
                      style={{
                        bottom: 0,
                        height: "2px",
                        background: "#3b82f6",
                        boxShadow: "0 0 8px rgba(59, 130, 246, 0.6)",
                      }}
                    />
                  )}

                  <Playhead pixelsPerSecond={pixelsPerSecond} duration={duration} containerRef={containerRef} rulerHeight={24} />
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
