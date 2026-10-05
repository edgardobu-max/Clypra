import React from "react";
import type { Clip } from "@/types";
import { type ClipFitModeExtended } from "@/lib/timelineClip";

interface TransformSectionProps {
  selectedClip: Clip;
  isVisualClip: boolean;
  handleUpdate: (key: string, value: any) => void;
  handleApplyFit: (fitMode: ClipFitModeExtended) => void;
  handleResize: (change: { width?: number; height?: number }) => void;
  canvasWidth: number;
}

export const TransformSection: React.FC<TransformSectionProps> = ({ selectedClip, isVisualClip, handleUpdate, handleApplyFit, handleResize, canvasWidth }) => {
  const locked = selectedClip.aspectRatioLocked ?? true;
  // Scale is shown as a share of the canvas width: 100% = as wide as the video frame.
  const scalePercent = Math.round((selectedClip.width / Math.max(1, canvasWidth)) * 100);
  return (
    <div className="space-y-6">
      {/* Transform Properties */}
      <div>
        <h4 className="text-sm font-semibold text-text-primary mb-3">Transform</h4>
        <div className="space-y-2">
          {isVisualClip && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-text-muted block mb-1">Fit Mode</label>
                <select value={selectedClip.fitMode ?? "cover"} onChange={(e) => handleApplyFit(e.target.value as ClipFitModeExtended)} className="w-full bg-surface-raised border border-border rounded px-2 py-1 text-xs text-text-primary outline-none">
                  <option value="contain">Contain</option>
                  <option value="cover">Cover</option>
                  <option value="fill">Fill</option>
                  <option value="stretch">Stretch</option>
                  <option value="original">Original</option>
                </select>
              </div>
              <div className="flex items-end">
                <button type="button" onClick={() => handleApplyFit(selectedClip.fitMode ?? "cover")} className="w-full bg-surface-raised border border-border rounded px-2 py-1 text-xs text-text-primary hover:bg-white/6 transition-all active:scale-[0.97]">
                  Reset Fit
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-text-muted block mb-1">X Position</label>
              <input type="number" value={Math.round(selectedClip.x)} onChange={(e) => handleUpdate("x", Number(e.target.value))} className="w-full bg-surface-raised border border-border rounded px-2 py-1 text-xs text-text-primary outline-none" />
            </div>
            <div>
              <label className="text-xs text-text-muted block mb-1">Y Position</label>
              <input type="number" value={Math.round(selectedClip.y)} onChange={(e) => handleUpdate("y", Number(e.target.value))} className="w-full bg-surface-raised border border-border rounded px-2 py-1 text-xs text-text-primary outline-none" />
            </div>
          </div>

          {isVisualClip && (
            <div>
              <label className="text-xs text-text-muted block mb-1">Escala (% del ancho del video)</label>
              <div className="flex items-center gap-2">
                <input type="range" min="5" max="300" value={Math.min(300, Math.max(5, scalePercent))} onChange={(e) => handleResize({ width: (Number(e.target.value) / 100) * canvasWidth })} className="grow accent-accent" />
                <span className="text-xs text-text-primary w-10 text-right">{scalePercent}%</span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-text-muted block mb-1">Width</label>
              <input type="number" value={Math.round(selectedClip.width)} onChange={(e) => handleResize({ width: Number(e.target.value) })} className="w-full bg-surface-raised border border-border rounded px-2 py-1 text-xs text-text-primary outline-none" />
            </div>
            <div>
              <label className="text-xs text-text-muted block mb-1">Height</label>
              <input type="number" value={Math.round(selectedClip.height)} onChange={(e) => handleResize({ height: Number(e.target.value) })} className="w-full bg-surface-raised border border-border rounded px-2 py-1 text-xs text-text-primary outline-none" />
            </div>
          </div>

          {isVisualClip && (
            <label className="flex items-center gap-2 text-xs text-text-muted cursor-pointer select-none">
              <input type="checkbox" checked={locked} onChange={(e) => handleUpdate("aspectRatioLocked", e.target.checked)} className="accent-accent" />
              Mantener proporcion (desmarca para deformar libremente)
            </label>
          )}

          <div>
            <label className="text-xs text-text-muted block mb-1">Rotation</label>
            <div className="flex items-center gap-2">
              <input type="range" min="-180" max="180" value={selectedClip.rotation} onChange={(e) => handleUpdate("rotation", Number(e.target.value))} className="grow accent-accent" />
              <input type="number" value={Math.round(selectedClip.rotation)} onChange={(e) => handleUpdate("rotation", Number(e.target.value))} className="w-12 bg-surface-raised border border-border rounded px-2 py-0.5 text-xs text-text-primary text-center outline-none" />
            </div>
          </div>

          <div>
            <label className="text-xs text-text-muted block mb-1">Opacity</label>
            <div className="flex items-center gap-2">
              <input type="range" min="0" max="100" value={selectedClip.opacity * 100} onChange={(e) => handleUpdate("opacity", Number(e.target.value) / 100)} className="grow accent-accent" />
              <span className="text-xs text-text-primary w-8 text-right">{Math.round(selectedClip.opacity * 100)}%</span>
            </div>
          </div>
        </div>
      </div>

      {/* Clip Timing properties */}
      <div className="border-t border-border/40 pt-4">
        <div className="mb-3">
          <h4 className="text-sm font-semibold text-text-primary">Timing Options</h4>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-text-muted block mb-1">Trim In (seconds)</label>
            <input type="number" value={selectedClip.trimIn.toFixed(2)} onChange={(e) => handleUpdate("trimIn", Number(e.target.value))} className="w-full bg-surface-raised border border-border rounded px-2.5 py-1 text-xs text-text-primary outline-none" />
          </div>

          <div>
            <label className="text-xs text-text-muted block mb-1">Trim Out (seconds)</label>
            <input type="number" value={selectedClip.trimOut.toFixed(2)} onChange={(e) => handleUpdate("trimOut", Number(e.target.value))} className="w-full bg-surface-raised border border-border rounded px-2.5 py-1 text-xs text-text-primary outline-none" />
          </div>
        </div>
      </div>
    </div>
  );
};
