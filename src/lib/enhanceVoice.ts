/**
 * "Mejorar voz": cleans a voice recording (noise, level, clarity) without changing its pitch.
 *
 * The Rust command writes a processed COPY next to the original; this module adds that copy to the
 * media bin and moves the timeline clips over to it in one undo step. Because the copy is a normal
 * file, the preview and the export play exactly the same audio.
 */

import { invoke } from "@tauri-apps/api/core";
import type { Clip, MediaAsset } from "@/types";
import { generateId } from "@/lib/id";
import { platform } from "@/core/platform";
import { useProjectStore } from "@/store/projectStore";
import { useTimelineStore } from "@/store/timelineStore";
import { useHistoryStore } from "@/store/historyStore";
import { UpdateClipCommand } from "@/core/history/commands/UpdateClipCommand";
import { CompositeCommand } from "@/core/history/Transaction";
import type { Command } from "@/core/history/Command";

export type VoiceLevel = "soft" | "normal" | "strong";

export const VOICE_LEVELS: Array<{ id: VoiceLevel; label: string; hint: string }> = [
  { id: "soft", label: "Suave", hint: "Limpia poco; ideal si la grabacion ya es buena." },
  { id: "normal", label: "Normal", hint: "Equilibrado para voz hablada." },
  { id: "strong", label: "Fuerte", hint: "Para grabaciones con mucho ruido de fondo." },
];

const ENHANCED_SUFFIX = " (mejorado)";

/** The file the enhancement should start from: the original, even when the clip uses an enhanced copy. */
export function sourceAssetFor(asset: MediaAsset, assets: MediaAsset[]): MediaAsset {
  return (asset.enhancedFromId && assets.find((a) => a.id === asset.enhancedFromId)) || asset;
}

/** The media-bin entry for a processed copy of `original`. */
export function buildEnhancedAsset(original: MediaAsset, outputPath: string, metadata: { duration?: number; width?: number; height?: number }, size = 0): MediaAsset {
  const baseName = original.name.endsWith(ENHANCED_SUFFIX) ? original.name.slice(0, -ENHANCED_SUFFIX.length) : original.name;
  return {
    ...original,
    id: generateId("asset"),
    name: `${baseName}${ENHANCED_SUFFIX}`,
    path: outputPath,
    duration: metadata.duration && metadata.duration > 0 ? metadata.duration : original.duration,
    width: original.type === "video" && metadata.width ? metadata.width : original.width,
    height: original.type === "video" && metadata.height ? metadata.height : original.height,
    size: size || original.size,
    enhancedFromId: original.id,
  };
}

/** One undo step that points every clip using `fromId` at `toId`. Null when no clip uses it. */
export function buildMediaSwapCommand(clips: Clip[], fromId: string, toId: string, label: string): Command | null {
  const commands = clips.filter((c) => c.mediaId === fromId).map((c) => new UpdateClipCommand(c.id, { mediaId: fromId }, { mediaId: toId }));
  if (commands.length === 0) return null;
  return commands.length === 1 ? commands[0] : new CompositeCommand(label, commands);
}

/**
 * Enhances the audio of the asset a clip uses and switches the timeline to the processed copy.
 * Every clip that uses the same recording is switched, so split pieces of one take stay consistent.
 */
export async function enhanceClipAudio(clip: Clip, level: VoiceLevel): Promise<{ assetId: string }> {
  const { mediaAssets, addMediaAsset } = useProjectStore.getState();
  const current = mediaAssets.find((a) => a.id === clip.mediaId);
  if (!current || (current.type !== "audio" && current.type !== "video")) throw new Error("Este clip no tiene audio que mejorar.");

  const original = sourceAssetFor(current, mediaAssets);
  const outputPath = await invoke<string>("enhance_voice_audio", { inputPath: original.path, isVideo: original.type === "video", level });
  const metadata = await platform.getMediaMetadata(outputPath);
  const enhanced = buildEnhancedAsset(original, outputPath, metadata);
  addMediaAsset(enhanced);

  const added = useProjectStore.getState().mediaAssets.find((a) => a.path === outputPath) ?? enhanced;
  const swap = buildMediaSwapCommand(useTimelineStore.getState().clips, current.id, added.id, "Mejorar audio");
  if (swap) useHistoryStore.getState().execute(swap);
  return { assetId: added.id };
}

/** Puts the clips back on the original recording. The processed copy stays in the media bin. */
export function revertClipAudio(clip: Clip): boolean {
  const assets = useProjectStore.getState().mediaAssets;
  const current = assets.find((a) => a.id === clip.mediaId);
  const original = current?.enhancedFromId ? assets.find((a) => a.id === current.enhancedFromId) : undefined;
  if (!current || !original) return false;
  const swap = buildMediaSwapCommand(useTimelineStore.getState().clips, current.id, original.id, "Volver al audio original");
  if (swap) useHistoryStore.getState().execute(swap);
  return !!swap;
}
