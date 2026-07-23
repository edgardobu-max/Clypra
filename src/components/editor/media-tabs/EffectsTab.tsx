import React, { useMemo } from "react";
import type { TabProps } from "./types";
import { useUIStore } from "@/store/uiStore";
import { useTimelineStore } from "@/store/timelineStore";

// Not implemented yet — shown for context on what's coming, not clickable.
const PLANNED_EFFECTS = [
  { id: "fx-1", name: "Blur", icon: "🌫️" },
  { id: "fx-2", name: "Black & White", icon: "⚫" },
  { id: "fx-3", name: "Sepia", icon: "🟤" },
  { id: "fx-4", name: "Vignette", icon: "⭕" },
  { id: "fx-5", name: "Sharpen", icon: "🔪" },
  { id: "fx-6", name: "Glow", icon: "💡" },
  { id: "fx-7", name: "Chromatic", icon: "🌈" },
  { id: "fx-8", name: "Pixelate", icon: "🟦" },
  { id: "fx-9", name: "Noise", icon: "📺" },
];

interface AdjustmentSliderProps {
  label: string;
  value: number; // -100..100 display units
  onChange: (value: number) => void;
  disabled: boolean;
}

const AdjustmentSlider: React.FC<AdjustmentSliderProps> = ({ label, value, onChange, disabled }) => (
  <div className="flex flex-col gap-1">
    <div className="flex items-center justify-between">
      <span className="text-xs text-text-primary">{label}</span>
      <span className="text-xs text-text-muted">{value > 0 ? `+${value}` : value}</span>
    </div>
    <input type="range" min={-100} max={100} step={1} value={value} disabled={disabled} onChange={(e) => onChange(parseInt(e.target.value, 10))} className="w-full disabled:opacity-40" />
  </div>
);

export const EffectsTab: React.FC<TabProps> = () => {
  const selectedClipIds = useUIStore((s) => s.selectedClipIds);
  const clips = useTimelineStore((s) => s.clips);
  const updateClip = useTimelineStore((s) => s.updateClip);

  const selectedClip = useMemo(() => clips.find((c) => c.id === selectedClipIds[0]), [clips, selectedClipIds]);

  // Stored as brightness -1..1, contrast/saturation 0..2 (1 = neutral); the
  // UI works in a -100..100 "offset from neutral" scale, which is friendlier
  // to drag and matches how most short-form editors present these sliders.
  const brightnessDisplay = Math.round(((selectedClip as any)?.brightness ?? 0) * 100);
  const contrastDisplay = Math.round((((selectedClip as any)?.contrast ?? 1) - 1) * 100);
  const saturationDisplay = Math.round((((selectedClip as any)?.saturation ?? 1) - 1) * 100);

  const setBrightness = (v: number) => selectedClip && updateClip(selectedClip.id, { brightness: v / 100 } as any);
  const setContrast = (v: number) => selectedClip && updateClip(selectedClip.id, { contrast: 1 + v / 100 } as any);
  const setSaturation = (v: number) => selectedClip && updateClip(selectedClip.id, { saturation: 1 + v / 100 } as any);

  const resetAll = () => selectedClip && updateClip(selectedClip.id, { brightness: undefined, contrast: undefined, saturation: undefined } as any);

  const hasAdjustments = brightnessDisplay !== 0 || contrastDisplay !== 0 || saturationDisplay !== 0;

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin p-3 flex flex-col gap-4">
      {!selectedClip && <p className="text-xs text-text-muted">Selecciona un clip en el timeline para ajustar brillo, contraste y saturacion.</p>}

      <div className="flex flex-col gap-3 p-3 rounded-lg bg-surface-raised">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-text-primary">Ajustes basicos</p>
          {hasAdjustments && (
            <button onClick={resetAll} className="text-xs text-text-muted hover:text-red-400 cursor-pointer">
              Restablecer
            </button>
          )}
        </div>
        <AdjustmentSlider label="Brillo" value={brightnessDisplay} onChange={setBrightness} disabled={!selectedClip} />
        <AdjustmentSlider label="Contraste" value={contrastDisplay} onChange={setContrast} disabled={!selectedClip} />
        <AdjustmentSlider label="Saturacion" value={saturationDisplay} onChange={setSaturation} disabled={!selectedClip} />
      </div>

      <div className="pt-2 border-t border-border">
        <p className="text-xs text-text-muted mb-2">Proximamente</p>
        <div className="grid grid-cols-2 gap-2">
          {PLANNED_EFFECTS.map((effect) => (
            <div key={effect.id} className="p-4 bg-surface-raised/40 rounded-lg text-left opacity-50 cursor-not-allowed">
              <div className="text-3xl mb-2">{effect.icon}</div>
              <p className="text-sm font-medium text-text-primary">{effect.name}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
