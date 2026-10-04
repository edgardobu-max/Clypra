import React, { useCallback, useEffect, useState } from "react";

/** A size (px) that survives restarts; storage failures just fall back to the default. */
export function usePersistentSize(key: string, initial: number, min: number, max: number) {
  const [size, setSize] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(key));
      if (Number.isFinite(saved) && saved >= min && saved <= max) return saved;
    } catch {
      /* storage unavailable */
    }
    return initial;
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, String(Math.round(size)));
    } catch {
      /* storage unavailable */
    }
  }, [key, size]);

  const update = useCallback((next: number) => setSize(Math.min(max, Math.max(min, next))), [min, max]);
  return [size, update] as const;
}

interface ResizeHandleProps {
  /** "vertical" = a vertical bar that resizes width; "horizontal" = a bar that resizes height. */
  orientation: "vertical" | "horizontal";
  /** Current size in px of the panel being resized. */
  size: number;
  onResize: (next: number) => void;
  /** +1 if dragging right/down grows the panel, -1 if it shrinks it. */
  direction: 1 | -1;
  label: string;
}

export const ResizeHandle: React.FC<ResizeHandleProps> = ({ orientation, size, onResize, direction, label }) => {
  const vertical = orientation === "vertical";

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const start = vertical ? e.clientX : e.clientY;
    const startSize = size;

    const onMove = (ev: PointerEvent) => {
      const delta = (vertical ? ev.clientX : ev.clientY) - start;
      onResize(startSize + delta * direction);
    };
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const grow = vertical ? "ArrowRight" : "ArrowDown";
    const shrink = vertical ? "ArrowLeft" : "ArrowUp";
    if (e.key === grow) onResize(size + 16 * direction);
    else if (e.key === shrink) onResize(size - 16 * direction);
  };

  return <div role="separator" aria-orientation={orientation} aria-label={label} tabIndex={0} onPointerDown={onPointerDown} onKeyDown={onKeyDown} className={`shrink-0 touch-none select-none rounded-full bg-transparent hover:bg-accent/50 focus-visible:bg-accent/60 active:bg-accent transition-colors ${vertical ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"}`} />;
};
