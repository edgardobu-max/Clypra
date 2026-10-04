import React from "react";
import { TopBar } from "./TopBar";
import { EnhancedMediaPanel } from "./media-panel/EnhancedMediaPanel";
import { PreviewPanel } from "./preview/PreviewPanel";
import { PropertiesPanel } from "./PropertiesPanel";
import { Timeline } from "./timeline/Timeline";
import { getInsertIndexForNewTrack, useTimelineStore } from "@/store/timelineStore";
import { useProjectStore } from "@/store/projectStore";
import { createClipFromAsset } from "@/lib/timelineClip";
import { createTextClip, TEXT_PRESETS } from "@/lib/textClip";
import { autoAdaptSequenceForFirstVisualClip } from "@/lib/sequenceAutoAspect";
import { DEFAULT_PLACEMENT_POLICY, resolveAddToTimelinePlacement, resolveDefaultFitModeForAsset } from "@/lib/placementPolicy";
import { getPlaybackClock } from "@/hooks/usePlaybackClock";
import { useWindowSize } from "@/hooks/useWindowSize";
import { MobileEditorLayout } from "./MobileEditorLayout";
import { ResizeHandle, usePersistentSize } from "@/components/ui/ResizeHandle";

export const EditorLayout: React.FC = () => {
  const [leftWidth, setLeftWidth] = usePersistentSize("clypra.layout.leftWidth", 368, 280, 720);
  const [rightWidth, setRightWidth] = usePersistentSize("clypra.layout.rightWidth", 368, 260, 640);
  const [timelineHeight, setTimelineHeight] = usePersistentSize("clypra.layout.timelineHeight", 320, 160, 640);
  const { width } = useWindowSize();

  if (width < 768) {
    return <MobileEditorLayout />;
  }

  const { tracks, clips, addClip, addTrack, insertTrackAt, getTimelineEndTime } = useTimelineStore();
  const { mediaAssets, project, updateProject } = useProjectStore();

  const handleAddToTimeline = (item: any, type: string) => {
    // Handle different item types
    if (type === "media") {
      const mediaAsset = mediaAssets.find((asset) => asset.id === item.id);
      if (!mediaAsset) return;

      const placement = resolveAddToTimelinePlacement({
        asset: mediaAsset,
        tracks,
        clips,
        playheadTime: getPlaybackClock().time,
        sequenceEndTime: getTimelineEndTime(),
      });
      let targetTrackId = placement.targetTrackId;
      if (placement.shouldCreateTrack || !targetTrackId) {
        const latestTracks = useTimelineStore.getState().tracks;
        const insertIndex = getInsertIndexForNewTrack(latestTracks, placement.trackType);
        targetTrackId = insertTrackAt(placement.trackType, insertIndex);
      }

      if (!targetTrackId) return;

      if (DEFAULT_PLACEMENT_POLICY.autoAdaptSequenceForFirstVisualClip) {
        autoAdaptSequenceForFirstVisualClip({
          project,
          existingClips: clips,
          asset: mediaAsset,
          updateProject,
        });
      }

      const nextProject = useProjectStore.getState().project;

      const newClip = createClipFromAsset({
        asset: mediaAsset,
        trackId: targetTrackId,
        startTime: placement.startTime,
        width: nextProject?.canvasWidth || project?.canvasWidth || 1920,
        height: nextProject?.canvasHeight || project?.canvasHeight || 1080,
        fitMode: resolveDefaultFitModeForAsset(mediaAsset),
      });

      addClip(newClip);
    } else if (type === "text") {
      // Text clips follow the same placement policy semantics:
      // playhead-first, no overwrite, create track when occupied.
      const sequenceEndTime = getTimelineEndTime();
      const playheadTime = getPlaybackClock().time;
      const startTime = Math.max(0, Math.min(playheadTime, Math.max(0, sequenceEndTime)));
      const firstUnlockedTextTrack = tracks.find((track) => track.type === "text" && !track.locked);
      let targetTrackId: string | null = firstUnlockedTextTrack?.id ?? null;

      if (targetTrackId) {
        const targetTrackClips = clips.filter((clip) => clip.trackId === targetTrackId);
        const occupiedAtPlayhead = targetTrackClips.some((clip) => clip.startTime <= startTime && startTime < clip.startTime + clip.duration);
        if (occupiedAtPlayhead) {
          targetTrackId = null;
        }
      }

      if (!targetTrackId) {
        const latestTracks = useTimelineStore.getState().tracks;
        const insertIndex = getInsertIndexForNewTrack(latestTracks, "text");
        targetTrackId = insertTrackAt("text", insertIndex);
      }

      if (!targetTrackId) return;

      // Determine preset settings
      let presetConfig = {};
      if (item.id && item.id.startsWith("text-")) {
        const presetName = item.name?.toLowerCase().replace(/\s+/g, "") as keyof typeof TEXT_PRESETS;
        if (TEXT_PRESETS[presetName]) {
          presetConfig = TEXT_PRESETS[presetName];
        }
      }

      // Create text clip
      const textClip = createTextClip({
        trackId: targetTrackId,
        startTime,
        duration: 5.0,
        text: item.text || item.name || "Text", // Use effect's default text first, then name as fallback
        canvasWidth: project?.canvasWidth || 1920,
        canvasHeight: project?.canvasHeight || 1080,
        ...presetConfig,
        // Map styling properties from custom text tab effects or templates
        fontFamily: item.fontFamily,
        color: item.color,
        fontSize: item.fontSize,
        fontWeight: item.fontWeight,
        fontStyle: item.fontStyle,
        stroke: item.stroke,
        shadow: item.shadow,
        background: item.background,
        styleId: item.styleId,
        templateId: item.templateId,
      });

      addClip(textClip);
    } else {
      // Handle other types (audio, stickers, effects, transitions, captions)
      // TODO: Implement handlers for other types
    }
  };

  return (
    <div className="w-full h-full flex flex-col app-shell overflow-hidden p-1 pt-0">
      <TopBar />

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden gap-1">
        <div className="flex-1 min-h-0 flex overflow-hidden">
          <div className="min-h-0 flex shrink-0" style={{ width: leftWidth }}>
            <EnhancedMediaPanel onAddToTimeline={handleAddToTimeline} />
          </div>
          <ResizeHandle orientation="vertical" size={leftWidth} onResize={setLeftWidth} direction={1} label="Resize media panel" />

          <div className="flex-1 min-w-0 flex flex-col overflow-hidden panel-shell">
            <PreviewPanel />
          </div>

          <ResizeHandle orientation="vertical" size={rightWidth} onResize={setRightWidth} direction={-1} label="Resize properties panel" />
          <div className="min-h-0 flex shrink-0" style={{ width: rightWidth }}>
            <PropertiesPanel />
          </div>
        </div>

        <ResizeHandle orientation="horizontal" size={timelineHeight} onResize={setTimelineHeight} direction={-1} label="Resize timeline" />
        <div className="panel-shell overflow-hidden shrink-0" style={{ height: timelineHeight }}>
          <Timeline />
        </div>
      </div>
    </div>
  );
};
