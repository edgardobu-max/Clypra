import React, { useMemo } from "react";
import type { TabProps } from "./types";
import { useUIStore } from "@/store/uiStore";
import { useTimelineStore } from "@/store/timelineStore";
import { useProjectStore } from "@/store/projectStore";
import { MEJORA_HD, NO_ADJUSTMENTS, hasAnyAdjustment, matchesPreset } from "@/lib/colorPresets";

// Not implemented yet — shown for context on what's coming, not clickable.
const PLANNED_EFFECTS = [
  { id: "fx-1", name: "Blur", icon: "🌫️" },
  { id: "fx-2", name: "Black & White", icon: "⚫" },
  { id: "fx-3", name: "Sepia", icon: "🟤" },
  { id: "fx-4", name: "Vignette", icon: "⭕" },
  { id: "fx-6", name: "Glow", icon: "💡" },
  { id: "fx-7", name: "Chromatic", icon: "🌈" },
  { id: "fx-8", name: "Pixelate", icon: "🟦" },
  { id: "fx-9", name: "Noise", icon: "📺" },
];

interface AdjustmentSliderProps {
  label: string;
  value: number; // display units (-100..100, or 0..100 when min is 0)
  onChange: (value: number) => void;
  disabled: boolean;
  min?: number;
}

const AdjustmentSlider: React.FC<AdjustmentSliderProps> = ({ label, value, onChange, disabled, min = -100 }) => (
  <div className="flex flex-col gap-1">
    <div className="flex items-center justify-between">
      <span className="text-xs text-text-primary">{label}</span>
      <span className="text-xs text-text-muted">{value > 0 && min < 0 ? `+${value}` : value}</span>
    </div>
    <input type="range" min={min} max={100} step={1} value={value} disabled={disabled} onChange={(e) => onChange(parseInt(e.target.value, 10))} className="w-full disabled:opacity-40" />
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

  const sharpnessDisplay = Math.round(((selectedClip as any)?.sharpness ?? 0) * 100);
  const setSharpness = (v: number) => selectedClip && updateClip(selectedClip.id, { sharpness: v / 100 } as any);

  const resetAll = () => selectedClip && updateClip(selectedClip.id, NO_ADJUSTMENTS as any);

  const hasAdjustments = selectedClip ? hasAnyAdjustment(selectedClip as any) : false;

  // "Mejora HD": one click for the clip(s) selected, or for every video/image on the timeline.
  const mediaAssets = useProjectStore((s) => s.mediaAssets);
  const withBatch = useTimelineStore((s) => s.withBatch);
  const isVisualClip = (c: { mediaId: string }) => {
    const type = mediaAssets.find((a) => a.id === c.mediaId)?.type;
    return type === "video" || type === "image";
  };
  const selectedVisualClips = clips.filter((c) => selectedClipIds.includes(c.id) && isVisualClip(c));
  const allVideoClips = clips.filter((c) => mediaAssets.find((a) => a.id === c.mediaId)?.type === "video");
  const applyMejoraHD = (targets: typeof clips) => withBatch(() => targets.forEach((c) => updateClip(c.id, { ...MEJORA_HD } as any)));
  const mejoraActive = selectedClip ? matchesPreset(selectedClip as any, MEJORA_HD) : false;

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin p-3 flex flex-col gap-4">
      {!selectedClip && <p className="text-xs text-text-muted">Selecciona un clip en el timeline para ajustar brillo, contraste y saturacion.</p>}

      <div className="flex flex-col gap-2 p-3 rounded-lg bg-surface-raised">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-text-primary">Mejora HD</p>
          {mejoraActive && <span className="text-[10px] text-accent">activa</span>}
        </div>
        <p className="text-[11px] leading-snug text-text-muted">Mas color, un poco de contraste y nitidez para que el video se vea con mas resolucion. Despues puedes afinar cada ajuste abajo.</p>
        <div className="flex flex-col gap-1.5">
          <button onClick={() => applyMejoraHD(selectedVisualClips)} disabled={selectedVisualClips.length === 0} className="rounded-md bg-accent px-2 py-1.5 text-xs font-semibold text-white hover:bg-accent/80 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed">
            Aplicar a {selectedVisualClips.length > 1 ? `los ${selectedVisualClips.length} clips seleccionados` : "este clip"}
          </button>
          <button onClick={() => applyMejoraHD(allVideoClips)} disabled={allVideoClips.length === 0} className="rounded-md border border-border px-2 py-1.5 text-xs text-text-primary hover:bg-surface cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
            Aplicar a todos los videos ({allVideoClips.length})
          </button>
        </div>
      </div>

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
        <AdjustmentSlider label="Nitidez" value={sharpnessDisplay} onChange={setSharpness} disabled={!selectedClip} min={0} />
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
