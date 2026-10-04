import { invoke } from "@tauri-apps/api/core";
import { useTimelineStore, getInsertIndexForNewTrack } from "@/store/timelineStore";
import { useProjectStore } from "@/store/projectStore";
import { useUIStore } from "@/store/uiStore";
import { createTextClip } from "@/lib/textClip";
import { ENGINES, type EngineId } from "./providers";

export type AutoCaptionStage = "extracting" | "transcribing" | "placing";

export interface AutoCaptionResult {
  count: number;
  /** True when the caption text came from a pasted script. */
  aligned: boolean;
  /** Share (0–1) of script words found in the recognised speech; low values mean the audio drifts from the script. */
  matchedRatio: number | null;
}

export interface AutoCaptionOptions {
  /** ISO language code ("es", "en"…) or "auto". */
  language: string;
  /** Recognition engine; only the local Whisper engine is connected so far. */
  engine?: EngineId;
  /** Voice-over script: when given, caption text comes from it and timing from the audio. */
  script?: string;
  onStage?: (stage: AutoCaptionStage) => void;
}

/**
 * Transcribes timeline audio locally (Whisper via `uv`) and places the result as
 * short text clips on a captions track. If clips are selected, only those are
 * transcribed (e.g. just the voice-over, not the background music).
 *
 */
export async function runAutoCaptions({ language, engine = "local-whisper", script, onStage }: AutoCaptionOptions): Promise<AutoCaptionResult> {
  const selectedEngine = ENGINES.find((e) => e.id === engine);
  if (!selectedEngine?.implemented) throw new Error(`${selectedEngine?.label ?? engine} is not connected yet — use Local Whisper for now.`);

  const timeline = useTimelineStore.getState();
  const { project, mediaAssets } = useProjectStore.getState();
  const selectedIds = useUIStore.getState().selectedClipIds;

  // Every audible clip is transcribed: muted/hidden tracks are skipped (mute the
  // video's own audio to caption only the voice-over). A selection narrows it further.
  const trackById = new Map(timeline.tracks.map((t) => [t.id, t]));
  const sources = timeline.clips.filter((clip) => {
    if (selectedIds.length > 0 && !selectedIds.includes(clip.id)) return false;
    const track = trackById.get(clip.trackId);
    if (track?.muted || track?.visible === false) return false;
    const asset = mediaAssets.find((a) => a.id === clip.mediaId);
    return !!asset && (asset.type === "audio" || asset.type === "video");
  });
  if (sources.length === 0) throw new Error("No audible audio or video clips to transcribe. Unmute the voice-over track.");

  let targetTrackId = (timeline.tracks.find((t) => t.type === "text" && t.name.toLowerCase().includes("caption")) ?? timeline.tracks.find((t) => t.type === "text"))?.id ?? null;
  if (!targetTrackId) {
    targetTrackId = timeline.insertTrackAt("text", getInsertIndexForNewTrack(timeline.tracks, "text"));
    useTimelineStore.setState((state) => ({
      tracks: state.tracks.map((t) => (t.id === targetTrackId ? { ...t, name: "Auto Captions" } : t)),
    }));
  }

  let count = 0;
  let aligned = false;
  let matchedRatio: number | null = null;
  for (const mediaClip of sources) {
    const asset = mediaAssets.find((a) => a.id === mediaClip.mediaId);
    if (!asset?.path) continue;

    onStage?.("extracting");
    const tempAudioPath = await invoke<string>("extract_audio_track", { path: asset.path });

    onStage?.("transcribing");
    const result = JSON.parse(await invoke<string>("transcribe_audio_local", { audioPath: tempAudioPath, language, script: script?.trim() || null }));
    if (result.error) throw new Error(result.error);
    aligned = aligned || !!result.aligned;
    matchedRatio = result.matchedRatio ?? matchedRatio;

    onStage?.("placing");
    const segments: { start: number; end: number; text: string }[] = result.segments || [];
    useTimelineStore.getState().withBatch(() => {
      for (const seg of segments) {
        // Whisper times are relative to the source audio; map them onto the timeline
        // through the clip's trim-in and start time.
        const relativeStart = seg.start - (mediaClip.trimIn || 0);
        if (relativeStart < 0 || relativeStart >= mediaClip.duration) continue;

        useTimelineStore.getState().addClip(
          createTextClip({
            trackId: targetTrackId!,
            startTime: mediaClip.startTime + relativeStart,
            duration: Math.min(seg.end - seg.start, mediaClip.duration - relativeStart),
            text: seg.text,
            canvasWidth: project?.canvasWidth || 1920,
            canvasHeight: project?.canvasHeight || 1080,
            fontSize: 32,
            bold: true,
            position: "bottom",
            styleId: "neon-crimson",
            fontFamily: "Outfit Variable",
          }),
        );
        count++;
      }
    });
  }
  return { count, aligned, matchedRatio };
}
