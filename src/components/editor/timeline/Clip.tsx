import React, { useState, useEffect, useRef } from "react";
import { useUIStore } from "@/store/uiStore";
import { useTimelineStore } from "@/store/timelineStore";
import type { Clip as ClipType, MediaAsset } from "@/types";
import { ClipFilmstrip } from "./ClipFilmstrip";
import { clipSpeed } from "@/lib/clipSpeed";
import { TimelineWaveform } from "./TimelineWaveform";

/** Movement past this (px) starts a clip drag; below it, release is still a click (selection set on pointerDown). */
const DRAG_THRESHOLD_PX = 6;
const RESIZE_TRACE = true;
const MAX_STILL_CLIP_DURATION_SEC = 60 * 60; // 1 hour guardrail for stills
const MIN_TRIM_DURATION_SEC = 1;
const traceResize = (...args: unknown[]) => {
  if (!RESIZE_TRACE) return;
  console.log("[ClipResizeTrace]", ...args);
};

interface ClipProps {
  clip: ClipType;
  mediaAsset?: MediaAsset;
  pixelsPerSecond: number;
  selected?: boolean;
  locked?: boolean;
  onDragStart?: (clipId: string, startX: number, startY: number) => void;
  onDragMove?: (clipId: string, deltaX: number, deltaY: number, clientX: number, clientY: number) => void;
  onDragEnd?: (clipId: string) => void;
  dragState?: {
    isDragging: boolean;
    offsetX: number;
    offsetY: number;
    isInvalidPosition?: boolean;
  };
}

const ClipInner: React.FC<ClipProps> = ({ clip, mediaAsset, pixelsPerSecond, selected, locked = false, onDragStart, onDragMove, onDragEnd, dragState }) => {
  const { selectClip, toggleClipSelection } = useUIStore();
  const { clips, updateClip, rippleEditEnabled, rippleTrimClip } = useTimelineStore();
  const [isResizing, setIsResizing] = useState<"left" | "right" | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [resizeStart, setResizeStart] = useState<{ x: number; startTime: number; duration: number; trimIn: number; trimOut: number; isRipple: boolean } | null>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ startX: number; startY: number; startTime: number; hasMoved: boolean; hasDragStarted: boolean; pointerId: number } | null>(null);
  const isPointerOnResizeHandle = (target: EventTarget | null) => {
    const el = target as HTMLElement | null;
    if (!el) return false;
    return Boolean(el.closest("[data-clip-resize-handle='true']"));
  };

  // Calculate position
  const left = Math.round(clip.startTime * pixelsPerSecond);
  const width = Math.round(clip.duration * pixelsPerSecond);

  // Apply drag offset if dragging
  const isDragging = dragState?.isDragging || false;
  const isInvalidPosition = dragState?.isInvalidPosition || false;
  const displayLeft = isDragging ? left + (dragState?.offsetX || 0) : left;
  const showResizeHandles = Boolean(selected || isResizing || isHovered);

  // Handle pointer-based drag
  const handlePointerDown = (e: React.PointerEvent) => {
    // Ignore if locked, resizing, or not left button
    if (locked || isResizing || e.button !== 0) return;

    // Check if clicking resize handle
    if (isPointerOnResizeHandle(e.target)) {
      return;
    }

    // Start drag
    e.stopPropagation();
    const rect = clipRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Select on press so a real click always selects; drag only starts after DRAG_THRESHOLD_PX.
    const isMultiKey = e.shiftKey || e.metaKey || e.ctrlKey;
    const alreadySelected = useUIStore.getState().selectedClipIds.includes(clip.id);
    if (isMultiKey) {
      toggleClipSelection(clip.id);
    } else if (!alreadySelected) {
      selectClip(clip.id);
    }

    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTime: clip.startTime,
      hasMoved: false,
      hasDragStarted: false,
      pointerId: e.pointerId,
    };

    // Capture pointer for smooth dragging
    clipRef.current?.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isPointerOnResizeHandle(e.target)) return;
    if (!dragStartRef.current || !onDragMove) {
      // Silently ignore pointer moves when not dragging (normal behavior)
      return;
    }

    const deltaX = e.clientX - dragStartRef.current.startX;
    const deltaY = e.clientY - dragStartRef.current.startY;

    // Mark as moved if threshold exceeded
    if (!dragStartRef.current.hasMoved && (Math.abs(deltaX) > DRAG_THRESHOLD_PX || Math.abs(deltaY) > DRAG_THRESHOLD_PX)) {
      dragStartRef.current.hasMoved = true;
      if (!dragStartRef.current.hasDragStarted) {
        dragStartRef.current.hasDragStarted = true;
        onDragStart?.(clip.id, dragStartRef.current.startX, dragStartRef.current.startY);
      }
    }

    if (dragStartRef.current.hasMoved) {
      onDragMove(clip.id, deltaX, deltaY, e.clientX, e.clientY);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!dragStartRef.current) return;

    if (dragStartRef.current.hasDragStarted) {
      onDragEnd?.(clip.id);
    }
    clipRef.current?.releasePointerCapture(dragStartRef.current.pointerId);
    dragStartRef.current = null;
  };

  const handlePointerCancel = () => {
    if (!dragStartRef.current) return;
    if (dragStartRef.current.hasDragStarted) {
      onDragEnd?.(clip.id);
    }
    clipRef.current?.releasePointerCapture(dragStartRef.current.pointerId);
    dragStartRef.current = null;
  };

  const resizePointerIdRef = useRef<number | null>(null);
  const activeResizeHandleRef = useRef<HTMLElement | null>(null);

  const handleResizeStart = (e: React.PointerEvent, side: "left" | "right") => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0) return;
    if (locked) return;

    // Let's check if ripple mode is active (Shift key OR global ripple mode enabled)
    const isRipple = e.shiftKey || rippleEditEnabled;
    traceResize("pointerdown", {
      clipId: clip.id,
      side,
      pointerId: e.pointerId,
      button: e.button,
      clientX: e.clientX,
      isRipple,
      selected,
      locked,
      startTime: clip.startTime,
      duration: clip.duration,
      trimIn: clip.trimIn,
      trimOut: clip.trimOut,
    });
    resizePointerIdRef.current = e.pointerId;
    activeResizeHandleRef.current = e.currentTarget as HTMLElement;
    try {
      activeResizeHandleRef.current.setPointerCapture(e.pointerId);
    } catch {
      // Best-effort: window listeners below still provide robustness.
    }

    setIsResizing(side);
    setResizeStart({
      x: e.clientX,
      startTime: clip.startTime,
      duration: clip.duration,
      trimIn: clip.trimIn,
      trimOut: clip.trimOut,
      isRipple,
    });

    // Let's prevent text selection during resize
    document.body.style.userSelect = "none";
  };

  const handleResizeStartMouse = (e: React.MouseEvent, side: "left" | "right") => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0) return;
    if (locked) return;

    const isRipple = e.shiftKey || rippleEditEnabled;
    traceResize("mousedown-fallback", {
      clipId: clip.id,
      side,
      button: e.button,
      clientX: e.clientX,
      clientY: e.clientY,
      isRipple,
      selected,
      locked,
    });
    resizePointerIdRef.current = null;
    activeResizeHandleRef.current = e.currentTarget as HTMLElement;
    setIsResizing(side);
    setResizeStart({
      x: e.clientX,
      startTime: clip.startTime,
      duration: clip.duration,
      trimIn: clip.trimIn,
      trimOut: clip.trimOut,
      isRipple,
    });
    document.body.style.userSelect = "none";
  };

  useEffect(() => {
    if (!RESIZE_TRACE) return;
    const onDocPointerDownCapture = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const handle = target.closest("[data-clip-resize-handle='true']") as HTMLElement | null;
      if (!handle) return;
      traceResize("document pointerdown-capture hit resize handle", {
        clipId: clip.id,
        pointerId: e.pointerId,
        button: e.button,
        clientX: e.clientX,
        clientY: e.clientY,
        handleTestId: handle.getAttribute("data-testid"),
        handleAttr: handle.getAttribute("data-clip-resize-handle"),
      });
    };
    document.addEventListener("pointerdown", onDocPointerDownCapture, true);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDownCapture, true);
    };
  }, [clip.id]);

  useEffect(() => {
    if (!isResizing || !resizeStart) return;
    traceResize("resize-started", {
      clipId: clip.id,
      side: isResizing,
      pointerId: resizePointerIdRef.current,
      resizeStart,
    });

    const handlePointerMove = (e: PointerEvent) => {
      if (resizePointerIdRef.current !== null && e.pointerId !== resizePointerIdRef.current) return;
      const deltaX = e.clientX - resizeStart.x;
      const deltaTime = deltaX / pixelsPerSecond;
      const isRippleActive = e.shiftKey || rippleEditEnabled;

      const trackClips = clips.filter((c) => c.trackId === clip.trackId && c.id !== clip.id);
      const prevClipEnd = trackClips.reduce((maxEnd, c) => {
        const end = c.startTime + c.duration;
        if (end <= resizeStart.startTime + 1e-6) return Math.max(maxEnd, end);
        return maxEnd;
      }, 0);
      const nextClipStart = trackClips.reduce((minStart, c) => {
        if (c.startTime >= resizeStart.startTime + resizeStart.duration - 1e-6) return Math.min(minStart, c.startTime);
        return minStart;
      }, Number.POSITIVE_INFINITY);

      traceResize("pointermove", {
        clipId: clip.id,
        side: isResizing,
        pointerId: e.pointerId,
        clientX: e.clientX,
        deltaX,
        deltaTime,
        ripple: isRippleActive,
      });

      if (isRippleActive) {
        // RIPPLE MODE: Shift downstream clips
        traceResize("apply-ripple-trim", {
          clipId: clip.id,
          side: isResizing,
          deltaTime,
        });
        rippleTrimClip(clip.id, isResizing, deltaTime);

        // Update resizeStart to track cumulative changes
        setResizeStart({
          ...resizeStart,
          x: e.clientX,
        });
      } else {
        // STANDARD MODE: Normal trim (no ripple)
        if (isResizing === "left") {
          // Resize from left (trim in)
          const minDuration = MIN_TRIM_DURATION_SEC;
          const isStill = !mediaAsset || mediaAsset.type === "image";
          const maxMediaTime = isStill ? MAX_STILL_CLIP_DURATION_SEC : (mediaAsset?.duration ?? resizeStart.trimOut);
          const maxTrimIn = Math.min(maxMediaTime, resizeStart.trimOut - 0.001);

          // Desired new trimIn based on pointer movement; clamp instead of freezing.
          const desiredStartTime = resizeStart.startTime + deltaTime;
          const desiredDelta = desiredStartTime - resizeStart.startTime;

          // Clamp delta by: timeline start, minimum duration, and media trimIn bounds.
          const minDelta = Math.max(-resizeStart.startTime, prevClipEnd - resizeStart.startTime);
          const maxDeltaByDuration = resizeStart.duration - minDuration;
          const speed = clipSpeed(clip);
          const maxDeltaByMedia = (maxTrimIn - resizeStart.trimIn) / speed;
          const clampedDelta = Math.max(minDelta, Math.min(desiredDelta, maxDeltaByDuration, maxDeltaByMedia));

          const newStartTime = resizeStart.startTime + clampedDelta;
          const newDuration = resizeStart.duration - clampedDelta;
          const newTrimIn = resizeStart.trimIn + clampedDelta * speed;

          updateClip(clip.id, {
            startTime: Math.max(0, newStartTime),
            duration: Math.max(minDuration, newDuration),
            trimIn: Math.max(0, Math.min(newTrimIn, maxTrimIn)),
          });
          traceResize("apply-standard-left", {
            clipId: clip.id,
            newStartTime: Math.max(0, newStartTime),
            newDuration: Math.max(minDuration, newDuration),
            newTrimIn: Math.max(0, Math.min(newTrimIn, maxTrimIn)),
          });
        } else {
          // Resize from right (trim out)
          const minDuration = MIN_TRIM_DURATION_SEC;
          const isStill = !mediaAsset || mediaAsset.type === "image";
          const maxMediaTime = isStill ? MAX_STILL_CLIP_DURATION_SEC : (mediaAsset?.duration ?? resizeStart.trimOut);
          const speed = clipSpeed(clip);
          const maxDurationByMedia = Math.max(minDuration, (maxMediaTime - resizeStart.trimIn) / speed);
          const maxDurationByNextClip = Number.isFinite(nextClipStart) ? Math.max(minDuration, nextClipStart - resizeStart.startTime) : Number.POSITIVE_INFINITY;
          const maxDuration = Math.min(maxDurationByMedia, maxDurationByNextClip);

          const desiredDuration = resizeStart.duration + deltaTime;
          const newDuration = Math.max(minDuration, Math.min(desiredDuration, maxDuration));
          const unclampedTrimOut = resizeStart.trimIn + newDuration * speed;
          const newTrimOut = isStill ? unclampedTrimOut : Math.min(unclampedTrimOut, maxMediaTime);

          updateClip(clip.id, {
            duration: newDuration,
            trimOut: newTrimOut,
          });
          traceResize("apply-standard-right", {
            clipId: clip.id,
            newDuration,
            newTrimOut,
          });
        }
      }
    };

    const finishResize = () => {
      if (activeResizeHandleRef.current && resizePointerIdRef.current !== null) {
        try {
          activeResizeHandleRef.current.releasePointerCapture(resizePointerIdRef.current);
        } catch {
          // Ignore when capture is already released.
        }
      }
      setIsResizing(null);
      setResizeStart(null);
      activeResizeHandleRef.current = null;
      resizePointerIdRef.current = null;
      document.body.style.userSelect = "";
    };

    const handlePointerUp = (e: PointerEvent) => {
      if (resizePointerIdRef.current !== null && e.pointerId !== resizePointerIdRef.current) return;
      traceResize("pointerup", {
        clipId: clip.id,
        side: isResizing,
        pointerId: e.pointerId,
      });
      finishResize();
    };

    const handlePointerCancel = (e: PointerEvent) => {
      if (resizePointerIdRef.current !== null && e.pointerId !== resizePointerIdRef.current) return;
      traceResize("pointercancel", {
        clipId: clip.id,
        side: isResizing,
        pointerId: e.pointerId,
      });
      finishResize();
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("pointercancel", handlePointerCancel);

    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("pointercancel", handlePointerCancel);
      traceResize("resize-effect-cleanup", {
        clipId: clip.id,
        side: isResizing,
      });
    };
  }, [isResizing, resizeStart, clip.id, pixelsPerSecond, updateClip, rippleTrimClip, mediaAsset]);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `00:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}:00`;
  };

  const isClipText = "text" in clip;
  const isClipAudio = mediaAsset?.type === "audio";
  const isClipVideo = mediaAsset?.type === "video";
  const isClipImage = mediaAsset?.type === "image";

  const getClipStyle = () => {
    if (isClipText) return "bg-(--color-timeline-text-clip-bg) text-(--color-timeline-text-clip-text)";
    if (mediaAsset?.type === "audio") return "bg-timeline-clip-audio border-timeline-clip-audio-border";
    return "h-full bg-accent";
  };

  return (
    <div
      ref={clipRef}
      data-timeline-interactive="true"
      data-testid={`clip-${clip.id}`}
      data-clip-id={clip.id}
      data-clip-start={clip.startTime}
      data-clip-duration={clip.duration}
      onPointerDownCapture={(e) => {
        if (isPointerOnResizeHandle(e.target)) {
          e.stopPropagation();
        }
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
      className={`absolute rounded-sm h-full overflow-hidden border ${selected ? "border-white" : ""} ${isResizing ? (resizeStart?.isRipple ? "ring-2 ring-yellow-500" : "ring-2 ring-cyan-500") : ""} ${locked ? "cursor-not-allowed" : isDragging ? (isInvalidPosition ? "cursor-not-allowed" : "cursor-grabbing") : "cursor-default"} ${getClipStyle()} transition-none`}
      style={{
        left: `${displayLeft}px`,
        width: `${width}px`,
        opacity: isInvalidPosition ? 0.5 : 1,
        pointerEvents: "auto",
        touchAction: "none",
        zIndex: isDragging ? 100 : 1,
        boxShadow: "none",
        transformOrigin: isDragging ? "0 0" : undefined,
        transform: isDragging ? `translateY(${dragState?.offsetY ?? 0}px)` : "none",
        border: isInvalidPosition ? "2px solid var(--color-timeline-clip-invalid)" : undefined,
      }}
    >
      {/* Left trim handle */}
      <div
        data-testid={`clip-${clip.id}-resize-left`}
        data-clip-resize-handle="true"
        className={`absolute left-0 top-0 w-3 h-full z-30 cursor-col-resize ${showResizeHandles ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"} ${isResizing === "left" ? (resizeStart?.isRipple ? "bg-yellow-300/60" : "bg-cyan-300/60") : "bg-white/25 hover:bg-white/35"} transition-colors`}
        style={{ touchAction: "none", cursor: "col-resize" }}
        onPointerDownCapture={(e) => {
          traceResize("left-handle pointerdown-capture", {
            clipId: clip.id,
            pointerId: e.pointerId,
            button: e.button,
            clientX: e.clientX,
            clientY: e.clientY,
            targetTag: (e.target as HTMLElement | null)?.tagName,
            currentTargetTag: (e.currentTarget as HTMLElement | null)?.tagName,
          });
          e.stopPropagation();
        }}
        onPointerDown={(e) => {
          traceResize("left-handle pointerdown", {
            clipId: clip.id,
            pointerId: e.pointerId,
            button: e.button,
            clientX: e.clientX,
            clientY: e.clientY,
            rippleEditEnabled,
            shiftKey: e.shiftKey,
          });
          e.stopPropagation(); // Prevent drag when clicking resize handle
          handleResizeStart(e, "left");
        }}
        onMouseDown={(e) => {
          traceResize("left-handle mousedown", { clipId: clip.id, clientX: e.clientX, clientY: e.clientY, button: e.button });
          handleResizeStartMouse(e, "left");
        }}
        title={rippleEditEnabled ? "Ripple trim (ripple mode ON)" : "Hold Shift for ripple trim"}
      >
        <div className="absolute left-[5px] top-1/2 h-[70%] w-[2px] -translate-y-1/2 rounded bg-white/90" />
      </div>

      {/* Clip content */}
      {"text" in clip ? (
        <div className="flex h-full w-full items-center px-3">
          <div className="text-[12px] text-white/95 font-medium tracking-[0.01em] truncate max-w-full select-none pointer-events-none">{(clip as any).text || "Default text"}</div>
        </div>
      ) : (
        <div className="flex h-full min-h-0 w-full flex-col gap-1 overflow-hidden px-1 py-1">
          <div className="flex shrink-0 items-center gap-3">
            <div className="text-[9px] font-semibold tracking-[0.01em] text-timeline-clip-text truncate">{mediaAsset?.name || "Clip"}</div>
            <div className="text-[9px] font-medium text-timeline-clip-duration shrink-0">{formatDuration(clip.duration)}</div>
          </div>
          {mediaAsset && (mediaAsset.type === "video" || mediaAsset.type === "image") ? (
            <div className="flex min-h-0 w-full flex-1 items-center">
              <ClipFilmstrip className="w-full shrink-0" clip={clip} mediaAsset={mediaAsset} clipWidthPx={width} pixelsPerSecond={pixelsPerSecond} stripHeightPx={40} viewportScrollLeft={0} viewportWidth={1920} />
            </div>
          ) : mediaAsset?.type === "audio" ? (
            <div className="flex min-h-0 w-full flex-1 items-center">
              <TimelineWaveform audioPath={mediaAsset.path} clipWidthPx={width} duration={clip.duration} className="rounded-[2px]" />
            </div>
          ) : mediaAsset?.posterFrame ? (
            <img src={mediaAsset.posterFrame} alt="" className="h-8 w-full rounded-[2px] border border-black/20 object-cover" draggable={false} />
          ) : (
            <div className="h-8 w-full rounded-[2px] bg-timeline-filmstrip-empty" />
          )}
        </div>
      )}

      {/* Right trim handle */}
      <div
        data-testid={`clip-${clip.id}-resize-right`}
        data-clip-resize-handle="true"
        className={`absolute right-0 top-0 w-3 h-full z-30 cursor-col-resize ${showResizeHandles ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"} ${isResizing === "right" ? (resizeStart?.isRipple ? "bg-yellow-300/60" : "bg-cyan-300/60") : "bg-white/25 hover:bg-white/35"} transition-colors`}
        style={{ touchAction: "none", cursor: "col-resize" }}
        onPointerDownCapture={(e) => {
          traceResize("right-handle pointerdown-capture", {
            clipId: clip.id,
            pointerId: e.pointerId,
            button: e.button,
            clientX: e.clientX,
            clientY: e.clientY,
            targetTag: (e.target as HTMLElement | null)?.tagName,
            currentTargetTag: (e.currentTarget as HTMLElement | null)?.tagName,
          });
          e.stopPropagation();
        }}
        onPointerDown={(e) => {
          traceResize("right-handle pointerdown", {
            clipId: clip.id,
            pointerId: e.pointerId,
            button: e.button,
            clientX: e.clientX,
            clientY: e.clientY,
            rippleEditEnabled,
            shiftKey: e.shiftKey,
          });
          e.stopPropagation(); // Prevent drag when clicking resize handle
          handleResizeStart(e, "right");
        }}
        onMouseDown={(e) => {
          traceResize("right-handle mousedown", { clipId: clip.id, clientX: e.clientX, clientY: e.clientY, button: e.button });
          handleResizeStartMouse(e, "right");
        }}
        title={rippleEditEnabled ? "Ripple trim (ripple mode ON)" : "Hold Shift for ripple trim"}
      >
        <div className="absolute right-[5px] top-1/2 h-[70%] w-[2px] -translate-y-1/2 rounded bg-white/90" />
      </div>
    </div>
  );
};

export const Clip = React.memo(ClipInner);
