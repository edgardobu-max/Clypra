import React, { useEffect, useState } from "react";
import type { Clip } from "@/types";
import { MAX_CLIP_SPEED, MIN_CLIP_SPEED, clipSpeed, clampSpeed } from "@/lib/clipSpeed";

interface SpeedSectionProps {
  selectedClip: Clip;
  /** Applies a new speed (also moves the clips that follow, one undo step). */
  onSpeedChange: (speed: number) => void;
}

const PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

const formatSpeed = (speed: number) => `${Math.round(speed * 100) / 100}x`;
const formatSeconds = (seconds: number) => `${seconds.toFixed(1)} s`;

/** Speed of a video/audio clip: shorter or longer on the timeline, voice pitch unchanged. */
export const SpeedSection: React.FC<SpeedSectionProps> = ({ selectedClip, onSpeedChange }) => {
  const speed = clipSpeed(selectedClip);
  const sourceSeconds = selectedClip.trimOut - selectedClip.trimIn;
  const [targetText, setTargetText] = useState("");

  // The typed target belongs to the clip it was typed for.
  useEffect(() => setTargetText(""), [selectedClip.id]);

  const target = Number(targetText.replace(",", "."));
  const targetSpeed = Number.isFinite(target) && target > 0 ? sourceSeconds / target : null;
  const targetOutOfRange = targetSpeed !== null && (targetSpeed < MIN_CLIP_SPEED || targetSpeed > MAX_CLIP_SPEED);

  const applyTarget = () => {
    if (targetSpeed === null) return;
    onSpeedChange(clampSpeed(targetSpeed));
    setTargetText("");
  };

  return (
    <div className="border-t border-border/40 pt-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold text-text-primary">Velocidad</h4>
        {speed !== 1 && (
          <button type="button" onClick={() => onSpeedChange(1)} className="text-[11px] text-accent hover:underline cursor-pointer">
            Restablecer
          </button>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={Math.log2(MIN_CLIP_SPEED)}
            max={Math.log2(MAX_CLIP_SPEED)}
            step={0.01}
            value={Math.log2(speed)}
            onChange={(e) => onSpeedChange(Math.round(2 ** Number(e.target.value) * 100) / 100)}
            className="grow accent-accent"
            aria-label="Velocidad"
          />
          <span className="text-xs text-text-primary w-12 text-right">{formatSpeed(speed)}</span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => onSpeedChange(preset)}
              className={`rounded border px-2 py-1 text-[11px] cursor-pointer transition-colors ${
                Math.abs(speed - preset) < 0.005 ? "border-accent bg-accent/15 text-accent" : "border-border bg-surface-raised text-text-primary hover:bg-white/6"
              }`}
            >
              {formatSpeed(preset)}
            </button>
          ))}
        </div>

        <p className="text-[11px] text-text-muted">
          Dura {formatSeconds(selectedClip.duration)} en la linea de tiempo ({formatSeconds(sourceSeconds)} del original). El tono de la voz no cambia.
        </p>

        <div>
          <label className="text-xs text-text-muted block mb-1">Ajustar a una duracion (segundos)</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              inputMode="decimal"
              placeholder="ej. 58"
              value={targetText}
              onChange={(e) => setTargetText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !targetOutOfRange && applyTarget()}
              className="w-full bg-surface-raised border border-border rounded px-2 py-1 text-xs text-text-primary outline-none"
            />
            <button
              type="button"
              onClick={applyTarget}
              disabled={targetSpeed === null || targetOutOfRange}
              className="shrink-0 rounded bg-accent px-3 py-1 text-xs font-semibold text-white hover:bg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              Ajustar
            </button>
          </div>
          {targetSpeed !== null && (
            <p className={`mt-1 text-[11px] ${targetOutOfRange ? "text-red-400" : "text-text-muted"}`}>
              {targetOutOfRange ? `Necesitaria ${formatSpeed(targetSpeed)}; el limite es de ${formatSpeed(MIN_CLIP_SPEED)} a ${formatSpeed(MAX_CLIP_SPEED)}.` : `Quedaria a ${formatSpeed(targetSpeed)}.`}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
