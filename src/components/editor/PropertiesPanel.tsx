import React, { useState } from "react";
import { Settings, Type, Layout } from "lucide-react";
import { useUIStore } from "@/store/uiStore";
import { useTimelineStore } from "@/store/timelineStore";
import { useProjectStore } from "@/store/projectStore";
import { useHistoryStore } from "@/store/historyStore";
import { TransformClipCommand } from "@/core/history/commands/TransformCommand";
import { CompositeCommand } from "@/core/history/Transaction";
import { calculateClipDimensions, type ClipFitModeExtended } from "@/lib/timelineClip";
import type { TextClip } from "@/types";
import { usePresetStore } from "@/store/presetStore";

import { EmptyPropertiesState } from "./properties/EmptyPropertiesState";
import { TextStyleSection } from "./properties/TextStyleSection";
import { TransformSection } from "./properties/TransformSection";
import { AudioSection } from "./properties/AudioSection";
import { SpeedSection } from "./properties/SpeedSection";
import { VoiceEnhanceSection } from "./properties/VoiceEnhanceSection";
import { ReplaceClipsCommand } from "@/core/history/commands/ReplaceClipsCommand";
import { planClipSpeedChange } from "@/lib/clipSpeed";

export const PropertiesPanel: React.FC = () => {
  const { selectedClipIds } = useUIStore();
  const { clips } = useTimelineStore();
  const { mediaAssets, project } = useProjectStore();
  const { execute } = useHistoryStore();

  const [activePropertyTab, setActivePropertyTab] = useState<"text" | "transform">("text");
  const [newPresetName, setNewPresetName] = useState("");
  const { presets, savePreset, deletePreset } = usePresetStore();

  const selectedClipId = selectedClipIds[0] ?? null;
  const selectedClip = clips.find((c) => c.id === selectedClipId);
  const selectedAsset = mediaAssets.find((a) => a.id === selectedClip?.mediaId);
  const isVisualClip = selectedAsset?.type === "video" || selectedAsset?.type === "image";
  const isTextClip = selectedClip && "text" in selectedClip;
  const hasAudio = !isTextClip && (selectedAsset?.type === "audio" || selectedAsset?.type === "video");

  if (!selectedClipId || !selectedClip) {
    return <EmptyPropertiesState />;
  }

  // Cast selected clip to TextClip when it is a text layer
  const textClip = selectedClip as unknown as TextClip;

  // With several clips selected, style/position edits apply to every selected clip
  // of the same kind (e.g. all captions), as one undo step. Per-clip content such
  // as the text itself or timing only ever changes the primary clip.
  const SINGLE_CLIP_FIELDS = new Set(["text", "startTime", "duration", "trackId", "trimIn", "trimOut"]);
  const sameKindTargets = selectedClipIds
    .map((id) => clips.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => !!c && ("text" in c) === !!isTextClip);
  const multiCount = sameKindTargets.length;

  const applyFields = (fields: Record<string, any>) => {
    const sharedOnly = !Object.keys(fields).some((k) => SINGLE_CLIP_FIELDS.has(k));
    const targets = sharedOnly && multiCount > 1 ? sameKindTargets : [selectedClip];
    const commands = targets.map((clip) => {
      const oldFields: Record<string, any> = {};
      for (const key in fields) oldFields[key] = (clip as any)[key];
      return new TransformClipCommand(clip.id, oldFields, fields);
    });
    execute(commands.length === 1 ? commands[0] : new CompositeCommand("Transform Clips", commands));
  };

  const handleUpdate = (key: string, value: any) => applyFields({ [key]: value });

  const handleUpdateMultiple = (fields: Record<string, any>) => applyFields(fields);

  const handleApplyPreset = (preset: any) => {
    handleUpdateMultiple({
      fontFamily: preset.fontFamily,
      fontSize: preset.fontSize,
      fontWeight: preset.fontWeight || "normal",
      fontStyle: preset.fontStyle || "normal",
      color: preset.color,
      align: preset.align || "center",
      valign: preset.valign || "middle",
      lineHeight: preset.lineHeight || 1.2,
      letterSpacing: preset.letterSpacing || 0,
      stroke: preset.stroke,
      shadow: preset.shadow,
      background: preset.background,
      keyframes: preset.keyframes,
    });
  };

  /**
   * Size edits from the numeric fields and the scale slider. The clip keeps its centre; with the
   * aspect lock on (the default) the other side follows, otherwise width and height are free.
   */
  const handleResize = (change: { width?: number; height?: number }) => {
    const locked = isVisualClip && (selectedClip.aspectRatioLocked ?? true);
    const ratio = selectedClip.width / Math.max(1, selectedClip.height);
    let width = change.width ?? selectedClip.width;
    let height = change.height ?? selectedClip.height;
    if (locked && change.width !== undefined) height = width / ratio;
    else if (locked && change.height !== undefined) width = height * ratio;
    width = Math.max(1, width);
    height = Math.max(1, height);
    const cx = selectedClip.x + selectedClip.width / 2;
    const cy = selectedClip.y + selectedClip.height / 2;
    applyFields({ width, height, x: cx - width / 2, y: cy - height / 2 });
  };

  /** Speed change: the clip gets shorter/longer and the clips after it on the track follow (one undo step). */
  const handleSpeedChange = (speed: number) => {
    const plan = planClipSpeedChange(clips, selectedClip.id, speed);
    if (plan) execute(new ReplaceClipsCommand("Change Speed", plan.before, plan.after));
  };

  const handleApplyFit = (fitMode: ClipFitModeExtended) => {
    if (!selectedClip || !selectedAsset || !project || !isVisualClip) return;
    const rect = calculateClipDimensions(selectedAsset, project.canvasWidth, project.canvasHeight, fitMode);
    execute(
      new TransformClipCommand(
        selectedClip.id,
        {
          x: selectedClip.x,
          y: selectedClip.y,
          width: selectedClip.width,
          height: selectedClip.height,
          fitMode: selectedClip.fitMode,
        },
        {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          fitMode,
        },
      ),
    );
  };

  return (
    <div className="w-full min-h-0 panel-shell flex flex-col overflow-hidden shrink-0">
      {multiCount > 1 && (
        <div className="px-3 py-1.5 text-[11px] font-medium text-accent bg-accent/10 border-b border-border">Editing {multiCount} clips — style and position changes apply to all</div>
      )}
      {/* Header Panel Tabs */}
      <div className="panel-head flex items-center justify-between border-b border-border select-none">
        {isTextClip ? (
          <div className="flex w-full">
            <button
              onClick={() => setActivePropertyTab("text")}
              className={`flex-1 py-3 text-xs font-semibold tracking-wide border-b-2 text-center transition-all cursor-pointer ${
                activePropertyTab === "text"
                  ? "text-accent border-accent bg-accent/5"
                  : "text-text-muted border-transparent hover:text-text-primary"
              }`}
            >
              <span className="flex items-center justify-center gap-1.5">
                <Type className="w-3.5 h-3.5" />
                Text Style
              </span>
            </button>
            <button
              onClick={() => setActivePropertyTab("transform")}
              className={`flex-1 py-3 text-xs font-semibold tracking-wide border-b-2 text-center transition-all cursor-pointer ${
                activePropertyTab === "transform"
                  ? "text-accent border-accent bg-accent/5"
                  : "text-text-muted border-transparent hover:text-text-primary"
              }`}
            >
              <span className="flex items-center justify-center gap-1.5">
                <Layout className="w-3.5 h-3.5" />
                Video (Transform)
              </span>
            </button>
          </div>
        ) : (
          <div className="p-4 flex items-center gap-2">
            <Settings className="w-4 h-4 text-accent" />
            <h3 className="font-semibold text-text-primary text-sm">Clip Properties</h3>
          </div>
        )}
      </div>

      {/* Property Contents */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-6">
        {/* Render Text Styling studio if text clip is selected and active tab is text */}
        {isTextClip && activePropertyTab === "text" && (
          <TextStyleSection
            textClip={textClip}
            presets={presets}
            newPresetName={newPresetName}
            setNewPresetName={setNewPresetName}
            handleUpdate={handleUpdate}
            handleUpdateMultiple={handleUpdateMultiple}
            handleApplyPreset={handleApplyPreset}
            savePreset={savePreset}
            deletePreset={deletePreset}
          />
        )}

        {/* Video Transform properties (rendered for non-text or if transform tab is selected) */}
        {(!isTextClip || activePropertyTab === "transform") && (
          <TransformSection
            selectedClip={selectedClip}
            isVisualClip={isVisualClip}
            handleUpdate={handleUpdate}
            handleApplyFit={handleApplyFit}
            handleResize={handleResize}
            canvasWidth={project?.canvasWidth ?? 1080}
          />
        )}

        {/* Speed: video and audio clips (not stills or text) */}
        {!isTextClip && (selectedAsset?.type === "video" || selectedAsset?.type === "audio") && <SpeedSection selectedClip={selectedClip} onSpeedChange={handleSpeedChange} />}

        {/* Volume / fades for audio clips and video clips (embedded audio) */}
        {hasAudio && <AudioSection selectedClip={selectedClip} handleUpdate={handleUpdate} />}
        {hasAudio && <VoiceEnhanceSection selectedClip={selectedClip} />}
      </div>
    </div>
  );
};
