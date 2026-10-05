import React from "react";
// @ts-ignore - react-dnd types issue
import { useDrop } from "react-dnd";
import { Folder, ChevronLeft } from "lucide-react";

/** Ids carried by a dragged media card (the whole selection when the card was part of it). */
function draggedAssetIds(item: any): string[] {
  if (Array.isArray(item?.assetIds) && item.assetIds.length > 0) return item.assetIds;
  return item?.asset?.id ? [item.asset.id] : [];
}

interface MediaFolderCardProps {
  name: string;
  count: number;
  onOpen: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  /** Called with the dragged media ids when they are dropped on this folder. */
  onDropAssets: (assetIds: string[]) => void;
}

/** A folder tile in the media bin; media dragged onto it are moved inside. */
export const MediaFolderCard: React.FC<MediaFolderCardProps> = ({ name, count, onOpen, onContextMenu, onDropAssets }) => {
  const [{ isOver, canDrop }, drop] = useDrop(
    () => ({
      accept: "MEDIA_ASSET",
      drop: (item: any) => onDropAssets(draggedAssetIds(item)),
      collect: (monitor: any) => ({ isOver: monitor.isOver(), canDrop: monitor.canDrop() }),
    }),
    [onDropAssets],
  );

  return (
    <button
      ref={drop as unknown as React.Ref<HTMLButtonElement>}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      aria-label={`Folder ${name}`}
      className={`flex aspect-video flex-col items-center justify-center gap-1 rounded-lg p-2 transition-colors cursor-pointer ${isOver && canDrop ? "bg-accent/25 ring-2 ring-accent" : "bg-surface-raised hover:bg-surface-raised/70"}`}
    >
      <Folder className="w-10 h-10 text-yellow-500/90" fill="currentColor" />
      <span className="max-w-full truncate text-xs font-medium text-text-primary">{name}</span>
      <span className="text-[10px] text-text-muted">{isOver && canDrop ? "Drop to move here" : `${count} items`}</span>
    </button>
  );
};

interface MediaRootDropProps {
  onOpen: () => void;
  onDropAssets: (assetIds: string[]) => void;
}

/** The "All media" breadcrumb: dropping media on it moves them out of the open folder. */
export const MediaRootDrop: React.FC<MediaRootDropProps> = ({ onOpen, onDropAssets }) => {
  const [{ isOver, canDrop }, drop] = useDrop(
    () => ({
      accept: "MEDIA_ASSET",
      drop: (item: any) => onDropAssets(draggedAssetIds(item)),
      collect: (monitor: any) => ({ isOver: monitor.isOver(), canDrop: monitor.canDrop() }),
    }),
    [onDropAssets],
  );

  return (
    <button ref={drop as unknown as React.Ref<HTMLButtonElement>} onClick={onOpen} className={`flex items-center gap-0.5 rounded px-1 cursor-pointer ${isOver && canDrop ? "bg-accent/25 text-text-primary ring-1 ring-accent" : "text-text-muted hover:text-text-primary"}`}>
      <ChevronLeft className="w-3.5 h-3.5" /> All media
    </button>
  );
};
