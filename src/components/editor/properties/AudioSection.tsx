import React from "react";
import { Volume2 } from "lucide-react";
import type { Clip } from "@/types";
import { clampVolume, clampFade } from "@/lib/audioGain";

interface AudioSectionProps {
  selectedClip: Clip;
  handleUpdate: (key: string, value: any) => void;
}

const FADE_MAX_SECONDS = 10;

/**
 * Volume and fade controls for audio clips and the embedded audio of video
 * clips. Values live on the clip (volume / audioFadeIn / audioFadeOut) and are
 * used by both the live preview and the export mixer.
 */
export const AudioSection: React.FC<AudioSectionProps> = ({ selectedClip, handleUpdate }) => {
  const volume = clampVolume(selectedClip.volume);
  const fadeIn = clampFade(selectedClip.audioFadeIn, selectedClip.duration);
  const fadeOut = clampFade(selectedClip.audioFadeOut, selectedClip.duration);
  const fadeCap = Math.min(FADE_MAX_SECONDS, selectedClip.duration);

  return (
    <div className="border-t border-border/40 pt-4" data-testid="audio-section">
      <div className="mb-3 flex items-center gap-2">
        <Volume2 className="w-3.5 h-3.5 text-accent" />
        <h4 className="text-sm font-semibold text-text-primary">Audio</h4>
      </div>
      <div className="space-y-3">
        <div>
          <label className="text-xs text-text-muted block mb-1">Volume</label>
          <div className="flex items-center gap-2">
            <input type="range" min="0" max="400" value={Math.round(volume * 100)} onChange={(e) => handleUpdate("volume", Number(e.target.value) / 100)} className="grow accent-accent" aria-label="Clip volume" />
            <span className="text-xs text-text-primary w-12 text-right">{Math.round(volume * 100)}%</span>
            <button onClick={() => handleUpdate("volume", 1)} disabled={Math.abs(volume - 1) < 0.005} className="text-[10px] text-text-muted hover:text-text-primary disabled:opacity-30 cursor-pointer" title="Reset to 100%">
              100%
            </button>
          </div>
          {volume > 1 && <p className="mt-1 text-[10px] leading-snug text-text-muted">Boosted above 100%. A limiter keeps the mix from clipping, but very loud settings can sound distorted.</p>}
        </div>

        <div>
          <label className="text-xs text-text-muted block mb-1">Fade in (seconds)</label>
          <div className="flex items-center gap-2">
            <input type="range" min="0" max={fadeCap} step="0.1" value={fadeIn} onChange={(e) => handleUpdate("audioFadeIn", Number(e.target.value))} className="grow accent-accent" aria-label="Audio fade in" />
            <span className="text-xs text-text-primary w-10 text-right">{fadeIn.toFixed(1)}s</span>
          </div>
        </div>

        <div>
          <label className="text-xs text-text-muted block mb-1">Fade out (seconds)</label>
          <div className="flex items-center gap-2">
            <input type="range" min="0" max={fadeCap} step="0.1" value={fadeOut} onChange={(e) => handleUpdate("audioFadeOut", Number(e.target.value))} className="grow accent-accent" aria-label="Audio fade out" />
            <span className="text-xs text-text-primary w-10 text-right">{fadeOut.toFixed(1)}s</span>
          </div>
        </div>
      </div>
    </div>
  );
};
