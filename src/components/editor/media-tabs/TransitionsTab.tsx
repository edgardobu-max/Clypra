import React, { useMemo, useState } from "react";
import { Shuffle, Waves } from "lucide-react";
import type { TabProps } from "./types";
import { useUIStore } from "@/store/uiStore";
import { useTimelineStore } from "@/store/timelineStore";

const REAL_TRANSITIONS: { id: "fade" | "dissolve"; name: string; description: string; Icon: React.FC<{ size?: number; className?: string }> }[] = [
  { id: "fade", name: "Fade", description: "Funde a negro y aparece", Icon: Waves },
  { id: "dissolve", name: "Dissolve", description: "Cruce directo entre clips", Icon: Shuffle },
];

// Not implemented yet — shown for context on what's coming, not clickable.
const PLANNED_TRANSITIONS = ["Wipe", "Slide", "Zoom", "Spin", "Push", "Blur"];

const MIN_DURATION = 0.1;
const MAX_DURATION = 2.0;
const DEFAULT_DURATION = 0.5;

export const TransitionsTab: React.FC<TabProps> = () => {
  const selectedClipIds = useUIStore((s) => s.selectedClipIds);
  const clips = useTimelineStore((s) => s.clips);
  const updateClip = useTimelineStore((s) => s.updateClip);

  const selectedClip = useMemo(() => clips.find((c) => c.id === selectedClipIds[0]), [clips, selectedClipIds]);

  const activeType = (selectedClip as any)?.transitionInType as "fade" | "dissolve" | undefined;
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const activeDuration = ((selectedClip as any)?.transitionInDuration as number | undefined) ?? duration;

  // A transition only has something to blend with if there's another clip on
  // the same track immediately before this one (no gap) — matches how
  // computeTransitionPairs in the evaluator detects back-to-back cuts.
  const hasPreviousClip = useMemo(() => {
    if (!selectedClip) return false;
    const EPS = 1e-3;
    return clips.some((c) => c.trackId === selectedClip.trackId && c.id !== selectedClip.id && Math.abs(c.startTime + c.duration - selectedClip.startTime) < EPS);
  }, [clips, selectedClip]);

  const applyTransition = (type: "fade" | "dissolve" | undefined) => {
    if (!selectedClip) return;
    updateClip(selectedClip.id, { transitionInType: type, transitionInDuration: type ? activeDuration : undefined } as any);
  };

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin p-3 flex flex-col gap-3">
      {!selectedClip && <p className="text-xs text-text-muted">Selecciona el segundo clip de un corte (sin espacio entre clips) para aplicarle una transicion de entrada.</p>}

      {selectedClip && !hasPreviousClip && <p className="text-xs text-text-muted">Este clip no tiene otro clip pegado justo antes en su pista, asi que una transicion no tendria con que mezclarse.</p>}

      <div className="grid grid-cols-2 gap-2">
        {REAL_TRANSITIONS.map(({ id, name, description, Icon }) => (
          <button
            key={id}
            onClick={() => applyTransition(activeType === id ? undefined : id)}
            disabled={!selectedClip || !hasPreviousClip}
            className={`p-4 bg-surface-raised hover:bg-surface-raised/80 rounded-lg transition-colors group text-left cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed border ${activeType === id ? "border-accent" : "border-transparent"}`}
          >
            <div className="aspect-video bg-surface mb-2 rounded flex items-center justify-center">
              <Icon className="w-6 h-6 text-text-muted" />
            </div>
            <p className="text-sm font-medium text-text-primary">{name}</p>
            <p className="text-xs text-text-muted mt-1">{description}</p>
          </button>
        ))}
      </div>

      {selectedClip && hasPreviousClip && activeType && (
        <div className="flex flex-col gap-1 p-2 rounded-lg bg-surface-raised">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-primary">Duracion</span>
            <span className="text-xs text-text-muted">{activeDuration.toFixed(2)}s</span>
          </div>
          <input
            type="range"
            min={MIN_DURATION}
            max={MAX_DURATION}
            step={0.05}
            value={activeDuration}
            onChange={(e) => {
              const next = parseFloat(e.target.value);
              setDuration(next);
              updateClip(selectedClip.id, { transitionInDuration: next } as any);
            }}
            className="w-full"
          />
        </div>
      )}

      <div className="pt-2 border-t border-border">
        <p className="text-xs text-text-muted mb-2">Proximamente</p>
        <div className="grid grid-cols-2 gap-2">
          {PLANNED_TRANSITIONS.map((name) => (
            <div key={name} className="p-4 bg-surface-raised/40 rounded-lg text-left opacity-50 cursor-not-allowed">
              <div className="aspect-video bg-surface mb-2 rounded flex items-center justify-center">
                <Shuffle className="w-6 h-6 text-text-muted" />
              </div>
              <p className="text-sm font-medium text-text-primary">{name}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
