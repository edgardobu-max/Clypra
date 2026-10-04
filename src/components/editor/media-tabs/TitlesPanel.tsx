import React, { useState } from "react";
import { Type } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useTimelineStore, getInsertIndexForNewTrack } from "@/store/timelineStore";
import { useProjectStore } from "@/store/projectStore";
import { useUIStore } from "@/store/uiStore";
import { getPlaybackClock } from "@/hooks/usePlaybackClock";
import { BUILT_IN_TITLE_PRESETS, createTitleClip } from "@/lib/titlePresets";
import { DEFAULT_INTRO_DURATION, INTRO_LABELS, type IntroType } from "@/lib/introAnimation";

const TITLE_TRACK_NAME = "Titles";

/**
 * One-click branded titles: pick a look, type the headline, add it. The title lasts
 * 10 seconds, slides in (no outro) and can then be moved/restyled like any text clip.
 */
export const TitlesPanel: React.FC = () => {
  const project = useProjectStore((s) => s.project);
  const [presetId, setPresetId] = useState(BUILT_IN_TITLE_PRESETS[0].id);
  const [text, setText] = useState("");
  const [seconds, setSeconds] = useState(10);
  const [introType, setIntroType] = useState<"preset" | IntroType>("preset");
  const preset = BUILT_IN_TITLE_PRESETS.find((p) => p.id === presetId) ?? BUILT_IN_TITLE_PRESETS[0];

  const addTitle = () => {
    const timeline = useTimelineStore.getState();
    let trackId = timeline.tracks.find((t) => t.type === "text" && t.name === TITLE_TRACK_NAME)?.id ?? null;
    if (!trackId) {
      trackId = timeline.insertTrackAt("text", getInsertIndexForNewTrack(timeline.tracks, "text"));
      useTimelineStore.setState((state) => ({ tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, name: TITLE_TRACK_NAME } : t)) }));
    }

    const clip = createTitleClip({
      trackId,
      startTime: Math.max(0, getPlaybackClock().time),
      duration: seconds,
      text: text.trim() || "Your headline here",
      canvasWidth: project?.canvasWidth || 1080,
      canvasHeight: project?.canvasHeight || 1920,
      preset,
      intro: introType === "preset" ? undefined : { type: introType, duration: DEFAULT_INTRO_DURATION, bounce: introType === "slide-left" || introType === "slide-up" },
    });
    timeline.addClip(clip);
    useUIStore.setState({ selectedClipIds: [clip.id] });
  };

  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="flex items-center gap-2">
        <Type className="w-4 h-4 text-accent" />
        <h4 className="font-bold text-text-primary">Branded title</h4>
      </div>

      <div className="space-y-1">
        <label className="text-[10px] font-semibold uppercase text-text-muted">Look</label>
        <div className="grid gap-1.5">
          {BUILT_IN_TITLE_PRESETS.map((p) => (
            <button key={p.id} onClick={() => setPresetId(p.id)} className={`rounded-lg border p-2 text-left transition-colors cursor-pointer ${p.id === presetId ? "border-accent bg-accent/10" : "border-border/50 bg-surface-raised/30 hover:border-border"}`}>
              <div className="flex items-center gap-2">
                <span className="rounded px-2 py-0.5 text-[10px] font-bold" style={{ background: p.background.opacity > 0 ? p.background.color : "transparent", color: p.color, border: p.background.borderColor ? `2px solid ${p.background.borderColor}` : "1px solid rgba(255,255,255,0.15)", textShadow: p.shadow ? "0 1px 4px #000" : undefined }}>
                  {p.uppercase ? "HEADLINE" : "Headline"}
                </span>
                <span className="font-semibold text-text-primary">{p.name}</span>
              </div>
              <p className="mt-1 text-[10px] leading-snug text-text-muted">{p.description}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-[10px] font-semibold uppercase text-text-muted" htmlFor="title-text">
          Headline
        </label>
        <textarea id="title-text" value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Type the headline of this video…" className="w-full resize-y rounded-md border border-border bg-surface-raised px-2 py-1.5 text-xs text-text-primary outline-none" />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-[10px] font-semibold uppercase text-text-muted" htmlFor="title-intro">
            Entrance
          </label>
          <select id="title-intro" value={introType} onChange={(e) => setIntroType(e.target.value as "preset" | IntroType)} className="w-full rounded-md border border-border bg-surface-raised px-2 py-1.5 text-xs text-text-primary outline-none">
            <option value="preset">Preset default</option>
            {(Object.keys(INTRO_LABELS) as IntroType[]).map((t) => (
              <option key={t} value={t}>
                {INTRO_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-semibold uppercase text-text-muted" htmlFor="title-seconds">
            Duration (s)
          </label>
          <input id="title-seconds" type="number" min={1} max={60} step={1} value={seconds} onChange={(e) => setSeconds(Math.max(1, Math.min(60, Number(e.target.value) || 10)))} className="w-full rounded-md border border-border bg-surface-raised px-2 py-1.5 text-xs text-text-primary outline-none" />
        </div>
      </div>

      <Button variant="default" size="sm" className="w-full bg-accent text-white hover:bg-accent/80" onClick={addTitle} disabled={!project}>
        Add title at playhead
      </Button>
      <p className="text-[10px] leading-snug text-text-muted">Select the title afterwards to move it, change colours or fonts, or edit the text. The entrance can also be changed in Text Style → Entrance animation.</p>
    </div>
  );
};
