import React, { useState } from "react";
import { Mic } from "lucide-react";
import type { Clip } from "@/types";
import { useProjectStore } from "@/store/projectStore";
import { VOICE_LEVELS, enhanceClipAudio, revertClipAudio, type VoiceLevel } from "@/lib/enhanceVoice";

interface VoiceEnhanceSectionProps {
  selectedClip: Clip;
}

/** One-click voice cleanup (noise, level, clarity) that keeps the tone of the voice. */
export const VoiceEnhanceSection: React.FC<VoiceEnhanceSectionProps> = ({ selectedClip }) => {
  const asset = useProjectStore((s) => s.mediaAssets.find((a) => a.id === selectedClip.mediaId));
  const [level, setLevel] = useState<VoiceLevel>("normal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!asset || (asset.type !== "audio" && asset.type !== "video")) return null;
  const isEnhanced = !!asset.enhancedFromId;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await enhanceClipAudio(selectedClip, level);
    } catch (e) {
      setError(typeof e === "string" ? e : e instanceof Error ? e.message : "No se pudo mejorar el audio.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-border/40 pt-4" data-testid="voice-enhance-section">
      <div className="mb-2 flex items-center gap-2">
        <Mic className="w-3.5 h-3.5 text-accent" />
        <h4 className="text-sm font-semibold text-text-primary">Mejorar voz</h4>
        {isEnhanced && <span className="text-[10px] text-accent">aplicada</span>}
      </div>
      <p className="mb-3 text-[11px] leading-snug text-text-muted">Quita ruido de fondo, parejiza el volumen y da claridad a la voz. No cambia el tono. Las respiraciones se dejan, para que las cortes tu.</p>

      <div className="flex gap-1.5 mb-3" role="radiogroup" aria-label="Intensidad">
        {VOICE_LEVELS.map((l) => (
          <button
            key={l.id}
            type="button"
            role="radio"
            aria-checked={level === l.id}
            title={l.hint}
            disabled={busy}
            onClick={() => setLevel(l.id)}
            className={`flex-1 rounded border px-2 py-1 text-[11px] cursor-pointer transition-colors disabled:opacity-50 ${level === l.id ? "border-accent bg-accent/15 text-accent" : "border-border bg-surface-raised text-text-primary hover:bg-white/6"}`}
          >
            {l.label}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <button type="button" onClick={run} disabled={busy} className="grow rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent/80 disabled:opacity-60 disabled:cursor-wait cursor-pointer">
          {busy ? "Procesando..." : isEnhanced ? "Volver a mejorar" : "Mejorar audio"}
        </button>
        {isEnhanced && (
          <button type="button" onClick={() => revertClipAudio(selectedClip)} disabled={busy} className="rounded border border-border px-3 py-1.5 text-xs text-text-primary hover:bg-white/6 disabled:opacity-50 cursor-pointer">
            Original
          </button>
        )}
      </div>

      {busy && <p className="mt-2 text-[11px] text-text-muted">Analizando y limpiando el audio. Puede tardar unos segundos segun la duracion.</p>}
      {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
      {isEnhanced && !busy && !error && <p className="mt-2 text-[11px] text-text-muted">Se guardo una copia junto al original (termina en _mejorado). El original no se toca.</p>}
    </div>
  );
};
