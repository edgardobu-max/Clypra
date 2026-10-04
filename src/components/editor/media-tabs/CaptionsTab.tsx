import React, { useRef, useState } from "react";
import { Wand2, Sparkles, Loader2, Plus, Download, Upload, Trash2, Play, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useTimelineStore, getInsertIndexForNewTrack } from "@/store/timelineStore";
import { useUIStore } from "@/store/uiStore";
import { useProjectStore } from "@/store/projectStore";
import { useTransportControls } from "@/hooks/usePlaybackClock";
import { createTextClip } from "@/lib/textClip";
import { parseSubtitles, serializeSubtitles, formatSubtitleTime } from "@/features/subtitles/parser";
import { runAutoCaptions, type AutoCaptionStage } from "@/features/subtitles/autoCaptions";
import { ENGINES, type EngineId } from "@/features/subtitles/providers";
import { ApiKeysPanel } from "./ApiKeysPanel";
import type { TabProps } from "./types";
import type { TextClip } from "@/types";

export const CaptionsTab: React.FC<TabProps> = ({ onAddToTimeline }) => {
  const { clips, tracks, addClip, removeClip, updateClip, withBatch } = useTimelineStore();
  const { project } = useProjectStore();
  const { seek } = useTransportControls();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [autoLanguage, setAutoLanguage] = useState("es");
  const [autoStage, setAutoStage] = useState<AutoCaptionStage | null>(null);
  const [autoEngine, setAutoEngine] = useState<EngineId>("local-whisper");
  const [autoScript, setAutoScript] = useState("");
  const [autoNotice, setAutoNotice] = useState<string | null>(null);

  const handleAutoCaptions = async () => {
    setErrorMsg(null);
    setAutoNotice(null);
    setAutoStage("extracting");
    try {
      const result = await runAutoCaptions({ language: autoLanguage, engine: autoEngine, script: autoScript, onStage: setAutoStage });
      if (result.count === 0) setErrorMsg("No speech was detected in the selected clip(s).");
      else if (result.aligned) {
        const pct = Math.round((result.matchedRatio ?? 0) * 100);
        setAutoNotice(pct >= 85 ? `${result.count} captions created from your script (${pct}% of its words matched the audio).` : `${result.count} captions created, but only ${pct}% of the script matched the audio - check the captions where the voice deviates from the script.`);
      } else setAutoNotice(`${result.count} captions created.`);
    } catch (err: any) {
      setErrorMsg(`Auto captions failed: ${err?.message || err}`);
    } finally {
      setAutoStage(null);
    }
  };

  // Find the text track designated for captions
  const captionTrack = tracks.find(
    (t) => t.type === "text" && (t.name.toLowerCase().includes("caption") || t.name.toLowerCase().includes("subtitle"))
  ) || tracks.find((t) => t.type === "text");

  // Get all text clips belonging to the caption track
  const captionClips = captionTrack
    ? (clips.filter((c) => c.trackId === captionTrack.id) as TextClip[]).sort(
        (a, b) => a.startTime - b.startTime
      )
    : [];

  // Ensure a caption track exists and return its ID
  const ensureCaptionTrackId = (): string => {
    if (captionTrack) return captionTrack.id;

    const timeline = useTimelineStore.getState();
    const insertIndex = getInsertIndexForNewTrack(timeline.tracks, "text");
    const targetTrackId = timeline.insertTrackAt("text", insertIndex);

    // Rename to standard Auto Captions track name
    useTimelineStore.setState((state) => ({
      tracks: state.tracks.map((t) =>
        t.id === targetTrackId ? { ...t, name: "Auto Captions" } : t
      ),
    }));

    return targetTrackId;
  };

  // Trigger file import
  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  // Handle subtitle file selection
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setErrorMsg(null);
    try {
      const text = await file.text();
      const blocks = parseSubtitles(text);

      if (blocks.length === 0) {
        throw new Error("No subtitle blocks found. Please ensure the file is valid SRT or WebVTT.");
      }

      const trackId = ensureCaptionTrackId();
      const canvasWidth = project?.canvasWidth || 1920;
      const canvasHeight = project?.canvasHeight || 1080;

      withBatch(() => {
        blocks.forEach((block) => {
          const textClip = createTextClip({
            trackId,
            startTime: block.startTime,
            duration: Math.max(0.2, block.endTime - block.startTime),
            text: block.text,
            canvasWidth,
            canvasHeight,
            fontSize: 32,
            bold: true,
            position: "bottom",
            styleId: "neon-crimson",
            fontFamily: "Outfit Variable",
          });
          addClip(textClip);
        });
      });
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to parse subtitle file.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // Export captions as SRT or VTT
  const handleExport = (format: "srt" | "vtt") => {
    if (captionClips.length === 0) return;

    const subtitleBlocks = captionClips.map((clip) => ({
      id: clip.id,
      startTime: clip.startTime,
      endTime: clip.startTime + clip.duration,
      text: clip.text,
    }));

    const content = serializeSubtitles(subtitleBlocks, format);
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `captions.${format}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Add a manual caption at the current playhead time
  const handleAddManualCaption = () => {
    const trackId = ensureCaptionTrackId();
    const timeline = useTimelineStore.getState();
    const playheadTime = timeline.clips.length > 0 ? (window as any)._lastPlayheadTime || 0 : 0;

    const canvasWidth = project?.canvasWidth || 1920;
    const canvasHeight = project?.canvasHeight || 1080;

    const textClip = createTextClip({
      trackId,
      startTime: playheadTime,
      duration: 2.0,
      text: "New Caption Text",
      canvasWidth,
      canvasHeight,
      fontSize: 32,
      bold: true,
      position: "bottom",
      styleId: "neon-crimson",
      fontFamily: "Outfit Variable",
    });

    addClip(textClip);
  };

  // Direct update helpers
  const handleTextChange = (clipId: string, text: string) => {
    updateClip(clipId, { text } as any);
  };

  const handleTimingChange = (clipId: string, field: "startTime" | "duration", value: number) => {
    if (value < 0) return;
    updateClip(clipId, { [field]: value });
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-background overflow-hidden p-3 space-y-3">
      {/* Hidden file input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept=".srt,.vtt"
        className="hidden"
      />

      {/* Primary Actions Grid */}
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="secondary"
          size="sm"
          className="w-full flex items-center justify-center gap-1.5"
          onClick={handleImportClick}
        >
          <Upload className="w-3.5 h-3.5 text-accent" />
          Import Subtitles
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="w-full flex items-center justify-center gap-1.5"
          onClick={() => handleExport("srt")}
          disabled={captionClips.length === 0}
        >
          <Download className="w-3.5 h-3.5 text-accent" />
          Export SRT
        </Button>
      </div>

      <div className="space-y-2 rounded-lg border border-border/50 bg-surface-raised/40 p-2.5">
        <div className="flex items-center gap-2">
          <select value={autoLanguage} onChange={(e) => setAutoLanguage(e.target.value)} disabled={autoStage !== null} className="bg-surface-raised border border-border rounded-md px-2 py-1.5 text-xs text-text-primary outline-none" aria-label="Caption language">
            <option value="es">Español</option>
            <option value="en">English</option>
            <option value="auto">Auto</option>
          </select>
          <select value={autoEngine} onChange={(e) => setAutoEngine(e.target.value as EngineId)} disabled={autoStage !== null} className="min-w-0 flex-1 bg-surface-raised border border-border rounded-md px-2 py-1.5 text-xs text-text-primary outline-none" aria-label="Recognition engine">
            {ENGINES.map((en) => (
              <option key={en.id} value={en.id}>
                {en.label}
                {en.implemented ? "" : " (coming soon)"}
              </option>
            ))}
          </select>
        </div>
        <textarea value={autoScript} onChange={(e) => setAutoScript(e.target.value)} disabled={autoStage !== null} rows={4} placeholder="Optional: paste the voice-over script here. Captions will use its exact words (names, accents, punctuation) with the timing of the audio." className="w-full resize-y rounded-md border border-border bg-surface-raised px-2 py-1.5 text-xs text-text-primary outline-none" aria-label="Voice-over script" />
        <Button variant="default" size="sm" className="w-full bg-accent hover:bg-accent/80 text-white flex items-center justify-center gap-1.5" onClick={handleAutoCaptions} disabled={autoStage !== null}>
          {autoStage ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {autoStage === "extracting" ? "Extracting audio…" : autoStage === "transcribing" ? "Transcribing…" : autoStage === "placing" ? "Adding captions…" : autoScript.trim() ? "Auto Captions from script" : "Auto Captions"}
        </Button>
        {autoNotice && <p className="text-[10px] leading-snug text-green-400">{autoNotice}</p>}
        <p className="text-[10px] leading-snug text-text-muted">Transcribes every unmuted audio/video track: mute the video's own audio so only the voice-over is captioned (or select just that clip). Runs locally; the first run downloads the speech model.</p>
      </div>

      <ApiKeysPanel />

      <Button variant="secondary" size="sm" className="w-full" disabled={captionClips.length === 0} onClick={() => useUIStore.setState({ selectedClipIds: captionClips.map((c) => c.id) })}>
        Select all captions ({captionClips.length}) to restyle or move them together
      </Button>

      <div className="flex gap-2">
        <Button
          variant="default"
          size="sm"
          className="flex-1 bg-accent hover:bg-accent/80 text-white flex items-center justify-center gap-1.5"
          onClick={handleAddManualCaption}
        >
          <Plus className="w-4 h-4" />
          Add Manual Caption
        </Button>
      </div>

      {errorMsg && (
        <div className="p-2.5 bg-destructive/10 border border-destructive/20 text-destructive rounded-lg flex items-start gap-2 text-xs">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Subtitles timing editor */}
      <div className="flex-1 flex flex-col min-h-0 pt-2 border-t border-border">
        <div className="flex justify-between items-center mb-2">
          <h4 className="text-xs font-semibold text-text-muted">
            Caption Timing Editor ({captionClips.length})
          </h4>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin space-y-2 pr-1">
          {captionClips.length === 0 ? (
            <div className="h-40 flex flex-col items-center justify-center text-center p-4 border border-dashed border-border rounded-xl">
              <p className="text-xs text-text-muted max-w-[200px]">
                No captions on the timeline. Click Add Manual or Import to begin.
              </p>
            </div>
          ) : (
            captionClips.map((clip, index) => (
              <div
                key={clip.id}
                className="group flex flex-col p-3 bg-surface-raised hover:bg-surface-raised/80 border border-border/40 rounded-xl transition-all space-y-2 relative"
              >
                {/* Header timing controls */}
                <div className="flex items-center justify-between text-[10px] text-text-muted">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                      #{index + 1}
                    </span>
                    <button
                      onClick={() => seek(clip.startTime)}
                      className="flex items-center gap-1 hover:text-accent font-medium transition-colors"
                      title="Jump Playhead to Start"
                    >
                      <Play className="w-2.5 h-2.5 fill-current" />
                      {formatSubtitleTime(clip.startTime, "vtt").slice(3)}
                    </button>
                    <span>➔</span>
                    <span>{formatSubtitleTime(clip.startTime + clip.duration, "vtt").slice(3)}</span>
                  </div>

                  <button
                    onClick={() => removeClip(clip.id)}
                    className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-destructive transition-all duration-200"
                    title="Delete Caption"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Subtitle textarea */}
                <textarea
                  value={clip.text}
                  onChange={(e) => handleTextChange(clip.id, e.target.value)}
                  className="w-full min-h-[50px] p-2 bg-background/50 focus:bg-background border border-border/50 focus:border-accent rounded-lg text-xs text-text-primary resize-none outline-none transition-colors"
                  placeholder="Enter subtitle text..."
                />

                {/* Micro Timing controls */}
                <div className="grid grid-cols-2 gap-2 text-[10px]">
                  <div className="flex items-center gap-1.5">
                    <span className="shrink-0 text-text-muted">Start:</span>
                    <input
                      type="number"
                      step="0.1"
                      value={Number(clip.startTime.toFixed(2))}
                      onChange={(e) =>
                        handleTimingChange(clip.id, "startTime", parseFloat(e.target.value) || 0)
                      }
                      className="w-full px-1.5 py-1 bg-background/30 border border-border/30 rounded text-center outline-none focus:border-accent text-text-primary"
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="shrink-0 text-text-muted">Duration:</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0.1"
                      value={Number(clip.duration.toFixed(2))}
                      onChange={(e) =>
                        handleTimingChange(clip.id, "duration", parseFloat(e.target.value) || 0.1)
                      }
                      className="w-full px-1.5 py-1 bg-background/30 border border-border/30 rounded text-center outline-none focus:border-accent text-text-primary"
                    />
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
