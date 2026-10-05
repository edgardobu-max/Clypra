import React from "react";
import { platform } from "@/core/platform";

// @ts-ignore - react-dnd types issue
import { useDrag } from "react-dnd";
import { Film, Plus } from "lucide-react";

import { useUIStore } from "@/store/uiStore";
import { formatTime } from "@/lib/timeFormatting";
import { MediaCardWaveform } from "../editor/media-tabs/MediaCardWaveform";

// MediaCard Component
interface MediaCardProps {
  asset: any;
  isSelected: boolean;
  isUsedInTimeline: boolean;
  /** Receives the click so the bin can read Ctrl/Shift for multi-selection. */
  onClick: (e: React.MouseEvent) => void;
  /** Ids dragged with this card: the whole selection if the card is part of it, else just this one. */
  dragAssetIds?: string[];
  onContextMenu: (e: React.MouseEvent) => void;
  onAddToTimeline: () => void;
}

export const MediaCard: React.FC<MediaCardProps> = ({ asset, isSelected, isUsedInTimeline, onClick, dragAssetIds, onContextMenu, onAddToTimeline }) => {
  const { previewAsset } = useUIStore();

  const [{ isDragging }, drag] = useDrag(
    () => ({
      type: "MEDIA_ASSET",
      item: { type: "MEDIA_ASSET", asset, assetIds: dragAssetIds && dragAssetIds.length > 0 ? dragAssetIds : [asset.id] },
      collect: (monitor: any) => ({
        isDragging: monitor.isDragging(),
      }),
    }),
    [asset, dragAssetIds],
  );

  const handleClick = (e: React.MouseEvent) => {
    onClick(e); // Keep selection state
    // Ctrl/Cmd/Shift clicks only build a selection; they must not swap the source monitor.
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    previewAsset(asset); // Switch to source preview

    // Switch transport authority to source context
    import("@/core/runtime/ProjectSession").then(({ getActiveSessionOrNull }) => {
      const session = getActiveSessionOrNull();
      session?.transportAuthority?.setActiveContext("source");
    });
  };

  return (
    <div ref={drag as unknown as React.Ref<HTMLDivElement>} onClick={handleClick} onContextMenu={onContextMenu} className={`group relative bg-surface-raised rounded overflow-hidden transition-all cursor-pointer ${isDragging ? "opacity-50" : ""} ${isSelected ? "ring-1 ring-accent" : ""}`}>
      <div className="aspect-video bg-surface-raised flex items-center justify-center relative">
        {asset.type === "video" && asset.posterFrame && !/\.(mp4|mov|avi|mkv|webm|flv)(%|$)/i.test(asset.posterFrame) ? (
          <img src={asset.posterFrame} alt={asset.name} className="w-full h-full object-contain" />
        ) : asset.type === "audio" ? (
          <MediaCardWaveform audioPath={asset.path.startsWith("asset://") ? asset.path : platform.convertFileSrc(asset.path)} duration={asset.duration} className="w-full h-full" />
        ) : asset.type === "image" ? (
          <img src={asset.path.startsWith("asset://") ? asset.path : platform.convertFileSrc(asset.path)} alt={asset.name} className="w-full h-full object-contain" />
        ) : (
          <div className="w-8 h-8">
            <Film className="w-full h-full text-text-muted" />
          </div>
        )}
        {asset.duration > 0 && <div className="absolute bottom-1 right-1 bg-black/70 px-1.5 py-0.5 rounded text-[10px] text-white">{formatTime(asset.duration)}</div>}
        {/* "Added" badge */}
        {isUsedInTimeline && (
          <div className="absolute top-1 left-1 bg-purple-950/80 px-1 py-px rounded-[2px] text-[8px] text-white flex items-center gap-1">
            <span>Added</span>
          </div>
        )}
      </div>
      <div className="px-1 py-0.5">
        <p className="text-[10px] font-medium text-text-primary truncate">{asset.name}</p>
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onAddToTimeline();
        }}
        title="Add to Track"
        className="hidden cursor-pointer group-hover:flex bg-accent hover:bg-accent/90 w-5 h-5 rounded-full justify-center items-center absolute top-1 right-1 transition-colors"
      >
        <Plus size={14} className="text-white" />
      </button>
    </div>
  );
};
