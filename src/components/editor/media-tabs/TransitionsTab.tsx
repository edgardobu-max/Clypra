import React, { useMemo, useState } from "react";
import { Shuffle, Waves, MoveRight, ZoomIn } from "lucide-react";
import type { TabProps } from "./types";
import { useUIStore } from "@/store/uiStore";
import { useTimelineStore } from "@/store/timelineStore";
import { TRANSITION_CUT_TOLERANCE, type TransitionType } from "@/core/evaluation/transitionState";
import type { Clip } from "@/types";

const TRANSITIONS: { id: TransitionType; name: string; description: string; Icon: React.FC<{ size?: number; className?: string }> }[] = [
  { id: "slide", name: "Slide", description: "El clip nuevo empuja al anterior hacia la izquierda", Icon: MoveRight },
  { id: "zoom", name: "Zoom", description: "El clip nuevo entra acercandose suavemente", Icon: ZoomIn },
  { id: "dissolve", name: "Dissolve", description: "Cruce directo entre clips", Icon: Shuffle },
  { id: "fade", name: "Fade", description: "Funde a negro y aparece", Icon: Waves },
];

// Not implemented yet — shown for context on what's coming, not clickable.
const PLANNED_TRANSITIONS = ["Wipe", "Spin", "Blur"];

const MIN_DURATION = 0.1;
const MAX_DURATION = 2.0;
const DEFAULT_DURATION = 0.5;

/**
 * The pair a transition applies to: the selected clip and the clip right before it on
 * the same track (the transition belongs to the second clip). If only the first clip of a
 * cut is selected, the pair is that clip and the one right after it. "Right before/after"
 * tolerates a small gap or overlap, like the evaluator does.
 */
function findCut(clips: Clip[], selected: Clip | undefined): { prev: Clip; next: Clip } | null {
  if (!selected) return null;
  const sameTrack = clips.filter((c) => c.trackId === selected.trackId && c.id !== selected.id);
  const before = sameTrack.find((c) => Math.abs(c.startTime + c.duration - selected.startTime) <= TRANSITION_CUT_TOLERANCE);
  if (before) return { prev: before, next: selected };
  const after = sameTrack.find((c) => Math.abs(selected.startTime + selected.duration - c.startTime) <= TRANSITION_CUT_TOLERANCE);
  if (after) return { prev: selected, next: after };
  return null;
}

export const TransitionsTab: React.FC<TabProps> = () => {
  const selectedClipIds = useUIStore((s) => s.selectedClipIds);
  const clips = useTimelineStore((s) => s.clips);
  const updateClip = useTimelineStore((s) => s.updateClip);

  const selectedClip = useMemo(() => clips.find((c) => c.id === selectedClipIds[0]), [clips, selectedClipIds]);
  const cut = useMemo(() => findCut(clips, selectedClip), [clips, selectedClip]);
  const target = cut?.next;

  const activeType = (target as any)?.transitionInType as TransitionType | undefined;
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const activeDuration = ((target as any)?.transitionInDuration as number | undefined) ?? duration;

  const applyTransition = (type: TransitionType | undefined) => {
    if (!target) return;
    updateClip(target.id, { transitionInType: type, transitionInDuration: type ? activeDuration : undefined } as any);
  };

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin p-3 flex flex-col gap-3">
      {!selectedClip && <p className="text-xs text-text-muted">Selecciona uno de los dos clips que quedan pegados (uno justo despues del otro, en la misma pista) y elige una transicion.</p>}

      {selectedClip && !cut && <p className="text-xs text-text-muted">Este clip no tiene otro clip pegado en su pista, asi que una transicion no tendria con que mezclarse. Acerca los dos clips (separados menos de 0.15 s).</p>}

      {cut && <p className="text-xs text-text-muted">La transicion se aplica en el corte entre los dos clips.</p>}

      <div className="grid grid-cols-2 gap-2">
        {TRANSITIONS.map(({ id, name, description, Icon }) => (
          <button
            key={id}
            onClick={() => applyTransition(activeType === id ? undefined : id)}
            disabled={!cut}
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

      {target && cut && activeType && (
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
              updateClip(target.id, { transitionInDuration: next } as any);
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
