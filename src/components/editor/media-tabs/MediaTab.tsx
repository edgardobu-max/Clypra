import React, { useState, useCallback, useMemo } from "react";
import { CloudUpload, Folder, FolderPlus, ChevronLeft } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";

import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ContextMenu } from "@/components/ui/ContextMenu";
import { useMediaImport } from "@/hooks/useMediaImport";
import { useFileDrop } from "@/hooks/useFileDrop";
import { useProjectStore } from "@/store/projectStore";
import { useUIStore } from "@/store/uiStore";
import { useTimelineStore } from "@/store/timelineStore";
import { useHistoryStore } from "@/store/historyStore";
import { DeleteClipCommand } from "@/core/history/commands/DeleteClipCommand";
import type { VideoMetadata } from "@/types";
import type { MediaTabProps } from "./types";
import { generateId } from "@/lib/id";
import { SuccessToast } from "@/components/ui/SuccessToast";
import { MediaCard } from "@/components/ui/MediaCard";

export const MediaTab: React.FC<MediaTabProps> = ({ onAddToTimeline }) => {
  const { mediaAssets, removeMediaAsset, addMediaAsset, project, createMediaFolder, renameMediaFolder, deleteMediaFolder, moveMediaToFolder } = useProjectStore();
  const { importMedia, isLoading, toastMessage, clearToast } = useMediaImport();
  // Note: previewMediaId is used for visual selection state only.
  // Preview rendering is now timeline-driven, not media-selection driven.
  const { setPreviewMedia, previewMediaId } = useUIStore();
  const { clips } = useTimelineStore();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; mediaId: string } | null>(null);

  // ── Folders ──
  const folders = project?.mediaFolders ?? [];
  const folderIds = useMemo(() => new Set(folders.map((f) => f.id)), [folders]);
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; folderId: string } | null>(null);
  const [folderEditor, setFolderEditor] = useState<{ mode: "create" } | { mode: "rename"; folderId: string } | null>(null);
  const [folderName, setFolderName] = useState("");
  const openFolder = folders.find((f) => f.id === openFolderId) ?? null;
  const effectiveFolderOf = (a: { folderId?: string | null }) => (a.folderId && folderIds.has(a.folderId) ? a.folderId : null);
  const visibleAssets = mediaAssets.filter((a) => effectiveFolderOf(a) === (openFolder?.id ?? null));
  const countIn = (folderId: string) => mediaAssets.filter((a) => a.folderId === folderId).length;

  const submitFolderEditor = () => {
    if (!folderEditor) return;
    if (folderEditor.mode === "create") createMediaFolder(folderName);
    else renameMediaFolder(folderEditor.folderId, folderName);
    setFolderEditor(null);
    setFolderName("");
  };

  // Media imported while a folder is open lands in that folder.
  const importIntoCurrentFolder = async () => {
    const before = new Set(useProjectStore.getState().mediaAssets.map((a) => a.id));
    await importMedia();
    if (!openFolder) return;
    for (const a of useProjectStore.getState().mediaAssets) {
      if (!before.has(a.id)) moveMediaToFolder(a.id, openFolder.id);
    }
  };

  // Track which media assets are used in the timeline
  const usedMediaIds = useMemo(() => {
    return new Set(clips.map((clip) => clip.mediaId));
  }, [clips]);

  const getMediaType = (path: string): "video" | "audio" | "image" => {
    const lower = path.toLowerCase();
    if (/\.(mp4|mov|avi|mkv|webm|flv)$/i.test(lower)) return "video";
    if (/\.(mp3|wav|aac|flac|m4a)$/i.test(lower)) return "audio";
    return "image";
  };

  const handleTauriFileDrop = useCallback(
    async (paths: string[]) => {
      for (const filePath of paths) {
        try {
          const filename = filePath.split("/").pop() || filePath.split("\\").pop() || "Unknown";
          const type = getMediaType(filename);

          // Check if asset already exists
          const existingAsset = mediaAssets.find((a) => a.path === filePath);
          if (existingAsset) {
            continue;
          }

          // Import new asset
          if (type === "video" || type === "audio") {
            const metadata: VideoMetadata = await invoke("get_video_metadata", { path: filePath });
            // Use extract_poster_frame_command which extracts at 10% of duration (avoids black frames at 0s)
            const posterFrame: string | undefined = type === "video" ? ((await invoke("extract_poster_frame_command", { videoPath: filePath, duration: metadata.duration, dpr: window.devicePixelRatio || 1.0 }).catch(() => undefined)) as string | undefined) : undefined;

            const asset = {
              id: generateId("asset"),
              name: filename,
              path: filePath,
              type,
              duration: metadata.duration,
              width: metadata.width,
              height: metadata.height,
              posterFrame,
              size: metadata.size,
              folderId: openFolderId,
            };

            addMediaAsset(asset);
          } else {
            const asset = {
              id: generateId("asset"),
              name: filename,
              path: filePath,
              type: "image" as const,
              duration: 0,
              size: 0,
              posterFrame: convertFileSrc(filePath),
              folderId: openFolderId,
            };

            addMediaAsset(asset);
          }
        } catch (error) {
          console.error(`[MediaTab] Failed to import ${filePath}:`, error);
          useProjectStore.getState().showToast(`Failed to import ${filePath.split("/").pop() || "file"}`, "error");
        }
      }
    },
    [mediaAssets, addMediaAsset, openFolderId],
  );

  // Use the file drop hook
  const { containerRef, isDraggingOver } = useFileDrop({
    onDrop: handleTauriFileDrop,
    enabled: true,
  });

  return (
    <div ref={containerRef} className={`flex-1 flex flex-col overflow-hidden transition-colors ${isDraggingOver ? "bg-surface-raised/10 transition-colors duration-300" : ""}`}>
      <div className="p-1 border-b border-border flex gap-1">
        <Button variant="secondary" size="sm" className="flex-1 border-dashed cursor-pointer" onClick={importIntoCurrentFolder} disabled={isLoading}>
          <CloudUpload className="w-4 h-4" />
          {isLoading ? "Importing..." : openFolder ? `Import into "${openFolder.name}"` : "Import Media"}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="cursor-pointer"
          onClick={() => {
            setFolderName("");
            setFolderEditor({ mode: "create" });
          }}
          aria-label="New folder"
          title="New folder"
        >
          <FolderPlus className="w-4 h-4" />
        </Button>
      </div>

      {folderEditor && (
        <form
          className="flex gap-1 border-b border-border p-1"
          onSubmit={(e) => {
            e.preventDefault();
            submitFolderEditor();
          }}
        >
          <input autoFocus value={folderName} onChange={(e) => setFolderName(e.target.value)} placeholder={folderEditor.mode === "create" ? "Folder name (e.g. Base)" : "New name"} maxLength={40} className="min-w-0 flex-1 rounded-md border border-border bg-surface-raised px-2 py-1 text-xs text-text-primary outline-none" aria-label="Folder name" />
          <Button type="submit" variant="default" size="sm" className="bg-accent text-white" disabled={!folderName.trim()}>
            {folderEditor.mode === "create" ? "Create" : "Rename"}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => setFolderEditor(null)}>
            Cancel
          </Button>
        </form>
      )}

      {openFolder && (
        <div className="flex items-center gap-1 border-b border-border px-2 py-1 text-xs">
          <button onClick={() => setOpenFolderId(null)} className="flex items-center gap-0.5 text-text-muted hover:text-text-primary cursor-pointer">
            <ChevronLeft className="w-3.5 h-3.5" /> All media
          </button>
          <span className="text-text-muted">/</span>
          <span className="font-semibold text-text-primary">{openFolder.name}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {mediaAssets.length === 0 && folders.length === 0 ? (
          <EmptyState icon={CloudUpload} title="No media imported" description="Import videos, audio, or images to get started" />
        ) : (
          <div className="grid grid-cols-2 gap-2 p-3">
            {!openFolder &&
              folders.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setOpenFolderId(f.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setFolderMenu({ x: e.clientX, y: e.clientY, folderId: f.id });
                  }}
                  className="flex aspect-video flex-col items-center justify-center gap-1 rounded-lg bg-surface-raised p-2 transition-colors hover:bg-surface-raised/70 cursor-pointer"
                >
                  <Folder className="w-10 h-10 text-yellow-500/90" fill="currentColor" />
                  <span className="max-w-full truncate text-xs font-medium text-text-primary">{f.name}</span>
                  <span className="text-[10px] text-text-muted">{countIn(f.id)} items</span>
                </button>
              ))}
            {openFolder && visibleAssets.length === 0 && <p className="col-span-2 py-6 text-center text-xs text-text-muted">This folder is empty. Import media here, or right-click a media item and choose "Move to folder".</p>}
            {visibleAssets.map((asset) => (
              <MediaCard
                key={asset.id}
                asset={asset}
                isSelected={previewMediaId === asset.id}
                isUsedInTimeline={usedMediaIds.has(asset.id)}
                onClick={() => setPreviewMedia(asset.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, mediaId: asset.id });
                }}
                onAddToTimeline={() => onAddToTimeline?.(asset, "media")}
              />
            ))}
          </div>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          items={[
            usedMediaIds.has(contextMenu.mediaId)
              ? {
                  label: "Remove from Timeline",
                  onClick: () => {
                    const { normalizeTrack, removeEmptyNonMainTracks, withBatch } = useTimelineStore.getState();
                    const { execute, beginTransaction, commitTransaction } = useHistoryStore.getState();
                    const affectedTracks = new Set<string>();

                    // Find all clips using this media asset
                    const clipsToRemove = clips.filter((c) => c.mediaId === contextMenu.mediaId);

                    // Use transaction to group all deletes into a single undo/redo unit
                    beginTransaction("Remove from Timeline");

                    // Remove all clips using this asset
                    clipsToRemove.forEach((clip) => {
                      affectedTracks.add(clip.trackId);
                      execute(new DeleteClipCommand(clip.id));
                    });

                    commitTransaction();

                    // Normalize affected tracks to close gaps (not part of undo/redo)
                    withBatch(() => {
                      affectedTracks.forEach((trackId) => normalizeTrack(trackId));
                      removeEmptyNonMainTracks(Array.from(affectedTracks));
                    });
                  },
                }
              : {
                  label: "Add to Track",
                  onClick: () => {
                    const asset = mediaAssets.find((a) => a.id === contextMenu.mediaId);
                    if (asset) onAddToTimeline?.(asset, "media");
                  },
                },
            ...folders
              .filter((f) => f.id !== mediaAssets.find((a) => a.id === contextMenu.mediaId)?.folderId)
              .map((f) => ({ label: `Move to "${f.name}"`, onClick: () => moveMediaToFolder(contextMenu.mediaId, f.id) })),
            ...(mediaAssets.find((a) => a.id === contextMenu.mediaId)?.folderId ? [{ label: "Move out of folder", onClick: () => moveMediaToFolder(contextMenu.mediaId, null) }] : []),
            { label: "Delete", onClick: () => removeMediaAsset(contextMenu.mediaId), danger: true },
          ]}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {folderMenu && (
        <ContextMenu
          items={[
            {
              label: "Rename folder",
              onClick: () => {
                setFolderName(folders.find((f) => f.id === folderMenu.folderId)?.name ?? "");
                setFolderEditor({ mode: "rename", folderId: folderMenu.folderId });
              },
            },
            {
              label: "Delete folder (keeps its media)",
              onClick: () => {
                if (openFolderId === folderMenu.folderId) setOpenFolderId(null);
                deleteMediaFolder(folderMenu.folderId);
              },
              danger: true,
            },
          ]}
          position={{ x: folderMenu.x, y: folderMenu.y }}
          onClose={() => setFolderMenu(null)}
        />
      )}

      <SuccessToast message={toastMessage?.message ?? null} variant={toastMessage?.type ?? "success"} onDismiss={clearToast} />
    </div>
  );
};
