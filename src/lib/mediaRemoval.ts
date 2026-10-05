import { useProjectStore } from "@/store/projectStore";
import { useTimelineStore } from "@/store/timelineStore";
import { useUIStore } from "@/store/uiStore";
import { useHistoryStore } from "@/store/historyStore";
import { DeleteClipCommand } from "@/core/history/commands/DeleteClipCommand";

export interface MediaRemovalResult {
  /** Assets taken out of the media bin. */
  assets: number;
  /** Timeline clips that used them and were removed too. */
  clips: number;
}

/**
 * Deletes media from the project the way an editor should: the clips that use it leave the
 * timeline too (one undo step), the source monitor stops showing it, and selections that
 * pointed at the removed items are cleared. Removing only the bin entry used to leave "ghost"
 * clips on the tracks and the deleted media still showing in the viewer.
 */
export function removeMediaFromProject(assetIds: string[]): MediaRemovalResult {
  const ids = new Set(assetIds);
  if (ids.size === 0) return { assets: 0, clips: 0 };

  const timeline = useTimelineStore.getState();
  const clipsToRemove = timeline.clips.filter((c) => ids.has(c.mediaId));

  if (clipsToRemove.length > 0) {
    const { execute, beginTransaction, commitTransaction } = useHistoryStore.getState();
    const affectedTracks = new Set<string>();

    beginTransaction("Remove media from project");
    for (const clip of clipsToRemove) {
      affectedTracks.add(clip.trackId);
      execute(new DeleteClipCommand(clip.id));
    }
    commitTransaction();

    // Close the gaps and drop tracks left empty (not part of undo/redo, same as a manual delete).
    const { normalizeTrack, removeEmptyNonMainTracks, withBatch } = useTimelineStore.getState();
    withBatch(() => {
      affectedTracks.forEach((trackId) => normalizeTrack(trackId));
      removeEmptyNonMainTracks(Array.from(affectedTracks));
    });
  }

  useProjectStore.getState().removeMediaAssets(assetIds);

  const ui = useUIStore.getState();
  if (ui.previewMediaId && ids.has(ui.previewMediaId)) {
    ui.setPreviewMedia(null);
    if (ui.previewMode === "source") ui.exitSourceMode();
  }
  const removedClipIds = new Set(clipsToRemove.map((c) => c.id));
  if (ui.selectedClipIds.some((id) => removedClipIds.has(id))) {
    useUIStore.setState({ selectedClipIds: ui.selectedClipIds.filter((id) => !removedClipIds.has(id)) });
  }

  return { assets: ids.size, clips: clipsToRemove.length };
}
